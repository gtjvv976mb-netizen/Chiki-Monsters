# Chiki Monsters Backend (scaffold)

Server-side rails for going live: holder snapshots, reward-pool status, single-wallet balance checks, and a guarded custodial payout endpoint.

## Setup

```bash
npm install
cp .env.example .env   # then fill it in
npm start
```

Fill `.env` with your **MINT** (the $CHIKI address from pump.fun), a free **HELIUS_KEY** (helius.dev), and — only when you're ready for payouts — a dedicated reward wallet's base58 **REWARD_SECRET** plus `PAYOUTS_ENABLED=true`.

## Endpoints

`GET /holders` — every wallet holding ≥ MIN_HOLD, cached 2 minutes (Helius). This is what the game will read to spawn everyone's Chikis for real.
`GET /balance/:wallet` — live balance + eligibility for one wallet.
`GET /pool` — reward wallet's SOL balance (your creator-fee pool after you claim fees from pump.fun into it).
`POST /claim` `{wallet, amountSol}` — sends SOL from the reward wallet. Hard-capped at 1 SOL per claim and disabled unless `PAYOUTS_ENABLED=true`.

## Wiring the game to it

In `play.html`, set `CHAIN.BACKEND` to this server's URL. (The Phantom connect + balance check already work without the backend — direct RPC.)

## ⚠️ Before real money

The `/claim` endpoint is a scaffold. Before enabling payouts you must: (1) run the game simulation **server-side** and store per-wallet earnings in a database — never accept amounts from the browser; (2) verify wallet ownership on claims (sign a server nonce, verify with tweetnacl); (3) add rate limits and keep only limited funds in the reward wallet. Treat the reward secret like cash.

## Hosting

Any Node host works: Railway, Render, Fly.io (free tiers), or a $5 VPS. Set the env vars in the host's dashboard rather than uploading `.env`.
