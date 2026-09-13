/* ============================================================================
 * Chikoria backend — live Chikiseum PvP, wagers and the Chikoria Cup.
 *
 * Every route here is one the shipped play.html already calls; the shapes match
 * what its fetch handlers read. See README.md for the full endpoint list.
 * ========================================================================== */

'use strict';

const express = require('express');
const cors = require('cors');

const store = require('./src/store');
const profiles = require('./src/profiles');
const pvp = require('./src/pvp');
const cup = require('./src/cup');
const engine = require('./src/engine');

const app = express();
const PORT = process.env.PORT || 3000;
const MINT = process.env.CHIKI_MINT || 'CPYrgdAYWFQD74ZtsR8mEBWW7qnrXnegcn7gDMobpump';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MIN_HOLD = Number(process.env.MIN_HOLD || 500000);
const PRESENCE_TTL = 90000;
const CLAIM_COOLDOWN_MS = Number(process.env.CLAIM_COOLDOWN_MS || 6 * 3600 * 1000);
const DAILY_CLAIM_CAP_SOL = Number(process.env.DAILY_CLAIM_CAP_SOL || 0.5);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

/* Wrap a handler so a thrown error becomes a clean 500 instead of a hang. */
const h = fn => (req, res) => {
  try {
    const out = fn(req, res);
    if (out === undefined || res.headersSent) return;
    if (out && out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(out);
  } catch (err) {
    console.error('[route]', req.path, err);
    if (!res.headersSent) res.status(500).json({ error: 'server error' });
  }
};

const ha = fn => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out === undefined || res.headersSent) return;
    if (out && out.error) return res.status(out.status || 400).json({ error: out.error });
    res.json(out);
  } catch (err) {
    console.error('[route]', req.path, err);
    if (!res.headersSent) res.status(500).json({ error: 'server error' });
  }
};

/* ------------------------------------------------------------------ health */

app.get('/', (req, res) => res.json({
  ok: true,
  service: 'chikoria-backend',
  pvp: 'live',
  endpoints: ['/pvp/available', '/pvp/queue', '/pvp/state', '/pvp/move', '/cup/status', '/stats'],
  online: presenceCount(),
  matches: pvp.liveMatches().filter(m => m.status === 'live').length
}));
app.get('/health', (req, res) => res.json({ ok: true, up: Math.round(process.uptime()) }));

/* ---------------------------------------------------------------- presence */

const presence = new Map();   /* wallet -> {handle, chikis, roster, ts} */

function presenceCount() {
  const t = Date.now();
  for (const [w, p] of presence) if (t - p.ts > PRESENCE_TTL) presence.delete(w);
  return presence.size;
}

function presencePayload() {
  const db = store.data();
  return {
    activeUsers: presenceCount(),
    inChikiseum: pvp.lobbySize(),
    liveMatches: pvp.liveMatches().filter(m => m.status === 'live').length,
    holders: Object.keys(db.profiles).length
  };
}

app.get('/presence', h(() => presencePayload()));
app.post('/presence', h(req => {
  const { wallet, handle, chikis, roster } = req.body || {};
  if (wallet) {
    presence.set(wallet, { handle, chikis: chikis | 0, roster: Array.isArray(roster) ? roster.slice(0, 12) : [], ts: Date.now() });
    const p = profiles.get(wallet);
    if (handle) p.handle = handle;
    p.lastSeen = Date.now();
    store.save();
  }
  return presencePayload();
}));

/* ---------------------------------------------------------------- profiles */

app.post('/profile', h(req => {
  const { wallet, profile } = req.body || {};
  if (!wallet) return { error: 'wallet required' };
  const p = profiles.syncFromClient(wallet, profile);
  return { ok: true, glory: p.glory, escrow: p.escrow };
}));

app.post('/verify', ha(async req => {
  const wallet = (req.body || {}).wallet;
  if (!wallet) return { error: 'wallet required' };
  const balance = await chikiBalance(wallet);
  const p = profiles.get(wallet);
  if (balance != null) { p.bal = balance; store.save(); }
  const bal = balance != null ? balance : (p.bal || 0);
  return { ok: true, wallet, balance: bal, eligible: bal >= MIN_HOLD, minHold: MIN_HOLD, banned: profiles.isBanned(wallet) };
}));

/* Read the wallet's $CHIKI balance straight off-chain. Works for either token
   program — pump.fun mints are classic SPL, not Token-2022. */
async function chikiBalance(wallet) {
  const body = (programId) => ({
    jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
    params: [wallet, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]
  });
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
      signal: AbortSignal.timeout(8000)
    });
    const j = await r.json();
    const accts = (j.result && j.result.value) || [];
    let total = 0;
    for (const a of accts) {
      const amt = a.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (amt) total += amt;
    }
    return Math.floor(total);
  } catch (err) {
    return null;   /* RPC hiccup — fall back to the last known balance */
  }
}

/* --------------------------------------------------------------- economy */

app.get('/claimable', h(req => {
  const wallet = req.query.wallet;
  if (!wallet) return { error: 'wallet required' };
  const p = profiles.get(wallet);
  return {
    wallet,
    claimableSol: +(p.pouchSol || 0).toFixed(6),
    lifetimePaid: +(p.lifetimePaid || 0).toFixed(4),
    lastClaim: p.lastClaim || 0,
    chikis: (p.chikis || []).length,
    eligible: (p.bal || 0) >= MIN_HOLD,
    minHold: MIN_HOLD,
    banned: profiles.isBanned(wallet),
    glory: Math.round(p.glory || 0),
    gloryEscrow: Math.round(p.escrow || 0)
  };
}));

/* Real SOL payouts need a funded treasury key. Without one configured the
   pouch still accrues — this endpoint just refuses to invent a transaction. */
app.post('/claim', ha(async req => {
  const wallet = (req.body || {}).wallet;
  if (!wallet) return { error: 'wallet required' };
  if (profiles.isBanned(wallet)) return { error: 'this wallet is restricted from payouts' };
  const p = profiles.get(wallet);
  const owed = +(p.pouchSol || 0).toFixed(6);
  if (owed <= 0) return { error: 'nothing to claim yet' };
  if (p.lastClaim && Date.now() - p.lastClaim < CLAIM_COOLDOWN_MS) {
    const mins = Math.ceil((CLAIM_COOLDOWN_MS - (Date.now() - p.lastClaim)) / 60000);
    return { error: 'claim cooldown — try again in ' + mins + ' min' };
  }
  if (!process.env.TREASURY_SECRET) {
    return { error: 'payouts are not enabled on this server (no treasury configured)', status: 503 };
  }
  const amount = Math.min(owed, DAILY_CLAIM_CAP_SOL);
  const sig = await sendSol(wallet, amount);
  if (!sig) return { error: 'payout failed — try again shortly', status: 503 };
  p.pouchSol = +(owed - amount).toFixed(6);
  p.lifetimePaid = +((p.lifetimePaid || 0) + amount).toFixed(6);
  p.lastClaim = Date.now();
  const db = store.data();
  db.totals.totalPaidSol = +((db.totals.totalPaidSol || 0) + amount).toFixed(4);
  store.save();
  profiles.pushFeed({ type: 'claim', wallet, short: profiles.short(wallet), amountSol: amount });
  return { ok: true, amountSol: +amount.toFixed(6), explorer: 'https://solscan.io/tx/' + sig, remaining: p.pouchSol };
}));

async function sendSol(to, amountSol) {
  try {
    const web3 = require('@solana/web3.js');
    const bs58 = require('bs58');
    const secret = process.env.TREASURY_SECRET.trim();
    const key = secret.startsWith('[')
      ? Uint8Array.from(JSON.parse(secret))
      : bs58.decode(secret);
    const payer = web3.Keypair.fromSecretKey(key);
    const conn = new web3.Connection(RPC, 'confirmed');
    const tx = new web3.Transaction().add(web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new web3.PublicKey(to),
      lamports: Math.round(amountSol * web3.LAMPORTS_PER_SOL)
    }));
    return await web3.sendAndConfirmTransaction(conn, tx, [payer]);
  } catch (err) {
    console.error('[claim] payout failed:', err.message);
    return null;
  }
}

app.get('/stats', h(() => {
  const db = store.data();
  const wallets = Object.values(db.profiles);
  return {
    poolSol: Number(process.env.POOL_SOL || 0),
    totalPaidSol: +(db.totals.totalPaidSol || 0).toFixed(4),
    cupAwardedSol: +(db.totals.cupAwardedSol || 0).toFixed(4),
    burned: db.totals.burned || 0,
    activeUsers: presenceCount(),
    holders: wallets.length,
    chikiHolders: wallets.filter(p => (p.bal || 0) >= MIN_HOLD).length,
    claimedChikis: wallets.reduce((n, p) => n + ((p.chikis || []).length), 0),
    legendsHatched: wallets.reduce((n, p) => n + (p.chikis || []).filter(c => c.isLegend).length, 0),
    pvpMatches: db.totals.pvpMatches || 0,
    wagerRake: db.totals.wagerRake || 0
  };
}));

app.get('/leaderboard', h(() => {
  const wallets = Object.values(store.data().profiles);
  const earners = wallets
    .filter(p => (p.lifetimePaid || 0) > 0 || (p.pouchSol || 0) > 0)
    .sort((a, b) => (b.lifetimePaid || 0) - (a.lifetimePaid || 0))
    .slice(0, 20)
    .map(p => ({ wallet: p.wallet, short: profiles.short(p.wallet), handle: p.handle, sol: +(p.lifetimePaid || 0).toFixed(4) }));
  const champions = wallets
    .filter(p => (p.pvpWins || 0) > 0)
    .sort((a, b) => (b.pvpWins || 0) - (a.pvpWins || 0) || (b.glory || 0) - (a.glory || 0))
    .slice(0, 20)
    .map((p, i) => ({
      rank: i + 1, wallet: p.wallet, short: profiles.short(p.wallet),
      handle: p.handle || profiles.short(p.wallet),
      wins: p.pvpWins || 0, losses: p.pvpLosses || 0,
      glory: Math.round(p.glory || 0), streak: p.bestStreak || 0,
      wagerWon: Math.round(p.wagerWon || 0)
    }));
  return { earners, champions };
}));

app.get('/feed', h(req => {
  const since = Number(req.query.since) || 0;
  return { events: store.data().feed.filter(e => e.id > since).slice(-60) };
}));

app.get('/allchikis', h(req => {
  const cap = Math.min(120, Number(req.query.cap) || 60);
  const exclude = req.query.exclude || '';
  const out = [];
  for (const p of Object.values(store.data().profiles)) {
    if (p.wallet === exclude) continue;
    if (Date.now() - (p.lastSeen || 0) > 30 * 60000) continue;
    for (const c of (p.chikis || [])) {
      out.push({
        wallet: p.wallet, handle: p.handle, bal: p.bal || 0,
        sp: c.sp, level: c.level, nick: c.nick, tasksDone: c.tasksDone || 0,
        hungry: !!c.hungry, isLegend: !!c.isLegend
      });
      if (out.length >= cap) return { chikis: out };
    }
  }
  return { chikis: out };
}));

/* -------------------------------------------------------------------- PvP */

app.post('/pvp/available', h(req => pvp.available(req.body || {})));
app.post('/pvp/queue', h(req => pvp.queue(req.body || {})));
app.get('/pvp/queue', h(req => pvp.queue({ wallet: req.query.wallet })));
app.post('/pvp/cancel', h(req => pvp.cancel(req.body || {})));
app.post('/pvp/challenge', h(req => pvp.challenge(req.body || {})));
app.post('/pvp/challenge/accept', h(req => pvp.acceptChallenge(req.body || {})));
app.post('/pvp/challenge/decline', h(req => pvp.declineChallenge(req.body || {})));
app.get('/pvp/state', h(req => pvp.state(req.query.matchId, req.query.wallet)));
app.post('/pvp/move', h(req => pvp.move(req.body || {})));
app.post('/pvp/forfeit', h(req => pvp.forfeit(req.body || {})));
app.get('/pvp/spectate', h(req => pvp.spectate(req.query.matchId)));
app.get('/pvp/live', h(() => ({ matches: pvp.liveMatches() })));
app.get('/pvp/wagers', h(() => ({ tiers: pvp.WAGER_TIERS, rakeBp: pvp.WAGER_RAKE_BP })));

/* -------------------------------------------------------------------- Cup */

app.get('/cup/status', h(req => cup.status(req.query.wallet)));
app.post('/cup/create', h(req => cup.create(req.body.wallet, req.body.cap)));
app.post('/cup/resize', h(req => cup.resize(req.body.wallet, req.body.cap)));
app.post('/cup/register', h(req => cup.register(req.body.wallet, req.body.snap)));
app.post('/cup/ready', h(req => cup.ready(req.body.wallet)));
app.post('/cup/fill', h(req => cup.fill(req.body.wallet)));
app.post('/cup/start', h(req => cup.start(req.body.wallet)));
app.post('/cup/public', h(req => cup.setPublic(req.body.wallet, req.body.public)));
app.post('/cup/auto', h(req => cup.setAuto(req.body.wallet, req.body.auto)));
app.post('/cup/start-round', h(req => cup.startRound(req.body.wallet)));
app.post('/cup/finalize-round', h(req => cup.finalizeRound(req.body.wallet)));
app.post('/cup/resolve-round', h(req => cup.resolveRound(req.body.wallet)));
app.get('/cup/chat', h(req => cup.getChat(req.query.since)));
app.post('/cup/chat', h(req => cup.sendChat(req.body.wallet, req.body.name, req.body.text)));

/* ------------------------------------------------------------------ admin */

/* Admin mutations are authenticated by a wallet SIGNATURE, not a typed key:
   the client signs "Chikoria admin sign-in\nwallet:<pk>\nts:<ms>". */
function verifyAdmin(body) {
  const { adminWallet, authMsg, authSig } = body || {};
  if (!adminWallet || !authMsg || !authSig) return 'signature required';
  if (!cup.isAdmin(adminWallet)) return 'not an admin wallet';
  if (!authMsg.includes('wallet:' + adminWallet)) return 'signature does not match wallet';
  const m = /ts:(\d+)/.exec(authMsg);
  if (!m || Math.abs(Date.now() - Number(m[1])) > 5 * 60000) return 'signature expired';
  try {
    const nacl = require('tweetnacl');
    const bs58 = require('bs58');
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(authMsg),
      Buffer.from(authSig, 'base64'),
      bs58.decode(adminWallet)
    );
    return ok ? null : 'bad signature';
  } catch (err) {
    return 'signature check unavailable';
  }
}

app.get('/admin/banned', h(req => {
  if (!cup.isAdmin(req.query.wallet)) return { error: 'admin only' };
  return { banned: store.data().banned };
}));

app.post('/admin/ban', h(req => {
  const bad = verifyAdmin(req.body);
  if (bad) return { error: bad, status: 403 };
  const db = store.data();
  const target = (req.body.target || '').trim();
  if (!target) return { error: 'target required' };
  if (!db.banned.includes(target)) db.banned.push(target);
  store.save();
  return { ok: true, total: db.banned.length };
}));

app.post('/admin/unban', h(req => {
  const bad = verifyAdmin(req.body);
  if (bad) return { error: bad, status: 403 };
  const db = store.data();
  db.banned = db.banned.filter(w => w !== (req.body.target || '').trim());
  store.save();
  return { ok: true, total: db.banned.length };
}));

app.post('/admin/gift-chiki', h(req => {
  const bad = verifyAdmin(req.body);
  if (bad) return { error: bad, status: 403 };
  const { wallet, sp, level, nick } = req.body;
  if (!wallet) return { error: 'recipient wallet required' };
  const p = profiles.get(wallet);
  p.gifts = p.gifts || [];
  p.gifts.push({ sp: sp | 0, level: Math.max(1, Math.min(50, level | 0 || 1)), nick: nick || null, ts: Date.now() });
  store.save();
  return { ok: true, pending: false, gifts: p.gifts.length };
}));

app.post('/admin/grant-glory', h(req => {
  const bad = verifyAdmin(req.body);
  if (bad) return { error: bad, status: 403 };
  const { wallet, amount } = req.body;
  if (!wallet) return { error: 'wallet required' };
  return { ok: true, glory: profiles.addGlory(wallet, Math.round(Number(amount) || 0)) };
}));

app.use((req, res) => res.status(404).json({ error: 'unknown endpoint: ' + req.path }));

/* ------------------------------------------------------------------- boot */

pvp.recoverEscrow();
setInterval(() => { try { pvp.tick(); } catch (e) { console.error('[pvp tick]', e); } }, 500);
setInterval(() => { try { cup.tick(); } catch (e) { console.error('[cup tick]', e); } }, 2000);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('Chikoria backend listening on :' + PORT);
    console.log('  mint      ' + MINT);
    console.log('  payouts   ' + (process.env.TREASURY_SECRET ? 'ENABLED' : 'disabled (set TREASURY_SECRET)'));
    console.log('  data      ' + store.FILE);
  });
}

module.exports = app;
