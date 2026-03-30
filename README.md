# DBC Custodian UI

A management UI for fee claiming and fee distribution across **DBC** (Dynamic Bonding Curve) pools and **DAMM v2** (CP-AMM) pools on Solana.

## Getting Started

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture Overview

This UI interacts with a custom Solana program (`2VgCjezWK4kHxoute1Jy986AXVPvSkwquPX5VBVwQMzV`) that acts as a **custodian** sitting between Meteora pools and fee recipients.

The three core program IDs used throughout [`lib/custodian.tsx`](lib/custodian.tsx):

| Constant | Address | Purpose |
|---|---|---|
| `MY_DBC_CUSTODIAN_PROGRAM_ID` | `2VgCjez...` | This custodian program |
| `DBC_PROGRAM_ID` | `dbcij3L...` | Meteora Dynamic Bonding Curve |
| `DAMMV2_PROGRAM_ID` | `cpamdpZ...` | Meteora CP-AMM (DAMM v2) |

---

## Critical Concept — Fee Claimer PDA

When creating a DBC config and pool (see [`lib/createConfigAndPool.tsx`](lib/createConfigAndPool.tsx)), the `feeClaimer` field **must** be set to the custodian's `fee_claimer` PDA — not a wallet address.

**Why this matters:**
- This PDA is the program-owned authority that receives and controls all fees.
- For DAMM v2, this same PDA holds the LP position NFT after migration.
- If `feeClaimer` is set to any other address during pool creation, the entire fee flow breaks permanently.

**How it is derived** ([`lib/custodian.tsx:56`](lib/custodian.tsx#L56)):

```ts
export function deriveFeeClaimerPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_claimer')],
    MY_DBC_CUSTODIAN_PROGRAM_ID,
  );
  return pda;
}
```

This is called automatically in [`lib/createConfigAndPool.tsx:56`](lib/createConfigAndPool.tsx#L56) — you do not need to derive it manually.

---

## UI Functions Reference

The UI groups functions into three sections, each color-coded.

### View (Cyan) — Read-only, no wallet required

| # | Function | Code Reference |
|---|---|---|
| 1A | View Pool Info | [`viewPoolClaimers`](lib/custodian.tsx#L138) |
| 1B | View Fee Vault Balances | [`viewFeeVaultBalances`](lib/custodian.tsx#L250) |
| 1C | Vault All Token Info | [`viewVaultAllTokenInfo`](lib/custodian.tsx#L357) |

### Non-Admin (Violet) — Permissionless, wallet required

| # | Function | Code Reference |
|---|---|---|
| 2A | Create Config & Pool | [`createConfigAndPool`](lib/createConfigAndPool.tsx#L37) |
| 2B | Claim DBC Partner Trading Fee | [`claimDbcPartnerFee`](lib/custodian.tsx#L504) |
| 2C | Claim DAMM v2 Position Fee | [`claimDammV2PositionFee`](lib/custodian.tsx#L670) |
| 2D | Distribute Fees | [`distributeFees`](lib/custodian.tsx#L734) |

### Admin (Rose) — Admin wallet only

| # | Function | Code Reference |
|---|---|---|
| 3A | Set Pool Claimers | [`setPoolClaimers`](lib/custodian.tsx#L442) |
| 3B | Update Claimers BPS | [`updateClaimersBps`](lib/custodian.tsx#L474) |

---

## DBC Fee Flow

After a DBC pool is created with the correct `feeClaimer` PDA, follow these steps to collect and distribute fees.

### Step 1 — Initialize Pool Claimers (3A)

> Admin only. Run once per pool.

- Enter the DBC pool address.
- Select **DBC** as pool mode.
- Add each fee recipient with their wallet address and BPS share.
- Total BPS **must equal 10,000** (10,000 BPS = 100%).

This creates a `PoolClaimers` PDA derived from the pool address ([`lib/custodian.tsx:48`](lib/custodian.tsx#L48)):

```ts
export function derivePoolClaimersPda(pool: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_claimers'), pool.toBuffer()],
    MY_DBC_CUSTODIAN_PROGRAM_ID,
  );
  return pda;
}
```

### Step 2 — Claim DBC Partner Trading Fee (2B)

> Permissionless. Anyone can call this at any time.

- Enter the DBC pool address.
- This sweeps all accrued partner trading fees from the DBC pool into the program's PDA-owned **fee vaults**.
- The fee vaults are program-derived accounts, one per token per pool ([`lib/custodian.tsx:64`](lib/custodian.tsx#L64)).

### Step 3 — Distribute Fees (2D)

> Permissionless. Can be called by anyone after fees have been claimed into the vaults.

- Enter the pool address and select **DBC** as pool mode.
- Proportionally distributes all fee vault balances to registered claimers based on their BPS.
- If claimer ATAs do not exist yet, a setup transaction runs first, then the distribution.

### Optional — View & Verify

Use the read-only functions at any time to inspect state:

- **1A** — Check which claimers are registered and their BPS for a pool.
- **1B** — Check the current balance of fee vaults before or after claiming.

---

## DAMM v2 Fee Flow

DAMM v2 is more involved than DBC. When a DBC pool migrates, it becomes a DAMM v2 CP-AMM pool. The custodian's `fee_claimer` PDA receives the LP position NFT and acts as the LP on that pool.

### Step 1 — Discover Positions (1C)

Call **1C — Vault All Token Info** (no inputs needed).

This scans all token accounts owned by the `fee_claimer` PDA, identifies LP position NFTs by filtering for NFTs with `decimals = 0` and `amount = 1`, then resolves each position's pool, token mints, and unclaimed fees ([`lib/custodian.tsx:357`](lib/custodian.tsx#L357)).

Example response:

```json
{
  "vaultPubkey": "7pjeaJ6pY1542iL2k6bqWzNTg3cgTamRCACQPZb7S3R2",
  "totalPositions": 2,
  "positions": [
    {
      "pool": "EZN6M1gDeFAdKKoovvEBXdwAY5jt1UQ9WNoddSRMmWq5",
      "position": "C8hn5NZnSEgkNrJqNBS1d2dCArifQDnD5ZDJPtsTiTza",
      "positionNftAccount": "2YK3hC8y1UVM3oABpgSWLoJsWh4qCtbYQAgJopCTYPUj",
      "positionNftMint": "8qHf5BzGQ5MKVurWzzQooUQGYGYMQLaTV77PXjkPWs3Z",
      "tokenAMint": "FWknwCJx4cxFxnDjvKuzKxE6KrSfdMB4tNnEqcMZ4gto",
      "tokenBMint": "So11111111111111111111111111111111111111112",
      "unclaimedFeeA": "0",
      "unclaimedFeeB": "0",
      "tokenAName": "X402MonopolyOrder",
      "tokenBName": "Solana"
    },
    {
      "pool": "DhYAVozRqXJiWrquTh5TzqGsdQRPY9hPPUYi9HmRuLZE",
      "position": "3eus5HgcrcjGbxHb51mSBGTrdD3TeJaBSquQsrBwmQAb",
      "positionNftAccount": "Dqg2yG149AT6Jt8KMqnWicdRHAwtQJCnHu7ZBdbYZaJi",
      "positionNftMint": "GCJxyACE9N5XHSJAh4wZcE5n1qBopdtnf6qytP6pwtrN",
      "tokenAMint": "Cy3uQBoDgi2jcEbbKtC379iZR1Uqqf6mkNa7Ku4D9SXB",
      "tokenBMint": "So11111111111111111111111111111111111111112",
      "unclaimedFeeA": "0",
      "unclaimedFeeB": "0",
      "tokenAName": "My test token 2",
      "tokenBName": "Solana"
    }
  ]
}
```

Pick the pool you want to work with and note down two values:

- **`pool`** — needed for steps 2 and 4.
- **`positionNftMint`** — needed for step 3.

### Step 2 — Initialize Pool Claimers (3A)

> Admin only. Run once per pool.

Same as DBC. Use the `pool` address from the 1C response.

- Select **DAMM v2** as pool mode.
- Enter claimer addresses and BPS shares. Total must equal **10,000 BPS**.

Example pool address to use: `DhYAVozRqXJiWrquTh5TzqGsdQRPY9hPPUYi9HmRuLZE`

### Step 3 — Claim DAMM v2 Position Fees (2C)

> Permissionless.

Call **2C — Claim DAMM v2 Position Fee**.

- Paste the `positionNftMint` from the 1C response for the position you want to claim.
- The function resolves everything else (pool, position, vaults, token programs) on-chain automatically ([`lib/custodian.tsx:670`](lib/custodian.tsx#L670)).
- Fees flow from the DAMM v2 pool position into the program's fee vaults.

Example NFT mint to paste: `GCJxyACE9N5XHSJAh4wZcE5n1qBopdtnf6qytP6pwtrN`

### Step 4 — Distribute Fees (2D)

> Permissionless. Identical to the DBC distribute step.

- Enter the pool address (same `pool` from 1C).
- Select **DAMM v2** as pool mode.
- Fee vault balances are split proportionally to all claimers.

---

## PDA Reference

All PDAs are derived inside [`lib/custodian.tsx`](lib/custodian.tsx):

| PDA | Seeds | Description |
|---|---|---|
| `fee_claimer` | `["fee_claimer"]` | Vault authority — holds position NFTs, signs fee claims |
| `pool_claimers` | `["pool_claimers", pool]` | Per-pool claimer registry with BPS splits |
| `fee_vault` | `["fee_vault", pool, mint]` | Per-pool per-token fee accumulator vault |

---

## BPS Reference

All fee shares are expressed in **Basis Points (BPS)**:

| BPS | Percentage |
|---|---|
| 10,000 | 100% |
| 5,000 | 50% |
| 2,500 | 25% |
| 100 | 1% |

The total BPS across all claimers for a pool must always equal **10,000**.
