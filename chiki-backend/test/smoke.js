/* End-to-end smoke test: boots the real server and drives it the way play.html
   does — real ed25519 wallets, a real sign-in, a wagered duel, Glory metering,
   and a full Cup bracket. */
'use strict';

const path = require('path');
const os = require('os');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

/* Real wallets, created before the server boots so the admin list can name one. */
const makeWallet = () => {
  const kp = nacl.sign.keyPair();
  return { kp, pk: bs58.encode(Buffer.from(kp.publicKey)), token: null };
};
const A = makeWallet(), B = makeWallet(), ADMIN = makeWallet(), MALLORY = makeWallet();
const makeWalletLike = makeWallet;

process.env.DATA_DIR = path.join(os.tmpdir(), 'chikoria-test-' + Date.now());
process.env.ADMIN_WALLETS = ADMIN.pk;
process.env.CLIENT_GLORY_PER_HOUR = '300';
process.env.CLIENT_GLORY_BURST = '600';

const app = require('../server');
const PORT = 4599;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
const hdr = w => Object.assign({ 'content-type': 'application/json' }, w && w.token ? { Authorization: 'Bearer ' + w.token } : {});
const get = async (p, w) => (await fetch(BASE + p, { headers: hdr(w) })).json();
const post = async (p, b, w) => (await fetch(BASE + p, { method: 'POST', headers: hdr(w), body: JSON.stringify(b || {}) })).json();
const status = async (p, b, w) => (await fetch(BASE + p, { method: 'POST', headers: hdr(w), body: JSON.stringify(b || {}) })).status;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const sign = (w, msg) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), w.kp.secretKey)).toString('base64');
const loginMsg = w => 'Chikoria sign-in\nwallet:' + w.pk + '\nts:' + Date.now() + '\nnonce:' + Math.random().toString(36).slice(2);
async function signIn(w) {
  const msg = loginMsg(w);
  const r = await post('/auth/login', { wallet: w.pk, msg, sig: sign(w, msg) });
  w.token = r.token;
  return r;
}
const snap = (name, el, br) => ({ name, handle: name, element: el, br, arenaSkills: [0, 1, 3, 6], cardTier: { 0: 3, 1: 3, 3: 2, 6: 2 } });
const seed = async (w, handle, glory) => post('/profile', { wallet: w.pk, profile: { handle, glory, bal: 600000, chikis: [] } }, w);

(async () => {
  const server = app.listen(PORT);
  await sleep(200);

  console.log('\n1. health');
  ok((await get('/')).ok === true, 'root responds');
  ok((await get('/health')).ok === true, '/health responds');

  console.log('\n2. wallet sign-in');
  const bad = await post('/auth/login', { wallet: A.pk, msg: loginMsg(A), sig: sign(B, 'something else') });
  ok(!!bad.error, 'a signature from the wrong key is rejected');
  const stale = 'Chikoria sign-in\nwallet:' + A.pk + '\nts:' + (Date.now() - 10 * 60000);
  ok(!!(await post('/auth/login', { wallet: A.pk, msg: stale, sig: sign(A, stale) })).error, 'an expired signature is rejected');
  const li = await signIn(A);
  ok(!!li.token, 'a valid signature returns a session token');
  ok((await get('/auth/me', A)).wallet === A.pk, '/auth/me reports the proven wallet');
  await signIn(B); await signIn(ADMIN); await signIn(MALLORY);

  console.log('\n3. impersonation is refused');
  ok(await status('/pvp/available', { wallet: A.pk, name: 'x', snap: snap('G', 'Water', 5) }) === 401,
     'no token → 401');
  ok(await status('/pvp/available', { wallet: A.pk, name: 'x', snap: snap('G', 'Water', 5) }, MALLORY) === 403,
     "another wallet's token → 403");
  ok(await status('/profile', { wallet: A.pk, profile: { glory: 999999 } }, MALLORY) === 403,
     'cannot overwrite a profile you do not control');

  console.log('\n4. Glory is metered, not trusted');
  await seed(A, 'Ayla', 900); await seed(B, 'Brix', 900);
  ok((await get('/claimable?wallet=' + A.pk, A)).glory === 900, 'first sight bootstraps from the save (900)');
  await seed(A, 'Ayla', 999999);
  const afterGrab = (await get('/claimable?wallet=' + A.pk, A)).glory;
  ok(afterGrab < 2000, 'a later grab for 999999 is capped by the rate limit (got ' + afterGrab + ')');
  ok((await get('/claimable?wallet=' + A.pk, A)).gloryVerified === 0, 'none of it counts as battle-earned');

  console.log('\n4b. the lobby must not zero a wallet it has never seen');
  const fresh = makeWalletLike();
  await signIn(fresh);
  const v0 = await post('/pvp/available', { wallet: fresh.pk, name: 'New', snap: snap('N', 'Light', 4) }, fresh);
  ok(v0.you.bootstrapped === false, 'an unseen wallet is reported as NOT bootstrapped');
  ok(v0.you.glory === 0, '…and its server Glory reads 0, which the client must not adopt');
  await seed(fresh, 'New', 640);
  const v1 = await post('/pvp/available', { wallet: fresh.pk, name: 'New', snap: snap('N', 'Light', 4) }, fresh);
  ok(v1.you.bootstrapped === true && v1.you.glory === 640, 'after the save syncs it is bootstrapped at 640');

  console.log('\n5. matchmaking with a wager');
  let a = await post('/pvp/available', { wallet: A.pk, name: 'Ayla', snap: snap('Galador', 'Water', 12), searching: true, wager: 100 }, A);
  ok(Array.isArray(a.players), '/pvp/available returns a lobby');
  let b = await post('/pvp/available', { wallet: B.pk, name: 'Brix', snap: snap('Dragonos', 'Fire', 11), searching: true, wager: 250 }, B);
  a = await post('/pvp/available', { wallet: A.pk, name: 'Ayla', snap: snap('Galador', 'Water', 12), searching: true, wager: 100 }, A);
  const matched = a.matched || b.matched;
  ok(!!matched, 'two searchers auto-matched');
  if (!matched) { server.close(); process.exit(1); }
  const matchId = matched.matchId;

  let sa = await get('/pvp/state?matchId=' + matchId + '&wallet=' + A.pk, A);
  ok(sa.wager.stake === 100, 'stake settles at the LOWER of the two asks');
  ok(sa.you.hand.length === 6, 'server dealt a 6-card hand');
  ok(sa.you.energy === 3, 'opening energy is 3');
  ok((await get('/claimable?wallet=' + A.pk, A)).gloryEscrow === 100, 'stake moved into escrow');
  ok(await status('/pvp/move', { matchId, wallet: A.pk, cards: [0] }, MALLORY) === 403, "an outsider cannot play A's cards");

  console.log('\n6. playing the duel out');
  let sb, turns = 0;
  while (turns++ < 400) {
    sa = await get('/pvp/state?matchId=' + matchId + '&wallet=' + A.pk, A);
    sb = await get('/pvp/state?matchId=' + matchId + '&wallet=' + B.pk, B);
    if (sa.over) break;
    for (const [w, s] of [[A, sa], [B, sb]]) {
      if (s.between || s.youSubmitted || s.over) continue;
      const picks = []; let spent = 0;
      s.you.hand.forEach((c, i) => { if (picks.length < 3 && spent + c.cost <= s.you.energy) { picks.push(i); spent += c.cost; } });
      await post('/pvp/move', { matchId, wallet: w.pk, cards: picks }, w);
    }
    await sleep(40);
  }
  ok(sa.over === true, 'match reached a result (' + turns + ' polls)');
  ok(sb.result !== sa.result, 'the two sides got opposite verdicts');
  ok(sa.score.you + sa.score.foe >= 2, 'best-of-3 played out ' + sa.score.you + '-' + sa.score.foe);
  ok(Array.isArray(sa.lastTurn && sa.lastTurn.seq), 'replay sequence present');

  console.log('\n7. wager settlement');
  const winner = sa.result === 'win' ? A : B, loser = sa.result === 'win' ? B : A;
  const pw = await get('/claimable?wallet=' + winner.pk, winner);
  const pl = await get('/claimable?wallet=' + loser.pk, loser);
  ok(pw.gloryEscrow === 0 && pl.gloryEscrow === 0, 'escrow released on both sides');
  ok(pw.gloryVerified > 0, 'the winner now holds battle-earned Glory (' + pw.gloryVerified + ')');
  ok((await get('/stats')).wagerRake === 5, '5% rake skimmed to the Cup pool');

  console.log('\n7b. a stale client post cannot undo a settlement');
  const before = (await get('/claimable?wallet=' + loser.pk, loser)).glory;
  await seed(loser, 'stale', 900);
  ok((await get('/claimable?wallet=' + loser.pk, loser)).glory === before, 'pre-match profile ignored (' + before + ' held)');

  console.log('\n8. Cup entry needs battle-earned Glory');
  ok((await post('/cup/create', { wallet: MALLORY.pk, cap: 8 }, MALLORY)).error, 'non-admin cannot create a Cup');
  ok((await post('/cup/create', { wallet: ADMIN.pk, cap: 8 }, ADMIN)).ok, 'admin created an 8-player Cup');
  await post('/cup/public', { wallet: ADMIN.pk, public: true }, ADMIN);

  await seed(MALLORY, 'Mallory', 5000);            /* bootstraps big, but none of it is earned */
  const cheat = await post('/cup/register', { wallet: MALLORY.pk, snap: snap('Fake', 'Fire', 20) }, MALLORY);
  ok(!!cheat.error && /battle/i.test(cheat.error), 'unearned Glory cannot buy a seat: ' + cheat.error);

  const legit = await post('/cup/register', { wallet: winner.pk, snap: snap('Galador', 'Water', 12) }, winner);
  ok(legit.ok || /battle-earned/.test(legit.error || ''), 'the PvP winner is judged on earned Glory');

  console.log('\n9. Cup runs to completion');
  await post('/cup/fill', { wallet: ADMIN.pk }, ADMIN);
  ok((await post('/cup/start', { wallet: ADMIN.pk }, ADMIN)).ok, 'Cup started');
  let st = await get('/cup/status?wallet=' + winner.pk, winner), guard = 0;
  while (st.status === 'live' && guard++ < 30) {
    const r = await post('/cup/resolve-round', { wallet: ADMIN.pk }, ADMIN);
    if (r.error) { console.log('    resolve error:', r.error); break; }
    st = await get('/cup/status?wallet=' + winner.pk, winner);
  }
  ok(st.status === 'finished', 'Cup finished in ' + guard + ' rounds');
  ok(!!st.champion, 'champion crowned: ' + st.champion);
  const keys = st.bracket.rounds.map(r => r.key);
  ok(keys.includes('WF') && keys.includes('LF') && keys.includes('GF'), 'ran through WF, LF and GF (' + keys.join(',') + ')');

  console.log('\n10. reads stay open, admin writes stay signed');
  ok((await get('/cup/status')).exists === true, 'cup status is public');
  ok(Array.isArray((await get('/leaderboard')).champions), 'leaderboard is public');
  ok((await post('/admin/ban', { adminWallet: ADMIN.pk, authMsg: 'x', authSig: 'y', target: 'Z' }, ADMIN)).error,
     'ban still needs a real signature even with a session token');
  const banMsg = 'Chikoria admin sign-in\nwallet:' + ADMIN.pk + '\nts:' + Date.now();
  ok((await post('/admin/ban', { adminWallet: ADMIN.pk, authMsg: banMsg, authSig: sign(ADMIN, banMsg), target: 'ZZZ' }, ADMIN)).ok,
     'a correctly signed ban is accepted');
  ok((await post('/admin/ban', { adminWallet: ADMIN.pk, authMsg: banMsg, authSig: sign(ADMIN, banMsg), target: 'ZZZ' }, ADMIN)).error,
     'replaying that exact signature is refused');

  console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
