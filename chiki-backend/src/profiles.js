/* ============================================================================
 * profiles.js — the player ledger.
 *
 * The client mirrors its own state into /profile on every save. The server
 * keeps the parts that must be authoritative because they can be *spent*:
 * Glory (Cup entry, card mastery, PvP wagers) and the SOL pouch. Anything the
 * client reports that it could otherwise inflate is clamped here, never
 * trusted outright.
 * ========================================================================== */

'use strict';

const store = require('./store');

const MIN_HOLD = 500000;

/* Client-reported Glory (offline AI-ladder wins) can't be verified, so it is
   metered rather than trusted: a wallet is bootstrapped once from whatever its
   save says, and after that may only climb at a believable rate. `gloryVerified`
   separately tracks Glory the SERVER awarded — PvP wins and wager winnings —
   which is what gates anything that pays out real SOL. */
const CLIENT_GLORY_PER_HOUR = Number(process.env.CLIENT_GLORY_PER_HOUR || 300);
const CLIENT_GLORY_BURST = Number(process.env.CLIENT_GLORY_BURST || 600);

function blank(wallet) {
  return {
    wallet,
    handle: null,
    glory: 0,
    gloryVerified: 0,       /* the part the server itself awarded (PvP + wagers) */
    gloryBootstrapped: false,
    clientGloryBucket: CLIENT_GLORY_BURST,
    clientGloryAt: Date.now(),
    escrow: 0,              /* Glory locked in live wagers */
    pvpWins: 0,
    pvpLosses: 0,
    pvpStreak: 0,
    bestStreak: 0,
    wagerWon: 0,
    wagerLost: 0,
    pouchSol: 0,
    lifetimePaid: 0,
    lastClaim: 0,
    bal: 0,
    chikis: [],
    profile: null,
    firstSeen: Date.now(),
    lastSeen: Date.now()
  };
}

function get(wallet) {
  if (!wallet || typeof wallet !== 'string') return null;
  const db = store.data();
  if (!db.profiles[wallet]) { db.profiles[wallet] = blank(wallet); store.save(); }
  const p = db.profiles[wallet];
  /* older records predate these fields */
  if (p.escrow == null) p.escrow = 0;
  if (p.glory == null) p.glory = 0;
  if (p.gloryVerified == null) p.gloryVerified = 0;
  if (p.clientGloryBucket == null) p.clientGloryBucket = CLIENT_GLORY_BURST;
  if (p.clientGloryAt == null) p.clientGloryAt = Date.now();
  return p;
}

const peek = wallet => (store.data().profiles[wallet] || null);

/* Glory the player can actually stake right now (escrowed Glory is already committed). */
const spendable = p => Math.max(0, Math.floor((p.glory || 0) - (p.escrow || 0)));

/* Every server-side Glory change stamps the profile. A client post that lands
   inside SETTLE_WINDOW_MS of one is treated as stale and its Glory ignored —
   without this, the loser's saveProfile() inside end() (which still holds the
   pre-match number) races the settlement and hands their stake back. */
const SETTLE_WINDOW_MS = 120000;

function touchGlory(p) {
  if (p) p.gloryTouched = Date.now();
}

/* Move the verified balance with a server-side award or debit, kept inside
   [0, glory] so it can never claim more than the wallet actually holds. */
function addVerified(p, delta) {
  if (!p) return;
  p.gloryVerified = Math.max(0, Math.min(Math.round(p.glory || 0), Math.round((p.gloryVerified || 0) + delta)));
}

/* Glory this wallet can stake on something that pays real SOL. */
const spendableVerified = p => Math.max(0, Math.min(spendable(p), Math.floor(p.gloryVerified || 0)));

function addGlory(wallet, amount) {
  const p = get(wallet);
  if (!p) return 0;
  p.glory = Math.max(0, Math.round((p.glory || 0) + amount));
  touchGlory(p);
  store.save();
  return p.glory;
}

/* Move Glory into escrow for a wager. Returns false if they can't cover it. */
function lock(wallet, amount) {
  const p = get(wallet);
  if (!p || amount <= 0) return amount <= 0;
  if (spendable(p) < amount) return false;
  p.escrow = (p.escrow || 0) + amount;
  store.save();
  return true;
}

function release(wallet, amount) {
  const p = peek(wallet);
  if (!p || amount <= 0) return;
  p.escrow = Math.max(0, (p.escrow || 0) - amount);
  store.save();
}

/* Settle a wager: the loser's stake leaves escrow and moves to the winner. */
function settleWager(winnerWallet, loserWallet, stake, rakeBp) {
  const rake = Math.round(stake * (rakeBp || 0) / 10000);
  const won = Math.max(0, stake - rake);
  release(winnerWallet, stake);
  release(loserWallet, stake);
  const w = get(winnerWallet), l = get(loserWallet);
  if (w) { w.glory = Math.max(0, Math.round(w.glory + won)); w.wagerWon = (w.wagerWon || 0) + won; addVerified(w, won); touchGlory(w); }
  if (l) { l.glory = Math.max(0, Math.round(l.glory - stake)); l.wagerLost = (l.wagerLost || 0) + stake; addVerified(l, -stake); touchGlory(l); }
  const db = store.data();
  db.totals.wagerRake = Math.round((db.totals.wagerRake || 0) + rake);
  store.save();
  return { won, rake };
}

function recordResult(wallet, win, gloryDelta) {
  const p = get(wallet);
  if (!p) return;
  if (win) {
    p.pvpWins = (p.pvpWins || 0) + 1;
    p.pvpStreak = (p.pvpStreak || 0) + 1;
    p.bestStreak = Math.max(p.bestStreak || 0, p.pvpStreak);
  } else {
    p.pvpLosses = (p.pvpLosses || 0) + 1;
    p.pvpStreak = 0;
  }
  if (gloryDelta) { p.glory = Math.max(0, Math.round((p.glory || 0) + gloryDelta)); addVerified(p, gloryDelta); }
  touchGlory(p);
  store.save();
}

/* The client posts its whole save blob. Take the descriptive parts verbatim, but
   only ever RAISE server Glory from it when the client is ahead, nothing is
   escrowed, and the server has not just settled something for this wallet. */
function syncFromClient(wallet, profile) {
  const p = get(wallet);
  if (!p || !profile || typeof profile !== 'object') return p;
  p.profile = profile;
  p.handle = profile.handle || p.handle;
  p.bal = Math.max(0, Number(profile.bal) || 0);
  p.chikis = Array.isArray(profile.chikis) ? profile.chikis : p.chikis;
  p.lastSeen = Date.now();
  const claimed = Math.max(0, Math.floor(Number(profile.glory) || 0));
  const settling = Date.now() - (p.gloryTouched || 0) < SETTLE_WINDOW_MS;
  if (!p.gloryBootstrapped) {
    /* first time we've seen this wallet — carry their existing local progress in */
    p.glory = claimed;
    p.gloryBootstrapped = true;
    p.clientGloryAt = Date.now();
  } else if (!p.escrow && !settling && claimed > p.glory) {
    /* refill the bucket for elapsed time, then grant only what it covers */
    const now = Date.now();
    const hours = Math.max(0, now - (p.clientGloryAt || now)) / 3600000;
    p.clientGloryBucket = Math.min(CLIENT_GLORY_BURST, (p.clientGloryBucket || 0) + hours * CLIENT_GLORY_PER_HOUR);
    p.clientGloryAt = now;
    const gain = Math.min(claimed - p.glory, Math.floor(p.clientGloryBucket));
    if (gain > 0) { p.glory += gain; p.clientGloryBucket -= gain; }
  }
  store.save();
  return p;
}

const isBanned = wallet => store.data().banned.includes(wallet);

function pushFeed(ev) {
  const db = store.data();
  db.feedSeq = (db.feedSeq || 0) + 1;
  const row = Object.assign({ id: db.feedSeq, ts: Date.now() }, ev);
  db.feed.push(row);
  if (db.feed.length > 400) db.feed = db.feed.slice(-400);
  store.save();
  return row;
}

const short = w => (w ? w.slice(0, 4) + '…' + w.slice(-4) : 'A holder');

module.exports = {
  MIN_HOLD, CLIENT_GLORY_PER_HOUR, CLIENT_GLORY_BURST,
  get, peek, spendable, spendableVerified, addVerified, addGlory, lock, release,
  settleWager, recordResult, syncFromClient, isBanned, pushFeed, short
};
