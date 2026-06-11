/* Chiki Monsters backend — holder snapshots, pool status, custodial payouts.
   Endpoints:
     GET  /holders   -> cached list of wallets holding >= MIN_HOLD $CHIKI
     GET  /pool      -> reward wallet SOL balance
     GET  /balance/:wallet -> live $CHIKI balance for one wallet
     POST /claim     -> { wallet, amountSol } custodial payout (guarded)
   Security notes:
     - The reward secret key lives ONLY in .env on the server.
     - PAYOUTS_ENABLED must be "true" for /claim to move funds.
     - Before production: add signature verification (the claimer signs a
       nonce with their wallet) and a real earnings ledger (DB) so amounts
       come from YOUR records, never from the client. */
import "dotenv/config";
import express from "express";
import cors from "cors";
import bs58 from "bs58";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL
} from "@solana/web3.js";

const {
  MINT = "", HELIUS_KEY = "", MIN_HOLD = "500000",
  REWARD_SECRET = "", PAYOUTS_ENABLED = "false", PORT = "8787"
} = process.env;

const RPC = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");
const minHold = Number(MIN_HOLD);
const rewardKp = REWARD_SECRET ? Keypair.fromSecretKey(bs58.decode(REWARD_SECRET)) : null;

const app = express();
app.use(cors());
app.use(express.json());

/* ---------- holder snapshot (Helius getTokenAccounts, cached 2 min) ---------- */
let holderCache = { at: 0, list: [] };
async function snapshotHolders() {
  if (!MINT) throw new Error("MINT not configured");
  if (!HELIUS_KEY) throw new Error("HELIUS_KEY required for holder snapshots");
  const byOwner = new Map();
  let cursor = undefined;
  for (let page = 0; page < 50; page++) {           // safety cap
    const body = {
      jsonrpc: "2.0", id: "1", method: "getTokenAccounts",
      params: { mint: MINT, limit: 1000, ...(cursor ? { cursor } : {}) }
    };
    const r = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    const accs = j.result?.token_accounts ?? [];
    for (const a of accs) {
      const amt = Number(a.amount) / 1e6;           // pump.fun tokens: 6 decimals
      byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0) + amt);
    }
    cursor = j.result?.cursor;
    if (!cursor || accs.length === 0) break;
  }
  return [...byOwner.entries()]
    .filter(([, amt]) => amt >= minHold)
    .map(([owner, amount]) => ({ owner, amount: Math.floor(amount) }))
    .sort((a, b) => b.amount - a.amount);
}

app.get("/holders", async (_req, res) => {
  try {
    if (Date.now() - holderCache.at > 120_000) {
      holderCache = { at: Date.now(), list: await snapshotHolders() };
    }
    res.json({ minHold, count: holderCache.list.length, holders: holderCache.list });
  } catch (e) { res.status(500).json({ error: String(e.message ?? e) }); }
});

/* ---------- live balance for one wallet ---------- */
app.get("/balance/:wallet", async (req, res) => {
  try {
    if (!MINT) throw new Error("MINT not configured");
    const owner = new PublicKey(req.params.wallet);
    const accs = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(MINT) });
    let amount = 0;
    for (const { account } of accs.value)
      amount += account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    res.json({ wallet: req.params.wallet, amount: Math.floor(amount), eligible: amount >= minHold });
  } catch (e) { res.status(500).json({ error: String(e.message ?? e) }); }
});

/* ---------- reward pool status ---------- */
app.get("/pool", async (_req, res) => {
  try {
    if (!rewardKp) return res.json({ configured: false, sol: 0 });
    const lamports = await conn.getBalance(rewardKp.publicKey);
    res.json({ configured: true, wallet: rewardKp.publicKey.toString(), sol: lamports / LAMPORTS_PER_SOL });
  } catch (e) { res.status(500).json({ error: String(e.message ?? e) }); }
});

/* ---------- custodial payout (guarded scaffold) ----------
   TODO before real money:
   1. Earnings ledger: store per-wallet accrued SOL in a DB, written by YOUR
      authoritative game simulation — never trust amounts from the client.
   2. Auth: require the claimer to sign a server nonce with their wallet and
      verify it here (tweetnacl) before paying.
   3. Rate limits, max-per-claim, and alerting. */
app.post("/claim", async (req, res) => {
  try {
    if (PAYOUTS_ENABLED !== "true") return res.status(403).json({ error: "Payouts disabled" });
    if (!rewardKp) return res.status(500).json({ error: "Reward wallet not configured" });
    const { wallet, amountSol } = req.body ?? {};
    const amt = Number(amountSol);
    if (!wallet || !Number.isFinite(amt) || amt <= 0 || amt > 1)   // hard cap 1 SOL/claim in scaffold
      return res.status(400).json({ error: "Invalid claim" });
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: rewardKp.publicKey,
      toPubkey: new PublicKey(wallet),
      lamports: Math.round(amt * LAMPORTS_PER_SOL)
    }));
    const sig = await sendAndConfirmTransaction(conn, tx, [rewardKp]);
    res.json({ ok: true, signature: sig });
  } catch (e) { res.status(500).json({ error: String(e.message ?? e) }); }
});

app.listen(Number(PORT), () =>
  console.log(`Chiki backend on :${PORT} | mint=${MINT || "(unset)"} | payouts=${PAYOUTS_ENABLED}`));
