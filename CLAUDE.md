# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev          # webpack dev server (default — use this)
npm run dev:turbo    # turbopack dev server (experimental)
npm run build        # production build
npm run lint         # eslint
```

No test suite exists. Type-check manually with:
```bash
npx tsc --noEmit
```
Ignore errors inside `deps/damm-v2/tests/` — those are pre-existing and unrelated to the UI.

## RPC / Environment

RPC endpoints are configured in `app/providers.tsx`. Override via env vars:
- `NEXT_PUBLIC_RPC_DEVNET`
- `NEXT_PUBLIC_RPC_MAINNET`

The UI has a devnet/mainnet toggle in the header. All functions receive the current `network` string and use `getRpcEndpoint(network)` to build the `Connection`.

## Code Structure

All business logic lives in `lib/` — the `app/` directory is purely UI.

| File | Role |
|---|---|
| `lib/custodian.tsx` | All on-chain reads and writes against the custodian program. Every exported function maps to one UI button. |
| `lib/createConfigAndPool.tsx` | Standalone flow for creating a new DBC config + pool in two transactions. Separated because it depends on Meteora SDK directly and not the custodian IDL. |
| `lib/solscanLink.tsx` | Single helper that builds Solscan transaction URLs. |
| `app/page.tsx` | Single-page UI. `VIEW_FUNCTIONS`, `NON_ADMIN_FUNCTIONS`, `ADMIN_FUNCTIONS` arrays drive rendering. Each entry maps `id` → a branch in the `handleSubmit` dispatcher. Adding a new function means: (1) add to `lib/custodian.tsx`, (2) add a `FunctionDef` entry to the appropriate array in `page.tsx`, (3) add a branch in `handleSubmit`. |
| `app/providers.tsx` | Wallet adapter setup (Phantom via standard adapter, Solflare, Backpack). |
| `idl/dbc_swap.json` | Anchor IDL for the custodian program. Address is validated at module load against the hardcoded `MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID` constant in `custodian.tsx` — changing one without the other throws immediately. |

## Key Architectural Constraints

**Program IDs** — three are used throughout `lib/custodian.tsx`:
- `MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID` — the custodian (`WJH1JBQikS6...`) — must match `idl/dbc_swap.json`
- `DBC_PROGRAM_ID` — Meteora DBC (`dbcij3L...`)
- `DAMMV2_PROGRAM_ID` — Meteora CP-AMM / DAMM v2 (`cpamdpZ...`)

**`fee_claimer` PDA** — derived from `["fee_claimer"]` + custodian program ID. This PDA is the authority for all fee vaults and holds DAMM v2 LP position NFTs after pool migration. It must be set as `feeClaimer` during pool creation in `createConfigAndPool.tsx` or the entire fee flow breaks permanently.

**Transaction size** — bundled claim+distribute functions (2E, 2F) require an Address Lookup Table (ALT) created during 3A (initializePoolClaimers). The ALT address must be passed by the user. Without it, versioned transactions exceed the 1232-byte limit.

**Versioned transactions** — `claimAndDistributeFeesDbc` and `claimAndDistributeFeesDammV2` use `VersionedTransaction` + `TransactionMessage` with ALT. All other functions use legacy `Transaction` or the Anchor `program.methods` builder. Do not mix them.

**Buffer polyfill** — both `lib/custodian.tsx` and `app/providers.tsx` polyfill `globalThis.Buffer` at module top before any Solana import. This is required for webpack builds. Do not remove or move it.

**`@meteora-ag/cp-amm-sdk`** — used for all DAMM v2 pool reads (`CpAmm.fetchPoolState`, `fetchPositionState`) and helpers (`getPriceFromSqrtPrice`, `getTokenDecimals`, `getUnClaimLpFee`, `getTokenProgram`, `derivePositionAddress`, `derivePoolAuthority`). Reference `deps/damm-v2/programs/cp-amm/src/state/pool.rs` for the authoritative field list when the TypeScript types are ambiguous.

**`@meteora-ag/dynamic-bonding-curve-sdk`** — used only in `createConfigAndPool.tsx` via `DynamicBondingCurveClient`.

## Adding a New View Function

1. Export an async function from `lib/custodian.tsx`. View functions take `connection: Connection` and string inputs; no wallet needed.
2. Add a `FunctionDef` entry to `VIEW_FUNCTIONS` in `app/page.tsx` with a sequential `number` (`'1F'`, etc.) and matching `id`.
3. Add an `else if (fn.id === '...')` branch inside `handleSubmit` in `app/page.tsx`.
4. The result renders automatically via `formatResult()` (JSON pretty-print). If the function also produces a Solscan link or Jupiter link, include `solscan` / `jupiterLink` in the returned object — the UI strips these from the JSON display and renders them as links.
