/* ============================================================================
 * auth.js — proof that a request really comes from the wallet it claims.
 *
 * Before this, every PvP route trusted a plain `wallet` string in the body, so
 * anyone who knew an address could move that player's cards, forfeit their
 * match, or overwrite their profile. Now the client signs a short timestamped
 * message with its wallet key once, and gets back a bearer token used for
 * everything that moves value.
 *
 * The signing scheme is the one the admin routes already used (ed25519 over a
 * "Chikoria sign-in" message), lifted here so both share one implementation.
 * ========================================================================== */

'use strict';

const crypto = require('crypto');
const store = require('./store');

const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS || 7 * 24 * 3600 * 1000);
const SIG_WINDOW_MS = 5 * 60 * 1000;      /* how stale a signed message may be */
const REPLAY_KEEP_MS = SIG_WINDOW_MS * 2;

/* Turn enforcement off only to recover from a bad rollout — see README. */
const REQUIRE_AUTH = String(process.env.REQUIRE_AUTH || 'true') !== 'false';

const LOGIN_PREFIX = 'Chikoria sign-in';

const seenSignatures = new Map();   /* signature -> ts, blocks replay inside the window */

function sweep() {
  const t = Date.now();
  for (const [sig, ts] of seenSignatures) if (t - ts > REPLAY_KEEP_MS) seenSignatures.delete(sig);
  const db = store.data();
  if (!db.sessions) return;
  let changed = false;
  for (const [tok, s] of Object.entries(db.sessions)) {
    if (s.expires <= t) { delete db.sessions[tok]; changed = true; }
  }
  if (changed) store.save();
}

/* Verify an ed25519 signature over `msg` by `wallet`, with freshness + replay
   checks. Returns null when good, or a reason string. */
function verifySigned(wallet, msg, sig, expectPrefix) {
  if (!wallet || !msg || !sig) return 'signature required';
  if (expectPrefix && msg.indexOf(expectPrefix) !== 0) return 'unexpected message';
  if (!msg.includes('wallet:' + wallet)) return 'signature does not match wallet';
  const m = /ts:(\d+)/.exec(msg);
  if (!m || Math.abs(Date.now() - Number(m[1])) > SIG_WINDOW_MS) return 'signature expired';
  if (seenSignatures.has(sig)) return 'signature already used';
  let nacl, bs58;
  try { nacl = require('tweetnacl'); bs58 = require('bs58'); }
  catch (err) { return 'signature check unavailable on this server'; }
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      new TextEncoder().encode(msg),
      Buffer.from(sig, 'base64'),
      bs58.decode(wallet)
    );
  } catch (err) { return 'malformed signature'; }
  if (!ok) return 'bad signature';
  seenSignatures.set(sig, Date.now());
  return null;
}

/* Exchange a signed message for a bearer token. */
function login(wallet, msg, sig) {
  sweep();
  const bad = verifySigned(wallet, msg, sig, LOGIN_PREFIX);
  if (bad) return { error: bad, status: 403 };
  const db = store.data();
  if (!db.sessions) db.sessions = {};
  /* one live session per wallet keeps the store small and logs out a stolen token */
  for (const [tok, s] of Object.entries(db.sessions)) if (s.wallet === wallet) delete db.sessions[tok];
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { wallet, issued: Date.now(), expires: Date.now() + TOKEN_TTL_MS };
  store.save();
  return { ok: true, token, wallet, expiresInMs: TOKEN_TTL_MS };
}

function walletForToken(token) {
  if (!token) return null;
  const db = store.data();
  const s = db.sessions && db.sessions[token];
  if (!s) return null;
  if (s.expires <= Date.now()) { delete db.sessions[token]; store.save(); return null; }
  return s.wallet;
}

const bearer = req => {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : ((req.body && req.body.authToken) || req.query && req.query.authToken || null);
};

/* The wallet this request has actually proven it controls. */
const walletOf = req => walletForToken(bearer(req));

/* Guard for a route acting on `claimed`. Returns null when allowed, else a
   {error,status} the route hands straight back. */
function requireWallet(req, claimed) {
  if (!claimed) return { error: 'wallet required', status: 400 };
  const proven = walletOf(req);
  if (proven === claimed) return null;
  if (!REQUIRE_AUTH) return null;   /* rollout escape hatch */
  return proven
    ? { error: 'this token belongs to a different wallet', status: 403 }
    : { error: 'sign in first (POST /auth/login)', status: 401 };
}

const logout = req => {
  const t = bearer(req);
  const db = store.data();
  if (t && db.sessions && db.sessions[t]) { delete db.sessions[t]; store.save(); }
  return { ok: true };
};

module.exports = { LOGIN_PREFIX, REQUIRE_AUTH, verifySigned, login, logout, walletOf, requireWallet, sweep };
