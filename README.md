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
| 1A | View Pool Info | [`viewPoolClaimers`](lib/custodian.tsx#L215) |
| 1B | View Fee Vault Balances | [`viewFeeVaultBalances`](lib/custodian.tsx#L383) |
| 1C | Vault All Token Info | [`viewVaultAllTokenInfo`](lib/custodian.tsx#L490) |
| 1D | Claimer Pool Info | [`viewClaimerPoolInfo`](lib/custodian.tsx#L276) |

### Non-Admin (Violet) — Permissionless, wallet required

| # | Function | Code Reference |
|---|---|---|
| 2A | Create Config & Pool | [`createConfigAndPool`](lib/createConfigAndPool.tsx#L37) — new DBC config + pool; see below |
| 2B | Claim DBC Partner Trading Fee | [`claimDbcPartnerFee`](lib/custodian.tsx#L794) |
| 2C | Claim DAMM v2 Position Fee | [`claimDammV2PositionFee`](lib/custodian.tsx#L960) |
| 2D | Distribute Fees | [`distributeFees`](lib/custodian.tsx#L1047) |
| 2E | Claim + Distribute DBC Fees (One Tx) | [`claimAndDistributeFeesDbc`](lib/custodian.tsx#L1141) |
| 2F | Claim + Distribute DAMM v2 Fees (One Tx) | [`claimAndDistributeFeesDammV2`](lib/custodian.tsx#L1280) |

### Admin (Rose) — Admin wallet only

| # | Function | Code Reference |
|---|---|---|
| 3A | Set Pool Claimers | [`initializePoolClaimers`](lib/custodian.tsx#L575) |
| 3B | Update Claimers BPS | [`updateClaimersBps`](lib/custodian.tsx#L636) |
| 3C | Admin Locked Amount Withdraw | [`adminSweepClaimer`](lib/custodian.tsx#L695) |
| 3D | Set Claim Status | [`setClaimerEnabled`](lib/custodian.tsx#L665) |

#### 2A — Create Config & Pool (details)

Creates a new **DBC config** and **DBC pool** in one flow. Config and base mint keypairs are generated automatically ([`lib/createConfigAndPool.tsx`](lib/createConfigAndPool.tsx)). The UI asks for **Migration Quote Threshold (SOL)**, **Token Name**, **Token Symbol**, and **Token URI**. The custodian `feeClaimer` PDA is wired in during pool creation as documented above.

#### 1D — Claimer Pool Info (details)

Read-only. Loads the **`ClaimerState`** PDA for a given **pool** and **claimer** wallet: **`isEnabled`**, **`claimedBase`**, **`claimedQuote`** ([`viewClaimerPoolInfo`](lib/custodian.tsx#L276)). Use this to confirm a claimer is enabled for live payouts or to inspect cumulative claimed amounts per claimer (complements **1A**, which lists all claimers on the pool).

#### 3C — Admin Locked Amount Withdraw (details)

Admin-only. Sweeps tokens from a registered claimer’s **pending base / pending quote** vaults into a **recipient**’s ATAs. Pending vaults hold funds that were **parked** during **`distributeFees`** when a claimer cannot receive directly (for example, a **disabled** claimer per **3D**). The program may send a first transaction to create the recipient’s ATAs, then the sweep ([`adminSweepClaimer`](lib/custodian.tsx#L695)). Inputs: **pool**, **DBC / DAMM v2** mode, **claimer** (registered pubkey whose pending vaults are swept), **recipient** (destination wallet).

#### 3D — Set Claim Status (details)

Admin-only. Sets **`isEnabled`** on a claimer’s **`ClaimerState`**. **Enabled** claimers receive their BPS share from fee vaults into their **ATAs** during **`distributeFees`**. **Disabled** claimers have their share routed to **pending** vaults instead; an admin can later move those tokens with **3C** ([`setClaimerEnabled`](lib/custodian.tsx#L665)).

#### 2D — Distribute Fees (details)

Permissionless. Proportionally splits **base** and **quote** fee vault balances to registered claimers by BPS ([`distributeFees`](lib/custodian.tsx#L1047)). The implementation may use **two transactions**: first, idempotent creation of **claimer ATAs** if any are missing (`ataTx` in the UI result); second, **`distributeFees`** with **remaining accounts** per claimer (claimer state, pending vaults, claimer ATAs). Claimers who are **disabled** do not receive to ATAs in the same way; their share accrues in **pending** vaults for **3C**.

#### 2E — Claim + Distribute DBC Fees (One Tx) (details)

Permissionless. End-user convenience function that combines **2B** and **2D** into a **single transaction requiring one wallet signature** ([`claimAndDistributeFeesDbc`](lib/custodian.tsx#L1141)).

The single transaction contains, in order:
1. `claimPartnerTradingFee` — sweeps accrued DBC partner fees into the program's fee vaults.
2. Idempotent ATA creation instructions for each registered claimer (base + quote token accounts).
3. `distributeFees` — proportionally splits vault balances to all enabled claimers by BPS.

Input: **DBC pool address** only. The function validates the pool is owned by `DBC_PROGRAM_ID`, fetches on-chain pool and claimer state, builds all instructions, and sends as one atomic transaction. Disabled claimers still have their share routed to pending vaults (same behaviour as **2D** / **3D** / **3C**).

#### 2F — Claim + Distribute DAMM v2 Fees (One Tx) (details)

Permissionless. End-user convenience function that combines **2C** and **2D** into a **single transaction requiring one wallet signature** ([`claimAndDistributeFeesDammV2`](lib/custodian.tsx#L1280)).

The single transaction contains, in order:
1. `claimPositionFee` — claims LP position fees from the DAMM v2 pool into the program's fee vaults. The vault-owned position NFT for the supplied pool is resolved automatically (same logic as **2C**).
2. Idempotent ATA creation instructions for each registered claimer (base + quote token accounts).
3. `distributeFees` — proportionally splits vault balances to all enabled claimers by BPS.

Input: **DAMM v2 pool address** only. Disabled claimers still have their share routed to pending vaults (same behaviour as **2D** / **3D** / **3C**).

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
- Proportionally distributes fee vault balances to registered claimers by BPS. **Enabled** claimers receive to their ATAs; **disabled** claimers (see **3D**) accrue into **pending** vaults instead.
- If any claimer ATAs are missing, the UI may confirm an **ATA creation** transaction first, then **`distributeFees`** (see **2D** details above).

### Optional — View & Verify

Use the read-only functions at any time to inspect state:

- **1A** — Check which claimers are registered and their BPS for a pool.
- **1B** — Check the current balance of fee vaults before or after claiming.
- **1D** — Inspect a single claimer’s **`ClaimerState`** (enabled flag and cumulative claimed base/quote).

---

## DAMM v2 Fee Flow

DAMM v2 is more involved than DBC. When a DBC pool migrates, it becomes a DAMM v2 CP-AMM pool. The custodian's `fee_claimer` PDA receives the LP position NFT and acts as the LP on that pool.

### Step 1 — Discover Positions (1C)

Call **1C — Vault All Token Info** (no inputs needed).

This scans all token accounts owned by the `fee_claimer` PDA, identifies LP position NFTs by filtering for NFTs with `decimals = 0` and `amount = 1`, then resolves each position's pool, token mints, and unclaimed fees ([`viewVaultAllTokenInfo`](lib/custodian.tsx#L490)).

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

Pick the pool you want to work with and note **`pool`** — it is used for **3A**, **2C** (claim), and **2D** (distribute). **`positionNftMint`** remains useful for cross-checking which NFT belongs to which row in **1C**.

### Step 2 — Initialize Pool Claimers (3A)

> Admin only. Run once per pool.

Same as DBC. Use the `pool` address from the 1C response.

- Select **DAMM v2** as pool mode.
- Enter claimer addresses and BPS shares. Total must equal **10,000 BPS**.

Example pool address to use: `DhYAVozRqXJiWrquTh5TzqGsdQRPY9hPPUYi9HmRuLZE`

### Step 3 — Claim DAMM v2 Position Fees (2C)

> Permissionless.

Call **2C — Claim DAMM v2 Position Fee**.

- Enter the **DAMM v2 pool address** (the same `pool` value from **1C** for that position). The custodian vault’s position NFT for that pool is resolved automatically ([`claimDammV2PositionFee`](lib/custodian.tsx#L960)).
- Fees flow from the DAMM v2 position into the program’s fee vaults.

### Step 4 — Distribute Fees (2D)

> Permissionless. Same behavior as the DBC distribute step (ATA setup may precede **`distributeFees`**; **3D** / pending vaults apply as in **2D** details).

- Enter the pool address (same `pool` from 1C).
- Select **DAMM v2** as pool mode.
- Fee vault balances are split per BPS to **enabled** claimers; **disabled** claimers use **pending** vaults (**3C** / **3D**).

---

## PDA Reference

All PDAs are derived inside [`lib/custodian.tsx`](lib/custodian.tsx):

| PDA | Seeds | Description |
|---|---|---|
| `fee_claimer` | `["fee_claimer"]` | Vault authority — holds position NFTs, signs fee claims |
| `pool_claimers` | `["pool_claimers", pool]` | Per-pool claimer registry with BPS splits |
| `fee_vault` | `["fee_vault", pool, mint]` | Per-pool per-token fee accumulator vault |
| `claimer_state` | `["claimer_state", pool, claimer]` | Per-claimer flags and cumulative claimed amounts |
| `claimer_pending_base` | `["claimer_pending_base", pool, claimer]` | Pending base token balance for a claimer (e.g. disabled payout) |
| `claimer_pending_quote` | `["claimer_pending_quote", pool, claimer]` | Pending quote token balance for a claimer |

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
