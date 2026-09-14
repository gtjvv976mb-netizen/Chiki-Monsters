# Chikoria backend

The server behind **Chikiseum live PvP**, **Glory wagers** and the **Chikoria Cup**
in `play.html`. Every route here is one the shipped client already calls, with the
exact response shapes its fetch handlers read.

```bash
cd chiki-backend
npm install
npm start          # listens on :3000
npm test           # end-to-end: plays a wagered duel + a full 8-player Cup
```

Then point the game at it — in `play.html`:

```js
const CHAIN = { …, BACKEND: "https://your-host.example.com", … };
```

You can also override it per-session without editing the file, which is handy for
testing against a local server: `play.html?backend=http://localhost:3000`.

## How a duel works

Combat is **server-authoritative**. The client never decides damage in a live match:

1. Both players poll `GET /pvp/state`. The server has already dealt each a 6-card
   hand and started a 60-second turn clock.
2. Each posts `POST /pvp/move` with **hand indices only** — never card contents.
   Submissions are clamped by `engine.sanitizeQueue` (real indices, ≤3 cards,
   within energy), so a modified client gets its illegal picks dropped rather
   than honoured.
3. Once both have locked in (or the deadline passes and the server auto-plays for
   whoever went idle), the turn resolves and the result is published as
   `lastTurn.seq` — a step-by-step replay the client animates.
4. First to 2 games wins the best-of-3.

`src/engine.js` is a faithful port of the rules in `play.html` (same `TVAL`
tables, element triangle, crit/Last Stand/shield-pierce maths). **If you tune one,
tune the other** — otherwise replays will not match what players see on screen.

## Wagers

Both sides pick a stake from `[0, 25, 50, 100, 250, 500]` ✨ Glory.

- The match is played for the **lower of the two asks**, further capped by what
  each player can actually cover. Nobody is ever staked beyond their balance.
- Both stakes move into **escrow** at match creation, so the same Glory cannot be
  wagered in two places or spent on Cup entry mid-duel.
- The winner takes the pot minus a **5% rake**, which funds the Cup prize pool.
- Forfeits and disconnects settle in the opponent's favour — an idle player is
  auto-played first, then forfeited after ~35s of no polling.
- A crash mid-match cannot strand Glory: `recoverEscrow()` releases all escrow on
  boot, since no match survives a restart.

Glory is conserved end to end — the smoke test asserts it.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /pvp/available` | Lobby presence, challenge inbox, auto-match handoff, your wager/Glory |
| `POST /pvp/queue` | Legacy pairing queue (the client's fallback path) |
| `POST /pvp/cancel` | Stop searching |
| `POST /pvp/challenge` `/accept` `/decline` | Direct challenges with a stake |
| `GET /pvp/state` | Your view of a match (hand, HP, timer, series, replay, stake) |
| `POST /pvp/move` | Lock in up to 3 cards |
| `POST /pvp/forfeit` | Concede |
| `GET /pvp/spectate` | Public read-only view of any live match |
| `GET /cup/status` | Tournament state + double-elimination bracket |
| `POST /cup/register` `/ready` | Player entry (costs 100 ✨) |
| `POST /cup/create` `/resize` `/fill` `/start` `/public` `/auto` | Admin lobby control |
| `POST /cup/start-round` `/finalize-round` `/resolve-round` | Admin round control |
| `GET`/`POST /cup/chat` | Arena chat |
| `GET`/`POST /presence`, `/stats`, `/leaderboard`, `/feed`, `/profile`, `/verify`, `/claimable`, `/claim`, `/allchikis` | World + economy routes the game already polls |
| `POST /admin/ban` `/unban` `/gift-chiki` `/grant-glory` | Signature-authenticated admin |

## The Cup

Generic double elimination, padded to the next power of two with byes, using the
round keys the client's `renderBracket` expects: `WB1…WB3`, `WF`, `LB1…LB5`, `LF`,
`GF`. Lobby sizes 8 / 10 / 16.

Prizes scale a per-size weight table to `CUP_PRIZE_SOL` (default 4 SOL, 1 SOL to
the champion) and land in each winner's pouch. **Bots and banned wallets are
always paid 0.** In `auto` mode the server starts and finalises every round on its
own; otherwise an admin drives it.

## Identity

Every route that moves value requires proof that the caller controls the wallet
it claims. The client signs one timestamped message with Phantom:

```
Chikoria sign-in
wallet:<pubkey>
ts:<ms>
nonce:<random>
```

`POST /auth/login` verifies the ed25519 signature and returns a bearer token
(7 days by default). Signatures older than 5 minutes are refused, and each is
accepted once — a captured signature cannot be replayed.

Gated: `/pvp/available`, `/queue`, `/cancel`, `/challenge*`, `/state`, `/move`,
`/forfeit`, `/profile`, `/cup/register`, `/cup/ready`, `/cup/chat`. `/pvp/state`
is in that list because the response contains your hand. Reads that leak nothing
(`/cup/status`, `/leaderboard`, `/stats`, `/pvp/spectate`) stay public.

`REQUIRE_AUTH=false` disables enforcement. It exists to recover from a bad
rollout — a cached old client that cannot sign in yet — and should not be left
off, because it restores the impersonation hole.

Admin routes are separate and stricter: they need a fresh signature *per call*,
not a session token.

## Glory, and why some of it is "verified"

Glory earned against the AI ladder happens entirely in the browser, so the
server cannot check it. Rather than trust or discard it, it is metered:

- A wallet is **bootstrapped once** from whatever its save reports, so existing
  players keep their progress.
- After that, client-reported Glory may only climb at `CLIENT_GLORY_PER_HOUR`
  (default 300, burst 600). A save claiming 999,999 gains a few hundred.
- `gloryVerified` tracks only what the **server itself** awarded: PvP wins and
  wager winnings. It moves with wager settlements in both directions.

**Cup entry must be paid from `gloryVerified`** (`CUP_REQUIRE_VERIFIED_GLORY`,
default on). This is the important one: the Cup pays real SOL, so without it a
forged local save would convert straight into a payout. Turning it off is only
safe while prizes are off.

One consequence worth knowing: the server reports `glory: 0` for a wallet it has
never seen. The client must **not** adopt that — it pushes its save up first and
only pulls once `you.bootstrapped` is true. Getting this backwards wipes a
returning player's Glory and then persists the wipe; there is a regression test
for it.

## Other notes

- **Payouts are off unless you configure them.** Without `TREASURY_SECRET`,
  `/claim` returns 503 rather than pretending to pay. Only set it on a host you
  control, and keep `DAILY_CLAIM_CAP_SOL` low.
- A client-reported Glory figure is ignored entirely while a wager is escrowed,
  or within 120s of any server-side settlement — a stale tab cannot undo a
  wager it just lost.

## Storage

One JSON file (`DATA_DIR/chikoria.json`), written atomically on a 2s debounce and
flushed on `SIGTERM`/`SIGINT`. Profiles, Glory, bans, feed and Cup results persist;
in-flight matches deliberately do not. Mount a disk at `DATA_DIR` in production —
on an ephemeral filesystem, Glory resets on every redeploy.

Deploy configs are included: **`render.yaml` at the repository root** (Render only
reads a Blueprint from the repo root — it points back here via `rootDir`), and a
`Dockerfile` in this folder for anything else.
