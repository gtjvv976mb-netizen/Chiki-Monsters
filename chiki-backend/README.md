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

## Security notes — read before deploying

- **Player identity is an unsigned wallet string.** `/pvp/move` and friends trust
  the `wallet` field because that is what the shipped client sends. Anyone who
  knows another player's address can act as them. Fixing this properly means
  having the client sign a login message (the admin routes already do exactly
  that — see `verifyAdmin`) and issuing a session token. Do that before real
  value rides on wagers.
- **Cup admin routes are gated on the wallet list only**, matching what the client
  sends. The destructive routes (`/admin/ban`, `/admin/gift-chiki`,
  `/admin/grant-glory`) require a real ed25519 signature over a timestamped
  message and reject anything older than 5 minutes.
- **Payouts are off unless you configure them.** Without `TREASURY_SECRET`,
  `/claim` returns 503 rather than pretending to pay. Only set it on a host you
  control, and keep `DAILY_CLAIM_CAP_SOL` low.
- Glory the client reports is only ever allowed to *raise* the server's number,
  and never while a wager is escrowed — a stale browser tab cannot wipe a stake.

## Storage

One JSON file (`DATA_DIR/chikoria.json`), written atomically on a 2s debounce and
flushed on `SIGTERM`/`SIGINT`. Profiles, Glory, bans, feed and Cup results persist;
in-flight matches deliberately do not. Mount a disk at `DATA_DIR` in production —
on an ephemeral filesystem, Glory resets on every redeploy.

Deploy configs are included: **`render.yaml` at the repository root** (Render only
reads a Blueprint from the repo root — it points back here via `rootDir`), and a
`Dockerfile` in this folder for anything else.
