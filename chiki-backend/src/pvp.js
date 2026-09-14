/* ============================================================================
 * pvp.js — live Chikiseum duels.
 *
 * Server-authoritative: clients submit card INDICES only, the server draws the
 * hands, resolves the turn and hands back a replay sequence. A client that lies
 * about its hand gets its submission clamped (engine.sanitizeQueue) rather than
 * trusted, and a client that never submits gets auto-played on the deadline.
 *
 * Wagers ride on top: both sides post a ✨ Glory stake, it sits in escrow for
 * the duration of the match, and the winner takes the pot minus a small rake.
 * ========================================================================== */

'use strict';

const engine = require('./engine');
const profiles = require('./profiles');
const store = require('./store');

/* ---- timings ---- */
const TURN_MS = 60000;          /* matches the client's TURN_SECONDS */
const BREAK_MS = 6000;          /* pause between games of a series */
const LOBBY_TTL = 12000;        /* drop a Trainer from the lobby if they stop polling */
const CHALLENGE_TTL = 30000;
const HANDOFF_TTL = 60000;      /* how long a "you got matched" notice waits to be picked up */
const JOIN_GRACE_MS = 60000;    /* the client plays an intro video before its first poll */
const IDLE_FORFEIT_MS = 35000;
const MATCH_KEEP_MS = 120000;   /* keep a finished match around so both sides can read the result */

/* ---- wagers ---- */
const WAGER_TIERS = [0, 25, 50, 100, 250, 500];
const WAGER_RAKE_BP = 500;      /* 5% of the losing stake — funds the Chikoria Cup pool */

const lobby = new Map();        /* wallet -> presence row */
const challenges = new Map();   /* id -> pending challenge */
const matches = new Map();      /* matchId -> match */
const walletMatch = new Map();  /* wallet -> matchId (only while live) */
const handoff = new Map();      /* wallet -> {matchId, side, ts} */

let seq = 0;
const nextId = prefix => prefix + (++seq).toString(36) + Date.now().toString(36).slice(-4);

const now = () => Date.now();
const clampWager = n => {
  const v = Math.max(0, Math.round(Number(n) || 0));
  /* snap to the nearest tier at or below the request */
  let best = 0;
  for (const t of WAGER_TIERS) if (t <= v) best = t;
  return best;
};

/* ------------------------------------------------------------------ lobby */

function touchLobby(wallet, name, snap, searching, wager) {
  if (!wallet) return null;
  const row = lobby.get(wallet) || { wallet };
  row.name = String(name || 'Trainer').slice(0, 28);
  row.snap = snap ? engine.normalizeSnap(snap) : row.snap;
  row.searching = !!searching;
  row.wager = clampWager(wager != null ? wager : row.wager);
  row.lastSeen = now();
  lobby.set(wallet, row);
  return row;
}

function sweepLobby() {
  const t = now();
  for (const [w, r] of lobby) if (t - r.lastSeen > LOBBY_TTL) lobby.delete(w);
  for (const [id, c] of challenges) if (t - c.ts > CHALLENGE_TTL) challenges.delete(id);
  for (const [w, h] of handoff) if (t - h.ts > HANDOFF_TTL) handoff.delete(w);
}

/* The stake two Trainers actually agree on: the lower of the two asks, capped
   by what each can really cover. Nobody is ever staked beyond their means. */
function agreedStake(aWallet, bWallet, aWant, bWant) {
  let stake = Math.min(clampWager(aWant), clampWager(bWant));
  if (!stake) return 0;
  const a = profiles.get(aWallet), b = profiles.get(bWallet);
  stake = Math.min(stake, profiles.spendable(a), profiles.spendable(b));
  return clampWager(stake);
}

/* ---------------------------------------------------------------- matches */

function createMatch(aWallet, aSnap, bWallet, bSnap, opts) {
  opts = opts || {};
  const id = nextId('m');
  const stake = opts.cup ? 0 : agreedStake(aWallet, bWallet, opts.aWager, opts.bWager);

  /* Escrow both stakes up front. If either lock fails we fall back to a friendly
     (zero-stake) duel rather than refusing the match outright. */
  let locked = 0;
  if (stake > 0) {
    if (profiles.lock(aWallet, stake)) locked++;
    if (profiles.lock(bWallet, stake)) locked++;
    if (locked < 2) {
      if (locked) { profiles.release(aWallet, stake); profiles.release(bWallet, stake); }
    }
  }
  const finalStake = locked === 2 ? stake : 0;

  const m = {
    id,
    a: engine.makeSide(aWallet, aSnap),
    b: engine.makeSide(bWallet, bSnap),
    bestOf: opts.bestOf || 3,
    game: 1,
    score: { a: 0, b: 0 },
    turn: 0,
    first: 'a',
    phase: 'plan',
    deadline: 0,
    breakUntil: 0,
    submitted: { a: null, b: null },
    lastTurn: null,
    gameResult: null,
    over: false,
    winner: null,
    reason: null,
    wager: { stake: finalStake, rakeBp: WAGER_RAKE_BP, settled: false, payout: 0 },
    cup: !!opts.cup,
    cupTag: opts.cupTag || null,
    bot: { a: false, b: !!opts.bBot },
    seen: { a: now(), b: now() },
    createdAt: now(),
    finishedAt: 0
  };
  matches.set(id, m);
  walletMatch.set(aWallet, id);
  if (bWallet) walletMatch.set(bWallet, id);
  engine.beginRound(m.a, m.b);
  m.turn = 1;
  m.deadline = now() + TURN_MS;
  store.data().totals.pvpMatches = (store.data().totals.pvpMatches || 0) + 1;
  store.save();
  return m;
}

const sideOf = (m, wallet) => (m.a.wallet === wallet ? 'a' : m.b.wallet === wallet ? 'b' : null);

function notifyMatched(wallet, matchId, side) {
  handoff.set(wallet, { matchId, side, ts: now() });
  const row = lobby.get(wallet);
  if (row) row.searching = false;
}

function pairUp(aRow, bRow) {
  const m = createMatch(aRow.wallet, aRow.snap, bRow.wallet, bRow.snap, {
    aWager: aRow.wager, bWager: bRow.wager
  });
  notifyMatched(aRow.wallet, m.id, 'a');
  notifyMatched(bRow.wallet, m.id, 'b');
  return m;
}

/* Pair any two Trainers who are both searching and not already in a match. */
function autoMatch() {
  const pool = [...lobby.values()]
    .filter(r => r.searching && r.snap && !walletMatch.has(r.wallet) && !handoff.has(r.wallet))
    .sort((x, y) => x.lastSeen - y.lastSeen);
  while (pool.length >= 2) {
    const a = pool.shift();
    /* prefer the closest Battle Rank so fights stay competitive */
    let bi = 0, best = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const d = Math.abs((pool[i].snap.br || 1) - (a.snap.br || 1));
      if (d < best) { best = d; bi = i; }
    }
    const b = pool.splice(bi, 1)[0];
    pairUp(a, b);
  }
}

/* ------------------------------------------------------------- turn cycle */

function finishGame(m, winnerSide) {
  m.score[winnerSide]++;
  m.gameResult = { game: m.game, winner: winnerSide };
  const need = Math.ceil(m.bestOf / 2);
  if (m.score[winnerSide] >= need) { finishMatch(m, winnerSide, 'ko'); return; }
  m.phase = 'between';
  m.breakUntil = now() + BREAK_MS;
  m.submitted = { a: null, b: null };
}

function nextGame(m) {
  m.game++;
  engine.resetSide(m.a);
  engine.resetSide(m.b);
  m.turn = 0;
  m.first = 'a';
  m.phase = 'plan';
  m.lastTurn = null;
  m.submitted = { a: null, b: null };
  engine.beginRound(m.a, m.b);
  m.turn = 1;
  m.deadline = now() + TURN_MS;
}

function finishMatch(m, winnerSide, reason) {
  if (m.over) return;
  m.over = true;
  m.phase = 'over';
  m.winner = winnerSide;
  m.reason = reason || 'ko';
  m.finishedAt = now();
  m.deadline = 0;

  const win = m[winnerSide], lose = m[winnerSide === 'a' ? 'b' : 'a'];
  const stake = m.wager.stake;

  /* Base reward mirrors the AI ladder: 6 + 2 x opponent BR. */
  const baseGlory = Math.round(6 + (lose.br || 1) * 2);

  if (!m.cup) {
    if (stake > 0 && !m.wager.settled && win.wallet && lose.wallet) {
      const res = profiles.settleWager(win.wallet, lose.wallet, stake, m.wager.rakeBp);
      m.wager.settled = true;
      m.wager.payout = res.won;
      m.wager.rake = res.rake;
    } else if (stake > 0) {
      profiles.release(win.wallet, stake);
      profiles.release(lose.wallet, stake);
      m.wager.settled = true;
    }
    if (win.wallet && !m.bot[winnerSide]) profiles.recordResult(win.wallet, true, baseGlory);
    if (lose.wallet && !m.bot[winnerSide === 'a' ? 'b' : 'a']) profiles.recordResult(lose.wallet, false, 0);

    profiles.pushFeed({
      type: 'pvp',
      winner: win.handle || win.name,
      loser: lose.handle || lose.name,
      glory: baseGlory,
      stake,
      reason: m.reason
    });
  }
  m.baseGlory = baseGlory;

  walletMatch.delete(m.a.wallet);
  walletMatch.delete(m.b.wallet);
}

function resolveIfReady(m) {
  const aq = m.submitted.a, bq = m.submitted.b;
  if (aq == null || bq == null) return false;
  const seqSteps = engine.resolveTurn(m.a, m.b, aq, bq, m.first);
  m.lastTurn = { turn: m.turn, seq: seqSteps, first: m.first };
  m.first = m.first === 'a' ? 'b' : 'a';
  m.submitted = { a: null, b: null };

  const aDead = engine.isDead(m.a), bDead = engine.isDead(m.b);
  if (aDead || bDead) {
    /* both down in the same exchange → whoever has more HP left takes it */
    let winner;
    if (aDead && bDead) winner = m.a.hp >= m.b.hp ? 'a' : 'b';
    else winner = aDead ? 'b' : 'a';
    finishGame(m, winner);
    return true;
  }
  engine.beginRound(m.a, m.b);
  m.turn++;
  m.deadline = now() + TURN_MS;
  return true;
}

/* Drive every live match forward. Called on a short interval. */
function tick() {
  sweepLobby();
  autoMatch();
  const t = now();

  for (const [id, m] of matches) {
    if (m.over) {
      if (t - m.finishedAt > MATCH_KEEP_MS) matches.delete(id);
      continue;
    }

    /* A player who stops polling forfeits — but only after they've had time to
       load in (the client plays a battle intro before its first /pvp/state). */
    for (const s of ['a', 'b']) {
      if (m.bot[s]) continue;
      const other = s === 'a' ? 'b' : 'a';
      const idleSince = Math.max(m.seen[s], m.createdAt + JOIN_GRACE_MS);
      if (t - idleSince > IDLE_FORFEIT_MS) { finishMatch(m, other, 'forfeit'); break; }
    }
    if (m.over) continue;

    if (m.phase === 'between') {
      if (t >= m.breakUntil) nextGame(m);
      continue;
    }

    /* bots plan the moment the humans do */
    for (const s of ['a', 'b']) {
      if (m.bot[s] && m.submitted[s] == null) m.submitted[s] = engine.autoPlan(m[s]);
    }

    if (m.submitted.a != null && m.submitted.b != null) { resolveIfReady(m); continue; }

    if (t >= m.deadline) {
      /* deadline hit — auto-play whoever went idle, exactly as the help text promises */
      for (const s of ['a', 'b']) if (m.submitted[s] == null) m.submitted[s] = engine.autoPlan(m[s]);
      resolveIfReady(m);
    }
  }
}

/* -------------------------------------------------------------- API calls */

function lobbyView(wallet) {
  const me = lobby.get(wallet);
  const hand = handoff.get(wallet);
  if (hand) {
    handoff.delete(wallet);
    return { matched: { matchId: hand.matchId, side: hand.side } };
  }
  const p = profiles.get(wallet);
  const players = [...lobby.values()]
    .filter(r => r.wallet !== wallet && !walletMatch.has(r.wallet))
    .slice(0, 24)
    .map(r => ({
      wallet: r.wallet,
      name: r.name,
      searching: !!r.searching,
      wager: r.wager || 0,
      br: (r.snap && r.snap.br) || 1,
      element: (r.snap && r.snap.element) || 'Fire',
      legend: (r.snap && r.snap.name) || null
    }));
  const mine = [...challenges.values()]
    .filter(c => c.to === wallet)
    .map(c => ({ id: c.id, fromName: c.fromName, from: c.from, wager: c.wager || 0, br: c.snap ? c.snap.br : 1 }));
  return {
    players,
    challenges: mine,
    you: {
      glory: p ? p.glory : 0,
      spendable: p ? profiles.spendable(p) : 0,
      escrow: p ? p.escrow : 0,
      wager: me ? me.wager || 0 : 0,
      wins: p ? p.pvpWins || 0 : 0,
      losses: p ? p.pvpLosses || 0 : 0,
      streak: p ? p.pvpStreak || 0 : 0
    },
    tiers: WAGER_TIERS,
    rakeBp: WAGER_RAKE_BP,
    online: lobby.size
  };
}

function available(body) {
  const wallet = body.wallet;
  if (!wallet) return { error: 'wallet required' };
  touchLobby(wallet, body.name, body.snap, body.searching, body.wager);
  autoMatch();
  return lobbyView(wallet);
}

/* Legacy queue endpoint the client falls back to when /pvp/available 404s. */
function queue(body) {
  const wallet = body.wallet;
  if (!wallet) return { error: 'wallet required' };
  touchLobby(wallet, (body.snap && body.snap.handle) || 'Trainer', body.snap, true, body.wager);
  autoMatch();
  const hand = handoff.get(wallet);
  if (hand) { handoff.delete(wallet); return { status: 'matched', matchId: hand.matchId, side: hand.side }; }
  const searchers = [...lobby.values()].filter(r => r.searching).length;
  return { status: 'queued', eligible: lobby.size, queued: searchers };
}

function cancel(body) {
  const wallet = body.wallet;
  const row = lobby.get(wallet);
  if (row) row.searching = false;
  for (const [id, c] of challenges) if (c.from === wallet) challenges.delete(id);
  return { ok: true };
}

function challenge(body) {
  const { from, to } = body;
  if (!from || !to) return { error: 'from and to required' };
  if (from === to) return { error: 'cannot challenge yourself' };
  if (walletMatch.has(to)) return { error: 'that Trainer is already in a battle' };
  const snap = engine.normalizeSnap(body.snap);
  const id = nextId('c');
  challenges.set(id, {
    id, from, to, snap,
    fromName: String(body.fromName || snap.handle || 'Trainer').slice(0, 28),
    wager: clampWager(body.wager),
    ts: now()
  });
  touchLobby(from, body.fromName, body.snap, false, body.wager);
  return { ok: true, id };
}

function acceptChallenge(body) {
  const { wallet, challengeId } = body;
  const c = challenges.get(challengeId);
  if (!c) return { error: 'challenge expired' };
  if (c.to !== wallet) return { error: 'not your challenge' };
  challenges.delete(challengeId);
  if (walletMatch.has(c.from)) return { error: 'that Trainer already started another battle' };
  const mySnap = engine.normalizeSnap(body.snap);
  const m = createMatch(c.from, c.snap, wallet, mySnap, { aWager: c.wager, bWager: body.wager != null ? body.wager : c.wager });
  notifyMatched(c.from, m.id, 'a');
  return { ok: true, matchId: m.id, side: 'b', stake: m.wager.stake };
}

function declineChallenge(body) {
  const c = challenges.get(body.challengeId);
  if (c && c.to === body.wallet) challenges.delete(body.challengeId);
  return { ok: true };
}

/* The per-player view of a match. Everything the client's applyPvpState reads. */
function state(matchId, wallet) {
  const m = matches.get(matchId);
  if (!m) return { error: 'match not found' };
  const side = sideOf(m, wallet);
  if (!side) return { error: 'not in this match' };
  const other = side === 'a' ? 'b' : 'a';
  m.seen[side] = now();

  const me = m[side], foe = m[other];
  const out = {
    matchId: m.id,
    side,
    you: {
      name: me.name,
      handle: me.handle,
      element: me.element,
      br: me.br,
      hp: Math.round(me.hp),
      maxhp: me.maxhp,
      shield: me.shield,
      energy: me.energy,
      hand: me.hand.map(slot => ({ slot, cost: engine.CARD_COST[slot], tier: engine.tierOf(me.cardTier, slot) }))
    },
    foe: {
      name: foe.name,
      handle: foe.handle,
      element: foe.element,
      br: foe.br,
      hp: Math.round(foe.hp),
      maxhp: foe.maxhp,
      shield: foe.shield,
      energy: foe.energy
    },
    turn: m.turn,
    deadlineInMs: m.phase === 'plan' ? Math.max(0, m.deadline - now()) : 0,
    youSubmitted: m.submitted[side] != null,
    foeSubmitted: m.submitted[other] != null,
    between: m.phase === 'between',
    breakInMs: m.phase === 'between' ? Math.max(0, m.breakUntil - now()) : 0,
    bestOf: m.bestOf,
    game: m.game,
    score: { you: m.score[side], foe: m.score[other] },
    lastTurn: m.lastTurn,
    wager: { stake: m.wager.stake, pot: m.wager.stake * 2, rakeBp: m.wager.rakeBp },
    cup: m.cup,
    over: m.over
  };
  if (m.gameResult) out.gameResult = { game: m.gameResult.game, youWonGame: m.gameResult.winner === side };
  if (m.over) {
    const won = m.winner === side;
    out.result = won ? 'win' : 'lose';
    out.reason = m.reason;
    const p = profiles.peek(wallet);
    out.gloryAfter = p ? Math.round(p.glory) : null;
    out.gloryDelta = won
      ? (m.baseGlory || 0) + (m.wager.payout || 0)
      : -(m.wager.stake || 0);
    out.stakeWon = won ? (m.wager.payout || 0) : 0;
    out.baseGlory = won ? (m.baseGlory || 0) : 0;
  }
  return out;
}

function move(body) {
  const m = matches.get(body.matchId);
  if (!m) return { error: 'match not found' };
  if (m.over) return { error: 'match is over' };
  const side = sideOf(m, body.wallet);
  if (!side) return { error: 'not in this match' };
  m.seen[side] = now();
  if (m.phase !== 'plan') return { error: 'not accepting moves right now' };
  if (m.submitted[side] != null) return { error: 'already locked in' };
  m.submitted[side] = engine.sanitizeQueue(m[side], body.cards);
  const resolved = m.submitted[(side === 'a' ? 'b' : 'a')] != null;
  if (resolved) resolveIfReady(m);
  return { ok: true, locked: true };
}

function forfeit(body) {
  const m = matches.get(body.matchId);
  if (!m || m.over) return { ok: true };
  const side = sideOf(m, body.wallet);
  if (!side) return { error: 'not in this match' };
  finishMatch(m, side === 'a' ? 'b' : 'a', 'forfeit');
  return { ok: true };
}

/* Public read-only view — anyone can watch, no wallet needed. */
function spectate(matchId) {
  const m = matches.get(matchId);
  if (!m) return { error: 'match not found' };
  const view = s => ({
    player: m[s].handle,
    name: m[s].name,
    element: m[s].element,
    br: m[s].br,
    hp: Math.max(0, Math.round(m[s].hp)),
    maxhp: m[s].maxhp,
    shield: m[s].shield
  });
  return {
    matchId: m.id,
    a: view('a'),
    b: view('b'),
    bestOf: m.bestOf,
    game: m.game,
    turn: m.turn,
    score: { a: m.score.a, b: m.score.b },
    between: m.phase === 'between',
    stake: m.wager.stake,
    over: m.over,
    winner: m.winner,
    reason: m.reason
  };
}

function liveMatches() {
  return [...matches.values()].map(m => ({
    matchId: m.id,
    a: m.a.handle || m.a.name,
    b: m.b.handle || m.b.name,
    aEl: m.a.element,
    bEl: m.b.element,
    stake: m.wager.stake,
    cup: m.cup,
    cupTag: m.cupTag,
    status: m.over ? 'finished' : 'live',
    winner: m.winner
  }));
}

const matchOf = wallet => walletMatch.get(wallet) || null;
const getMatch = id => matches.get(id) || null;

/* On boot nothing is in flight; refund any escrow a crash left behind. */
function recoverEscrow() {
  const db = store.data();
  let freed = 0;
  for (const p of Object.values(db.profiles)) {
    if (p.escrow) { freed += p.escrow; p.escrow = 0; }
  }
  if (freed) { store.save(); console.log('[pvp] released ' + freed + ' orphaned Glory from escrow'); }
}

module.exports = {
  WAGER_TIERS, WAGER_RAKE_BP, TURN_MS,
  tick, available, queue, cancel, challenge, acceptChallenge, declineChallenge,
  state, move, forfeit, spectate, liveMatches, createMatch, notifyMatched,
  matchOf, getMatch, recoverEscrow, lobbySize: () => lobby.size
};
