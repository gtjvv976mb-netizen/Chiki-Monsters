/* End-to-end smoke test: boots the real server, drives two clients through a
   wagered duel exactly the way play.html does, then runs a full Cup bracket. */
'use strict';

process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'chikoria-test-' + Date.now());
process.env.ADMIN_WALLETS = 'ADMINWALLET';

const app = require('../server');
const PORT = 4599;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } };
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const snap = (name, el, br) => ({ name, handle: name, element: el, br, arenaSkills: [0, 1, 3, 6], cardTier: { 0: 3, 1: 3, 3: 2, 6: 2 } });

(async () => {
  const server = app.listen(PORT);
  await sleep(200);

  console.log('\n1. health + lobby');
  ok((await get('/')).ok === true, 'root responds');
  ok((await get('/health')).ok === true, '/health responds');

  /* seed Glory the way the client does: post a profile */
  await post('/profile', { wallet: 'WALLET_A', profile: { handle: 'Ayla', glory: 900, bal: 600000, chikis: [] } });
  await post('/profile', { wallet: 'WALLET_B', profile: { handle: 'Brix', glory: 900, bal: 600000, chikis: [] } });
  ok((await get('/claimable?wallet=WALLET_A')).glory === 900, 'profile sync seeded 900 Glory');

  console.log('\n2. matchmaking with a wager');
  let a = await post('/pvp/available', { wallet: 'WALLET_A', name: 'Ayla', snap: snap('Galador', 'Water', 12), searching: true, wager: 100 });
  ok(Array.isArray(a.players), '/pvp/available returns a lobby');
  ok(a.you.glory === 900, 'lobby reports my Glory');
  ok(a.tiers.includes(250), 'wager tiers exposed');

  let b = await post('/pvp/available', { wallet: 'WALLET_B', name: 'Brix', snap: snap('Dragonos', 'Fire', 11), searching: true, wager: 250 });
  a = await post('/pvp/available', { wallet: 'WALLET_A', name: 'Ayla', snap: snap('Galador', 'Water', 12), searching: true, wager: 100 });
  const matched = a.matched || b.matched;
  ok(!!matched, 'two searchers auto-matched');
  if (!matched) { server.close(); process.exit(1); }

  const matchId = matched.matchId;
  let sa = await get('/pvp/state?matchId=' + matchId + '&wallet=WALLET_A');
  let sb = await get('/pvp/state?matchId=' + matchId + '&wallet=WALLET_B');
  ok(sa.wager.stake === 100, 'stake settled at the LOWER of the two asks (100, not 250)');
  ok(sa.wager.pot === 200, 'pot is both stakes');
  ok(sa.you.hand.length === 6, 'server dealt a 6-card hand');
  ok(sa.foe.name === 'Dragonos', 'opponent identity visible');
  ok(sa.you.energy === 3, 'opening energy is 3');
  ok((await get('/claimable?wallet=WALLET_A')).gloryEscrow === 100, 'stake moved into escrow');

  console.log('\n3. playing the duel to a finish');
  let turns = 0;
  while (turns++ < 400) {
    sa = await get('/pvp/state?matchId=' + matchId + '&wallet=WALLET_A');
    sb = await get('/pvp/state?matchId=' + matchId + '&wallet=WALLET_B');
    if (sa.over) break;
    for (const [w, s] of [['WALLET_A', sa], ['WALLET_B', sb]]) {
      if (s.between || s.youSubmitted || s.over) continue;
      /* pick affordable cards, exactly like the client's toggleCard rules */
      const picks = []; let spent = 0;
      s.you.hand.forEach((c, i) => { if (picks.length < 3 && spent + c.cost <= s.you.energy) { picks.push(i); spent += c.cost; } });
      await post('/pvp/move', { matchId, wallet: w, cards: picks });
    }
    await sleep(40);
  }
  ok(sa.over === true, 'match reached a result (' + turns + ' polls)');
  ok(sa.result === 'win' || sa.result === 'lose', 'A got a verdict: ' + sa.result);
  ok(sb.result !== sa.result, 'B got the opposite verdict');
  ok(sa.score.you + sa.score.foe >= 2, 'best-of-3 series played out ' + sa.score.you + '-' + sa.score.foe);
  ok(Array.isArray(sa.lastTurn && sa.lastTurn.seq), 'replay sequence present for animation');

  console.log('\n4. wager settlement');
  const pa = await get('/claimable?wallet=WALLET_A');
  const pb = await get('/claimable?wallet=WALLET_B');
  ok(pa.gloryEscrow === 0 && pb.gloryEscrow === 0, 'escrow released on both sides');
  const winner = sa.result === 'win' ? pa : pb;
  const loser = sa.result === 'win' ? pb : pa;
  ok(loser.glory === 800, 'loser paid the 100 stake (now ' + loser.glory + ')');
  ok(winner.glory > 900, 'winner took the pot + base Glory (now ' + winner.glory + ')');
  const rake = (await get('/stats')).wagerRake;
  ok(rake === 5, '5% rake (' + rake + ' Glory) skimmed to the Cup pool');
  ok(winner.glory + loser.glory + rake === 1800 + (sa.result === 'win' ? sa.baseGlory : sb.baseGlory), 'Glory is conserved: stakes + rake + base reward balance');

  console.log('\n5. spectating');
  const spec = await get('/pvp/spectate?matchId=' + matchId);
  ok(spec.a && spec.b && spec.over === true, 'spectate view renders both fighters');

  console.log('\n6. Chikoria Cup — full 8-player double elimination');
  ok((await post('/cup/create', { wallet: 'NOTADMIN', cap: 8 })).error, 'non-admin cannot create a Cup');
  ok((await post('/cup/create', { wallet: 'ADMINWALLET', cap: 8 })).ok, 'admin created an 8-player Cup');
  await post('/cup/public', { wallet: 'ADMINWALLET', public: true });
  const reg = await post('/cup/register', { wallet: 'WALLET_A', snap: snap('Galador', 'Water', 12) });
  ok(reg.ok, 'player registered');
  ok(reg.gloryLeft === winner.glory - 100 || reg.gloryLeft === loser.glory - 100, '100 Glory entry fee charged');
  ok((await post('/cup/register', { wallet: 'WALLET_A', snap: snap('Galador', 'Water', 12) })).error, 'double registration refused');
  const filled = await post('/cup/fill', { wallet: 'ADMINWALLET' });
  ok(filled.added === 7, 'lobby topped up with 7 bots');
  ok((await post('/cup/start', { wallet: 'ADMINWALLET' })).ok, 'Cup started');

  let st = await get('/cup/status?wallet=WALLET_A');
  ok(st.status === 'live', 'status is live');
  ok(st.bracket && st.bracket.rounds.length > 0, 'bracket built (' + st.bracket.rounds.map(r => r.key).join(',') + ')');
  ok(st.round === 'WB1', 'opens on WB1');

  let guard = 0;
  while (st.status === 'live' && guard++ < 30) {
    const sr = await post('/cup/resolve-round', { wallet: 'ADMINWALLET' });
    if (sr.error) { console.log('    resolve error:', sr.error); break; }
    st = await get('/cup/status?wallet=WALLET_A');
  }
  ok(st.status === 'finished', 'Cup ran to completion in ' + guard + ' rounds');
  ok(!!st.champion, 'champion crowned: ' + st.champion);
  ok(st.results && st.results.length === 8, 'full standings for all 8 entrants');
  const champRow = st.results[0];
  const champIsBot = !st.entrants.find(e => e.wallet === champRow.wallet && !e.bot);
  ok(champIsBot ? champRow.sol === 0 : champRow.sol === 1,
     champIsBot ? 'bot champion correctly paid 0 SOL' : 'human champion paid 1 SOL');
  const humanRow = st.results.find(r => r.wallet === 'WALLET_A');
  ok(humanRow && humanRow.sol > 0, 'the human entrant was paid for placing #' + (humanRow && humanRow.place));
  ok(new Set(st.results.map(r => r.place)).size === 8, 'every place is distinct');
  const keys = st.bracket.rounds.map(r => r.key);
  ok(keys.includes('WF') && keys.includes('LF') && keys.includes('GF'),
     'bracket ran through Winners Final, Losers Final and Grand Final (' + keys.join(',') + ')');
  ok(st.bracket.rounds.every(r => r.state === 'done'), 'every round finished');
  ok(!!st.bracket.champion, 'bracket carries the champion');
  console.log('    standings: ' + st.results.map(r => r.place + '.' + r.name + ' ' + r.sol + '◎').join(' · '));

  console.log('\n7. chat + leaderboard');
  ok((await post('/cup/chat', { wallet: 'WALLET_A', name: 'Ayla', text: 'gg!' })).ok, 'chat posts');
  ok((await get('/cup/chat')).messages.some(m => m.text === 'gg!'), 'chat reads back');
  const lb = await get('/leaderboard');
  ok(Array.isArray(lb.champions) && lb.champions.length > 0, 'PvP leaderboard populated');

  console.log('\n8. abuse guards');
  ok((await get('/pvp/state?matchId=nope&wallet=WALLET_A')).error, 'unknown match rejected');
  ok((await get('/pvp/state?matchId=' + matchId + '&wallet=STRANGER')).error, 'outsider cannot read a match');
  ok((await post('/pvp/move', { matchId, wallet: 'STRANGER', cards: [0] })).error, 'outsider cannot submit moves');
  ok((await post('/admin/ban', { adminWallet: 'ADMINWALLET', authMsg: 'x', authSig: 'y', target: 'Z' })).error, 'ban needs a valid signature');

  console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
