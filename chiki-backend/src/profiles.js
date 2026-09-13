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

function blank(wallet) {
  return {
    wallet,
    handle: null,
    glory: 0,
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
  return p;
}

const peek = wallet => (store.data().profiles[wallet] || null);

/* Glory the player can actually stake right now (escrowed Glory is already committed). */
const spendable = p => Math.max(0, Math.floor((p.glory || 0) - (p.escrow || 0)));

function addGlory(wallet, amount) {
  const p = get(wallet);
  if (!p) return 0;
  p.glory = Math.max(0, Math.round((p.glory || 0) + amount));
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
  if (w) { w.glory = Math.max(0, Math.round(w.glory + won)); w.wagerWon = (w.wagerWon || 0) + won; }
  if (l) { l.glory = Math.max(0, Math.round(l.glory - stake)); l.wagerLost = (l.wagerLost || 0) + stake; }
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
  if (gloryDelta) p.glory = Math.max(0, Math.round((p.glory || 0) + gloryDelta));
  store.save();
}

/* The client posts its whole save blob. Take the descriptive parts verbatim, but
   only ever RAISE server Glory from it when the client is ahead and nothing is
   escrowed — otherwise a stale tab could wipe out a wager mid-match. */
function syncFromClient(wallet, profile) {
  const p = get(wallet);
  if (!p || !profile || typeof profile !== 'object') return p;
  p.profile = profile;
  p.handle = profile.handle || p.handle;
  p.bal = Math.max(0, Number(profile.bal) || 0);
  p.chikis = Array.isArray(profile.chikis) ? profile.chikis : p.chikis;
  p.lastSeen = Date.now();
  const claimed = Math.max(0, Math.floor(Number(profile.glory) || 0));
  if (!p.escrow && claimed > (p.glory || 0)) p.glory = claimed;
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
  MIN_HOLD, get, peek, spendable, addGlory, lock, release,
  settleWager, recordResult, syncFromClient, isBanned, pushFeed, short
};
