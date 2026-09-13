/* ============================================================================
 * cup.js — the Chikoria Cup: a double-elimination tournament whose matches are
 * real live PvP duels in the Chikiseum.
 *
 * Bracket shape is generic over the lobby size (8 / 10 / 16, padded to the next
 * power of two with byes) but the round KEYS are fixed to what play.html's
 * renderBracket expects: WB1..WB3, WF, LB1..LB5, LF, GF.
 * ========================================================================== */

'use strict';

const engine = require('./engine');
const pvp = require('./pvp');
const profiles = require('./profiles');
const store = require('./store');

const ENTRY_GLORY = Number(process.env.CUP_ENTRY_GLORY || 100);
const PRIZE_POOL_SOL = Number(process.env.CUP_PRIZE_SOL || 4);
const CHAT_MAX = 200;
const AUTO_START_ROUND_MS = 4000;   /* auto-run: pause between finalize and the next round */

const RNAME = {
  WB1: 'Winners · Round 1', WB2: 'Winners · Round 2', WB3: 'Winners · Semis', WF: 'Winners · Final',
  LB1: 'Losers · Round 1', LB2: 'Losers · Round 2', LB3: 'Losers · Round 3',
  LB4: 'Losers · Round 4', LB5: 'Losers · Round 5', LF: 'Losers · Final',
  GF: '🏆 GRAND FINAL'
};

/* Prize weights per lobby size — each table sums to the configured pool. */
const PRIZE_TABLE = {
  8: [1.0, 0.8, 0.6, 0.45, 0.3, 0.3, 0.275, 0.275],
  10: [1.0, 0.75, 0.55, 0.4, 0.3, 0.3, 0.2, 0.2, 0.15, 0.15],
  16: [1.0, 0.7, 0.5, 0.4, 0.25, 0.25, 0.2, 0.2, 0.1, 0.1, 0.1, 0.1, 0.025, 0.025, 0.025, 0.025]
};

let chat = [];
let autoTimer = 0;

const cup = () => store.data().cup;
const setCup = c => { store.data().cup = c; store.save(); };
const isAdmin = w => (process.env.ADMIN_WALLETS || 'CmY2ZXVPVG2gbAHeVWHw7PQrAKtTcrWsq2raaWgg8YJ9').split(',').map(s => s.trim()).includes(w);

const BOT_NAMES = ['Kazrik', 'Vellumor', 'Thornax', 'Sereia', 'Obsidra', 'Pyrrhus', 'Nimbex', 'Calder',
  'Zephyra', 'Umbrak', 'Solveig', 'Draeven', 'Mirelle', 'Okarath', 'Vantis', 'Lyrion'];

/* ------------------------------------------------------------ bracket math */

function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

/* Round keys for a bracket of `size` (a power of two). */
function roundKeys(size) {
  const k = Math.log2(size);                      /* number of winners rounds */
  const winners = [];
  for (let i = 1; i < k; i++) winners.push('WB' + i);
  winners.push('WF');
  const losersCount = 2 * (k - 1);
  const losers = [];
  for (let i = 1; i < losersCount; i++) losers.push('LB' + i);
  if (losersCount > 0) losers.push('LF');
  return { winners, losers, k };
}

const mk = (a, b) => ({ a: a || null, b: b || null, winner: null, forfeit: false, matchId: null, done: false });

/* Build the full empty bracket, seeding round 1 by Battle Rank (1 vs last, etc.). */
function buildBracket(entrants) {
  const size = nextPow2(Math.max(2, entrants.length));
  const seeded = entrants.slice().sort((x, y) => (y.br || 1) - (x.br || 1));
  while (seeded.length < size) seeded.push({ bye: true, player: 'BYE', name: 'BYE', wallet: null, br: 0 });

  const { winners, losers, k } = roundKeys(size);
  const rounds = {};

  /* WB1: standard 1-vs-N seeding so the top seeds meet late */
  const first = [];
  for (let i = 0; i < size / 2; i++) first.push(mk(seeded[i], seeded[size - 1 - i]));
  rounds[winners[0]] = { key: winners[0], title: RNAME[winners[0]], matches: first, state: 'soon' };
  for (let i = 1; i < winners.length; i++) {
    const n = size / Math.pow(2, i + 1);
    rounds[winners[i]] = { key: winners[i], title: RNAME[winners[i]], matches: Array.from({ length: n }, () => mk()), state: 'soon' };
  }

  /* Losers bracket alternates minor (LB winners pair up) and major (LB winners
     meet the freshly-dropped WB losers) rounds. */
  let lbSize = size / 4;   /* matches in LB1 */
  for (let i = 0; i < losers.length; i++) {
    const key = losers[i];
    const minor = i % 2 === 0;
    const n = minor ? lbSize : lbSize;
    rounds[key] = { key, title: RNAME[key] || key, matches: Array.from({ length: Math.max(1, n) }, () => mk()), state: 'soon' };
    if (!minor) lbSize = Math.max(1, Math.floor(lbSize / 2));
  }

  rounds.GF = { key: 'GF', title: RNAME.GF, matches: [mk()], state: 'soon' };

  return {
    size,
    cap: entrants.length,
    order: [...winners, ...losers, 'GF'],
    winners, losers, k,
    rounds,
    champion: null,
    /* per-round holding pens for players dropping out of the winners bracket */
    pending: {}
  };
}

const bracketRound = (bk, key) => bk.rounds[key];

/* Who plays in the next round after `key` resolves. */
function advance(bk, key) {
  const r = bracketRound(bk, key);
  const winners = r.matches.map(m => (m.winner === 'a' ? m.a : m.winner === 'b' ? m.b : null));
  const losers = r.matches.map(m => {
    if (m.winner == null) return null;
    const l = m.winner === 'a' ? m.b : m.a;
    return l && !l.bye ? l : null;
  }).filter(Boolean);

  const wi = bk.winners.indexOf(key);
  const li = bk.losers.indexOf(key);

  if (wi >= 0) {
    /* winners advance to the next winners round (or the grand final) */
    const nextKey = wi + 1 < bk.winners.length ? bk.winners[wi + 1] : 'GF';
    const nr = bracketRound(bk, nextKey);
    if (nextKey === 'GF') { nr.matches[0].a = winners[0]; }
    else for (let i = 0; i < nr.matches.length; i++) { nr.matches[i].a = winners[i * 2] || null; nr.matches[i].b = winners[i * 2 + 1] || null; }

    /* losers drop into the losers bracket */
    if (wi === 0) {
      const lr = bracketRound(bk, bk.losers[0]);
      for (let i = 0; i < lr.matches.length; i++) { lr.matches[i].a = losers[i * 2] || null; lr.matches[i].b = losers[i * 2 + 1] || null; }
    } else {
      /* WB round n>1 losers feed the "major" losers round: index 2*wi - 1 */
      const target = bk.losers[2 * wi - 1];
      if (target) bk.pending[target] = losers;
      else if (bk.losers.length) bk.pending[bk.losers[bk.losers.length - 1]] = losers;
    }
    return;
  }

  if (li >= 0) {
    const nextKey = li + 1 < bk.losers.length ? bk.losers[li + 1] : 'GF';
    const nr = bracketRound(bk, nextKey);
    if (nextKey === 'GF') { nr.matches[0].b = winners[0]; return; }
    const dropped = bk.pending[nextKey] || [];
    delete bk.pending[nextKey];
    if (dropped.length) {
      /* major round: LB survivors meet the WB drop-downs */
      for (let i = 0; i < nr.matches.length; i++) { nr.matches[i].a = winners[i] || null; nr.matches[i].b = dropped[i] || null; }
    } else {
      for (let i = 0; i < nr.matches.length; i++) { nr.matches[i].a = winners[i * 2] || null; nr.matches[i].b = winners[i * 2 + 1] || null; }
    }
  }
}

/* Auto-win any pairing where one side is a BYE or missing. */
function applyByes(bk, key) {
  const r = bracketRound(bk, key);
  for (const m of r.matches) {
    if (m.winner != null) continue;
    const aOk = m.a && !m.a.bye, bOk = m.b && !m.b.bye;
    if (aOk && !bOk) { m.winner = 'a'; m.done = true; }
    else if (!aOk && bOk) { m.winner = 'b'; m.done = true; }
    else if (!aOk && !bOk) { m.done = true; }
  }
}

const roundLive = r => r.matches.some(m => !m.done && m.a && m.b && !m.a.bye && !m.b.bye);

/* ------------------------------------------------------------ tournament */

function create(wallet, cap) {
  if (!isAdmin(wallet)) return { error: 'admin only' };
  const size = [8, 10, 16].includes(cap | 0) ? cap | 0 : 10;
  setCup({
    id: 'cup' + Date.now().toString(36),
    status: 'registration',
    cap: size,
    public: false,
    auto: false,
    entryGlory: ENTRY_GLORY,
    entrants: [],
    ready: [],
    bracket: null,
    round: null,
    roundBattling: false,
    eliminated: [],       /* wallets in elimination order (first out = last place) */
    results: null,
    champion: null,
    createdAt: Date.now()
  });
  chat = [];
  return { ok: true, cap: size };
}

function resize(wallet, cap) {
  if (!isAdmin(wallet)) return { error: 'admin only' };
  const c = cup();
  if (!c) return { error: 'no cup' };
  if (c.status !== 'registration') return { error: 'can only resize during registration' };
  const size = [8, 10, 16].includes(cap | 0) ? cap | 0 : c.cap;
  if (c.entrants.length > size) return { error: 'already ' + c.entrants.length + ' registered' };
  c.cap = size;
  store.save();
  return { ok: true, cap: size };
}

function register(wallet, snap) {
  const c = cup();
  if (!c) return { error: 'no cup running' };
  if (c.status !== 'registration') return { error: 'registration is closed' };
  if (!c.public && !isAdmin(wallet)) return { error: 'not open to the public yet' };
  if (c.entrants.some(e => e.wallet === wallet)) return { error: 'already registered' };
  if (c.entrants.length >= c.cap) return { error: 'the lobby is full' };
  if (profiles.isBanned(wallet)) return { error: 'this wallet cannot enter' };

  const sn = engine.normalizeSnap(snap);
  const p = profiles.get(wallet);
  const cost = c.entryGlory || 0;
  if (profiles.spendable(p) < cost) return { error: 'need ' + cost + ' Glory to enter (you have ' + profiles.spendable(p) + ')' };
  if (cost) profiles.addGlory(wallet, -cost);

  c.entrants.push({
    wallet,
    player: p.handle || sn.handle,
    name: sn.name,
    element: sn.element,
    br: sn.br,
    snap: sn,
    bot: false
  });
  store.save();
  pushChat({ wallet: null, name: 'Chikiseum', text: (p.handle || sn.handle) + ' entered the Cup! (' + c.entrants.length + '/' + c.cap + ')', sys: true });
  return { ok: true, gloryLeft: profiles.get(wallet).glory };
}

function fill(wallet) {
  if (!isAdmin(wallet)) return { error: 'admin only' };
  const c = cup();
  if (!c || c.status !== 'registration') return { error: 'registration is not open' };
  let added = 0;
  while (c.entrants.length < c.cap) {
    const i = c.entrants.length;
    const nm = BOT_NAMES[i % BOT_NAMES.length];
    const el = engine.ELEMENTS[i % engine.ELEMENTS.length];
    const br = 8 + ((i * 3) % 14);
    const skills = engine.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).slice(0, 3 + (i % 3)).sort((a, b) => a - b);
    const tiers = {};
    for (const s of skills) tiers[s] = Math.min(5, 1 + Math.floor(br / 7));
    c.entrants.push({
      wallet: 'bot:' + nm.toLowerCase(),
      player: nm,
      name: nm,
      element: el,
      br,
      snap: engine.normalizeSnap({ name: nm, handle: nm, element: el, br, arenaSkills: skills, cardTier: tiers }),
      bot: true
    });
    added++;
  }
  store.save();
  return { ok: true, added, entrants: c.entrants.map(publicEntrant), cap: c.cap };
}

function start(wallet) {
  if (!isAdmin(wallet)) return { error: 'admin only' };
  const c = cup();
  if (!c || c.status !== 'registration') return { error: 'no open registration' };
  if (c.entrants.length < 2) return { error: 'need at least 2 entrants' };
  c.bracket = buildBracket(c.entrants.map(publicEntrant));
  c.status = 'live';
  c.round = c.bracket.order[0];
  c.roundBattling = false;
  applyByes(c.bracket, c.round);
  store.save();
  pushChat({ wallet: null, name: 'Chikiseum', text: '⚔️ The Cup has begun — ' + RNAME[c.round] + '!', sys: true });
  return { ok: true, round: c.round };
}

const publicEntrant = e => ({ wallet: e.wallet, player: e.player, name: e.name, element: e.element, br: e.br, bot: !!e.bot, snap: e.snap });

const entrantOf = (c, wallet) => c.entrants.find(e => e.wallet === wallet) || null;

/* Kick off live PvP duels for every open pairing in the current round. */
function startRound(wallet, viaAuto) {
  const c = cup();
  if (!c) return { error: 'no cup' };
  if (!viaAuto && !isAdmin(wallet)) return { error: 'admin only' };
  if (c.status !== 'live') return { error: 'cup is not live' };
  if (c.roundBattling) return { error: 'round already live' };

  const bk = c.bracket, r = bracketRound(bk, c.round);
  applyByes(bk, c.round);
  let live = 0;
  for (const m of r.matches) {
    if (m.done || m.winner != null) continue;
    if (!m.a || !m.b || m.a.bye || m.b.bye) continue;
    const ea = entrantOf(c, m.a.wallet), eb = entrantOf(c, m.b.wallet);
    const match = pvp.createMatch(m.a.wallet, (ea && ea.snap) || m.a.snap, m.b.wallet, (eb && eb.snap) || m.b.snap, {
      cup: true, cupTag: c.round, bBot: !!(eb && eb.bot), aBot: !!(ea && ea.bot)
    });
    /* a bot on side A still needs auto-play */
    if (ea && ea.bot) match.bot.a = true;
    m.matchId = match.id;
    live++;
  }
  r.state = 'live';
  c.roundBattling = true;
  store.save();
  return { ok: true, liveMatches: live, round: c.round };
}

/* Read the PvP results back into the bracket and move everyone along. */
function finalizeRound(wallet, viaAuto, force) {
  const c = cup();
  if (!c) return { error: 'no cup' };
  if (!viaAuto && !isAdmin(wallet)) return { error: 'admin only' };
  if (c.status !== 'live') return { error: 'cup is not live' };

  const bk = c.bracket, r = bracketRound(bk, c.round);
  for (const m of r.matches) {
    if (m.winner != null) { m.done = true; continue; }
    if (!m.a || !m.b || m.a.bye || m.b.bye) { applyByes(bk, c.round); continue; }
    const pm = m.matchId ? pvp.getMatch(m.matchId) : null;
    if (pm && pm.over) {
      m.winner = pm.winner;
      m.forfeit = pm.reason === 'forfeit';
      m.done = true;
    } else if (force) {
      /* Auto-resolve: simulate the rest of the duel rather than leaving it hanging. */
      m.winner = simulate(m.a, m.b, c);
      m.done = true;
    } else {
      return { error: 'matches still in progress — wait or use Auto-resolve' };
    }
  }

  /* everyone who just took their second loss is out */
  for (const m of r.matches) {
    if (m.winner == null) continue;
    const loser = m.winner === 'a' ? m.b : m.a;
    if (!loser || loser.bye) continue;
    const isLosersSide = bk.losers.includes(c.round) || c.round === 'GF';
    if (isLosersSide && !c.eliminated.includes(loser.wallet)) c.eliminated.push(loser.wallet);
  }

  r.state = 'done';
  c.roundBattling = false;

  if (c.round === 'GF') {
    const gm = r.matches[0];
    const champ = gm.winner === 'a' ? gm.a : gm.b;
    bk.champion = champ;
    c.champion = champ ? (champ.player || champ.name) : null;
    c.status = 'finished';
    payout(c);
    store.save();
    pushChat({ wallet: null, name: 'Chikiseum', text: '🏆 ' + c.champion + ' is the Chikoria Cup Champion!', sys: true });
    return { ok: true, result: { finished: true, champion: c.champion } };
  }

  advance(bk, c.round);
  const idx = bk.order.indexOf(c.round);
  let next = null;
  for (let i = idx + 1; i < bk.order.length; i++) {
    const key = bk.order[i];
    applyByes(bk, key);
    if (roundLive(bracketRound(bk, key)) || key === 'GF') { next = key; break; }
    bracketRound(bk, key).state = 'done';
    advance(bk, key);
  }
  c.round = next || 'GF';
  store.save();
  return { ok: true, result: { finished: false, round: bk.order[idx], next: c.round } };
}

const resolveRound = wallet => {
  const c = cup();
  if (!c) return { error: 'no cup' };
  if (!isAdmin(wallet)) return { error: 'admin only' };
  if (!c.roundBattling) { const s = startRound(wallet, true); if (s.error) return s; }
  return finalizeRound(wallet, true, true);
};

/* Headless simulation for auto-resolve / abandoned Cup matches. */
function simulate(pa, pb, c) {
  const ea = entrantOf(c, pa.wallet), eb = entrantOf(c, pb.wallet);
  const a = engine.makeSide(pa.wallet, (ea && ea.snap) || pa.snap || pa);
  const b = engine.makeSide(pb.wallet, (eb && eb.snap) || pb.snap || pb);
  let wins = { a: 0, b: 0 }, first = 'a';
  for (let game = 0; game < 3 && wins.a < 2 && wins.b < 2; game++) {
    engine.resetSide(a); engine.resetSide(b);
    for (let turn = 0; turn < 40; turn++) {
      engine.beginRound(a, b);
      engine.resolveTurn(a, b, engine.autoPlan(a), engine.autoPlan(b), first);
      first = first === 'a' ? 'b' : 'a';
      if (engine.isDead(a) || engine.isDead(b)) break;
    }
    if (engine.isDead(a) && engine.isDead(b)) wins[a.hp >= b.hp ? 'a' : 'b']++;
    else if (engine.isDead(a)) wins.b++;
    else if (engine.isDead(b)) wins.a++;
    else wins[a.hp / a.maxhp >= b.hp / b.maxhp ? 'a' : 'b']++;
  }
  return wins.a >= wins.b ? 'a' : 'b';
}

/* Final standings + SOL into each winner's pouch. */
function payout(c) {
  const bk = c.bracket;
  const order = [];
  if (bk.champion) order.push(bk.champion.wallet);
  const gm = bracketRound(bk, 'GF').matches[0];
  const runner = gm.winner === 'a' ? gm.b : gm.a;
  if (runner && !runner.bye && runner.wallet !== (bk.champion && bk.champion.wallet)) order.push(runner.wallet);
  for (let i = c.eliminated.length - 1; i >= 0; i--) {
    if (!order.includes(c.eliminated[i])) order.push(c.eliminated[i]);
  }
  for (const e of c.entrants) if (!order.includes(e.wallet)) order.push(e.wallet);

  const table = PRIZE_TABLE[c.cap] || PRIZE_TABLE[8];
  const scale = PRIZE_POOL_SOL / table.reduce((s, n) => s + n, 0);
  const results = [];
  let awarded = 0;
  order.forEach((w, i) => {
    const e = c.entrants.find(x => x.wallet === w);
    if (!e) return;
    let sol = +(((table[i] || 0) * scale)).toFixed(4);
    if (e.bot || profiles.isBanned(w)) sol = 0;   /* bots and banned wallets never take real SOL */
    if (sol > 0) {
      const p = profiles.get(w);
      p.pouchSol = +((p.pouchSol || 0) + sol).toFixed(6);
      awarded += sol;
      profiles.pushFeed({ type: 'cupPrize', wallet: w, short: profiles.short(w), place: i + 1, sol });
    }
    results.push({ place: i + 1, name: e.player || e.name, wallet: w, sol });
  });
  c.results = results;
  const db = store.data();
  db.totals.cupAwardedSol = +((db.totals.cupAwardedSol || 0) + awarded).toFixed(4);
  store.save();
}

/* ----------------------------------------------------------------- status */

function bracketView(bk) {
  if (!bk) return null;
  const light = p => p ? {
    wallet: p.wallet, player: p.player, name: p.name,
    element: p.element, br: p.br, bye: !!p.bye
  } : null;
  return {
    cap: bk.cap,
    champion: light(bk.champion),
    rounds: bk.order.map(key => {
      const r = bk.rounds[key];
      if (!r) return null;
      const any = r.matches.some(m => m.a || m.b);
      return {
        key,
        title: r.title,
        state: r.state,
        matches: any ? r.matches.map(m => ({ a: light(m.a), b: light(m.b), winner: m.winner, forfeit: !!m.forfeit })) : []
      };
    }).filter(r => r && (r.matches.length || r.state !== 'soon'))
  };
}

function status(wallet) {
  const c = cup();
  if (!c) return { exists: false, status: 'none', cap: 10, public: false, auto: false, entrants: [], entryGlory: ENTRY_GLORY };

  const me = wallet ? entrantOf(c, wallet) : null;
  const out = {
    exists: true,
    status: c.status,
    cap: c.cap,
    public: !!c.public,
    auto: !!c.auto,
    entryGlory: c.entryGlory,
    entrants: c.entrants.map(e => ({ wallet: e.wallet, player: e.player, name: e.name, element: e.element, br: e.br, bot: !!e.bot })),
    round: c.round,
    roundBattling: !!c.roundBattling,
    champion: c.champion,
    results: c.results,
    prizePool: PRIZE_POOL_SOL,
    youRegistered: !!me,
    youReady: !!(wallet && c.ready.includes(wallet)),
    youPlace: null,
    yourPrize: 0,
    matches: [],
    liveMatches: [],
    bracket: bracketView(c.bracket)
  };

  if (c.results && wallet) {
    const row = c.results.find(r => r.wallet === wallet);
    if (row) { out.youPlace = row.place; out.yourPrize = row.sol; }
  } else if (c.status === 'live' && wallet && me) {
    const lost = c.eliminated.indexOf(wallet);
    if (lost > -1) out.youPlace = c.entrants.length - lost;
  }

  if (c.bracket && c.status === 'live') {
    const r = bracketRound(c.bracket, c.round);
    if (r) {
      out.matches = r.matches
        .filter(m => m.a && m.b && !m.a.bye && !m.b.bye && m.winner == null)
        .map(m => ({ a: m.a, b: m.b }));
      out.liveMatches = r.matches.filter(m => m.matchId).map(m => {
        const pm = pvp.getMatch(m.matchId);
        return {
          matchId: m.matchId,
          a: m.a.player || m.a.name,
          b: m.b.player || m.b.name,
          aEl: m.a.element,
          bEl: m.b.element,
          status: pm && !pm.over ? 'live' : 'finished',
          winner: pm ? pm.winner : m.winner
        };
      });
      if (wallet) {
        const mine = r.matches.find(m => m.matchId && ((m.a && m.a.wallet === wallet) || (m.b && m.b.wallet === wallet)));
        if (mine) {
          const pm = pvp.getMatch(mine.matchId);
          out.pvpMatchId = mine.matchId;
          out.pvpSide = mine.a.wallet === wallet ? 'a' : 'b';
          out.pvpOver = !pm || pm.over;
        }
      }
    }
  }
  return out;
}

function setPublic(wallet, pub) {
  if (!isAdmin(wallet)) return { error: 'admin only' };
  const c = cup();
  if (!c) return { error: 'no cup' };
  c.public = !!pub;
  store.save();
  return { ok: true, public: c.public };
}

function setAuto(wallet, auto) {
  if (!isAdmin(wallet)) return { error: 'admin only' };
  const c = cup();
  if (!c) return { error: 'no cup' };
  c.auto = !!auto;
  store.save();
  return { ok: true, auto: c.auto };
}

function ready(wallet) {
  const c = cup();
  if (!c) return { error: 'no cup' };
  if (!entrantOf(c, wallet)) return { error: 'not registered' };
  if (!c.ready.includes(wallet)) c.ready.push(wallet);
  store.save();
  return { ok: true };
}

/* ------------------------------------------------------------------- chat */

function pushChat(m) {
  chat.push({ ts: Date.now(), wallet: m.wallet || null, name: String(m.name || 'Trainer').slice(0, 24), text: String(m.text || '').slice(0, 240), sys: !!m.sys });
  if (chat.length > CHAT_MAX) chat = chat.slice(-CHAT_MAX);
}

const getChat = since => ({ messages: chat.filter(m => m.ts > (Number(since) || 0)) });

function sendChat(wallet, name, text) {
  if (!wallet) return { error: 'connect your wallet to chat' };
  const t = String(text || '').trim();
  if (!t) return { error: 'empty message' };
  pushChat({ wallet, name, text: t });
  return { ok: true };
}

/* ---------------------------------------------------------- auto-run loop */

function tick() {
  const c = cup();
  if (!c || c.status !== 'live' || !c.auto) return;
  const t = Date.now();
  if (t < autoTimer) return;

  if (!c.roundBattling) { startRound(null, true); autoTimer = t + AUTO_START_ROUND_MS; return; }

  /* every live duel settled (or a bracket slot with no PvP match) → advance */
  const r = bracketRound(c.bracket, c.round);
  const pendingMatch = r.matches.some(m => {
    if (m.winner != null || m.done) return false;
    if (!m.a || !m.b || m.a.bye || m.b.bye) return false;
    const pm = m.matchId ? pvp.getMatch(m.matchId) : null;
    return !pm || !pm.over;
  });
  if (!pendingMatch) { finalizeRound(null, true, true); autoTimer = t + AUTO_START_ROUND_MS; }
}

module.exports = {
  ENTRY_GLORY, PRIZE_POOL_SOL, RNAME, isAdmin,
  create, resize, register, fill, start, startRound, finalizeRound, resolveRound,
  status, setPublic, setAuto, ready, getChat, sendChat, tick
};
