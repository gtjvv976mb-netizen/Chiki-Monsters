/* ============================================================================
 * store.js — tiny durable key/value store.
 *
 * Everything lives in memory; a debounced writer flushes to one JSON file so a
 * restart (Render redeploy, crash) keeps Glory balances, wager escrow, profiles
 * and Cup results. Live match state is deliberately NOT persisted — an
 * in-flight duel does not survive a restart, both players are refunded instead.
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'chikoria.json');
const FLUSH_MS = 2000;

const EMPTY = () => ({
  profiles: {},      /* wallet -> persisted player record */
  feed: [],          /* recent public events */
  feedSeq: 0,
  banned: [],        /* wallets excluded from payouts */
  cup: null,         /* last/current tournament */
  totals: { cupAwardedSol: 0, totalPaidSol: 0, burned: 0, wagerRake: 0, pvpMatches: 0 }
});

let db = EMPTY();
let dirty = false;
let timer = null;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      db = Object.assign(EMPTY(), parsed);
      db.totals = Object.assign(EMPTY().totals, parsed.totals || {});
    }
  } catch (err) {
    console.error('[store] load failed, starting empty:', err.message);
    db = EMPTY();
  }
  return db;
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);   /* atomic swap — a crash mid-write can't corrupt the live file */
  } catch (err) {
    console.error('[store] save failed:', err.message);
  }
}

function save() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
}

function data() { return db; }

/* flush synchronously on the way out so a redeploy doesn't drop the last writes */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { flush(); process.exit(0); });
}
process.on('exit', flush);

load();

module.exports = { data, save, flush, load, FILE, DATA_DIR };
