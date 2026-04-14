'use client';

// Polyfill Buffer for Turbopack builds.
import { Buffer as NodeBuffer } from 'buffer';
if (typeof globalThis !== 'undefined' && !('Buffer' in globalThis)) {
  (globalThis as { Buffer?: typeof NodeBuffer }).Buffer = NodeBuffer;
}

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  AddressLookupTableProgram,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import { createMemoInstruction } from '@solana/spl-memo';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getTokenMetadata,
} from '@solana/spl-token';
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  CpAmm,
  derivePositionAddress,
  derivePositionNftAccount,
  derivePoolAuthority,
  getTokenProgram,
  getUnClaimLpFee,
} from '@meteora-ag/cp-amm-sdk';

import { solscanLink } from './solscanLink';

// ─── Program IDs ─────────────────────────────────────────────────────────────

const MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID = new PublicKey(
  '2VgCjezWK4kHxoute1Jy986AXVPvSkwquPX5VBVwQMzV',
);
const DBC_PROGRAM_ID = new PublicKey(
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
);
const DAMMV2_PROGRAM_ID = new PublicKey(
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
);
const WSOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
);

// ─── PDA helpers ─────────────────────────────────────────────────────────────

function derivePoolClaimersPda(pool: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_claimers'), pool.toBuffer()],
    MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID,
  );
  return pda;
}

export function deriveFeeClaimerPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_claimer')],
    MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID,
  );
  return pda;
}

function derivePoolFeeVaults(
  pool: PublicKey,
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
): { baseFeeVault: PublicKey; quoteFeeVault: PublicKey } {
  const [baseFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_vault'), pool.toBuffer(), tokenAMint.toBuffer()],
    MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID,
  );
  const [quoteFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_vault'), pool.toBuffer(), tokenBMint.toBuffer()],
    MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID,
  );
  return { baseFeeVault, quoteFeeVault };
}

function deriveClaimerStatePda(pool: PublicKey, claimer: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('claimer_state'), pool.toBuffer(), claimer.toBuffer()],
    MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID,
  );
  return pda;
}

function deriveClaimerPendingBaseVault(pool: PublicKey, claimer: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('claimer_pending_base'), pool.toBuffer(), claimer.toBuffer()],
    MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID,
  );
  return pda;
}

function deriveClaimerPendingQuoteVault(pool: PublicKey, claimer: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('claimer_pending_quote'), pool.toBuffer(), claimer.toBuffer()],
    MY_CUSTODIAN_SMART_CONTRACT_PROGRAM_ID,
  );
  return pda;
}

// ─── Memo helpers (improves on-chain indexability) ───────────────────────────

/**
 * Appends a memo instruction to a legacy {@link Transaction}.
 * The memo is recorded on-chain and makes the tx trivially indexable by label.
 *
 * @param tx     - The legacy transaction to mutate in-place.
 * @param memo   - UTF-8 string to embed (max ~566 bytes after base58 encoding).
 * @param signer - Optional signer public key to attach to the memo instruction.
 *                 When provided, the memo program will verify the signature.
 */
export function addMemoToLegacyTransaction(
  tx: Transaction,
  memo: string,
  signer?: PublicKey,
): void {
  const memoIx = createMemoInstruction(
    memo,
    signer ? [signer] : [],
  );
  tx.add(memoIx);
}

/**
 * Returns a new {@link VersionedTransaction} with a memo instruction appended
 * to the inner message's instruction list.
 * Versioned transactions are immutable after construction, so we rebuild the
 * message from the existing instructions + the new memo instruction.
 *
 * @param vt          - The versioned transaction to extend.
 * @param memo        - UTF-8 string to embed (max ~566 bytes after base58 encoding).
 * @param feePayer    - Fee payer public key (required to reconstruct the message).
 * @param connection  - Used to fetch a fresh blockhash for the rebuilt message.
 * @param signer      - Optional signer public key to attach to the memo instruction.
 */
export async function addMemoToVersionedTransaction(
  vt: VersionedTransaction,
  memo: string,
  feePayer: PublicKey,
  connection: Connection,
  signer?: PublicKey,
): Promise<VersionedTransaction> {
  const memoIx = createMemoInstruction(
    memo,
    signer ? [signer] : [],
  );

  // Decompose the existing compiled message back into instructions.
  const msg = vt.message;
  const existingIxs = msg.compiledInstructions.map((ci) => ({
    programId: msg.staticAccountKeys[ci.programIdIndex],
    keys: ci.accountKeyIndexes.map((idx) => ({
      pubkey: msg.staticAccountKeys[idx],
      isSigner: msg.isAccountSigner(idx),
      isWritable: msg.isAccountWritable(idx),
    })),
    data: Buffer.from(ci.data),
  }));

  const { blockhash } = await connection.getLatestBlockhash();

  const newMessage = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [...existingIxs, memoIx],
  }).compileToV0Message();
  // Note: ALT accounts cannot be reconstructed here without fetching them from
  // chain; memo instructions never require ALTs, and all static accounts from
  // the original message are already inlined in existingIxs above.

  return new VersionedTransaction(newMessage);
}

// ─────────────────────────────────────────────────────────────────────────────

type ClaimerRemainingAccountMeta = {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
};

/** Per claimer: [claimer_state_pda, pending_base_vault, pending_quote_vault] */
function buildInitClaimersRemainingAccounts(
  pool: PublicKey,
  claimers: PublicKey[],
): ClaimerRemainingAccountMeta[] {
  return claimers.flatMap((claimer) => [
    { pubkey: deriveClaimerStatePda(pool, claimer), isSigner: false, isWritable: true },
    { pubkey: deriveClaimerPendingBaseVault(pool, claimer), isSigner: false, isWritable: true },
    { pubkey: deriveClaimerPendingQuoteVault(pool, claimer), isSigner: false, isWritable: true },
  ]);
}

/** Per claimer: [state, pending_base, pending_quote, base_ata, quote_ata] */
function buildDistributeFeesRemainingAccounts(
  pool: PublicKey,
  claimers: PublicKey[],
  baseMint: PublicKey,
  quoteMint: PublicKey,
  baseTokenProgram: PublicKey,
  quoteTokenProgram: PublicKey,
): ClaimerRemainingAccountMeta[] {
  return claimers.flatMap((claimer) => {
    const claimerStatePda = deriveClaimerStatePda(pool, claimer);
    const pendingBaseVault = deriveClaimerPendingBaseVault(pool, claimer);
    const pendingQuoteVault = deriveClaimerPendingQuoteVault(pool, claimer);
    const claimerBaseAta = getAssociatedTokenAddressSync(baseMint, claimer, false, baseTokenProgram);
    const claimerQuoteAta = getAssociatedTokenAddressSync(quoteMint, claimer, false, quoteTokenProgram);
    return [
      { pubkey: claimerStatePda, isSigner: false, isWritable: true },
      { pubkey: pendingBaseVault, isSigner: false, isWritable: true },
      { pubkey: pendingQuoteVault, isSigner: false, isWritable: true },
      { pubkey: claimerBaseAta, isSigner: false, isWritable: true },
      { pubkey: claimerQuoteAta, isSigner: false, isWritable: true },
    ];
  });
}

function deriveCpAmmEventAuthority(cpAmmProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    cpAmmProgramId,
  );
  return pda;
}

const [dbcPoolAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('pool_authority')],
  DBC_PROGRAM_ID,
);
const [dbcEventAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  DBC_PROGRAM_ID,
);

// ─── DAMM v2 position resolver (shared helper) ───────────────────────────────

/**
 * Finds the vault-owned DAMM v2 position NFT for a given pool.
 * Extracted as a shared helper to avoid duplication and to reuse in ALT creation.
 */
async function resolveDammV2Position(
  connection: Connection,
  pool: PublicKey,
): Promise<{ position: PublicKey; positionNftAccount: PublicKey } | null> {
  const cpAmm = new CpAmm(connection);
  const vault = deriveFeeClaimerPda();

  const [legacy, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(vault, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(vault, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const candidates = [...legacy.value, ...t22.value].filter(
    (acc) => isLikelyPositionNftAccount(acc.account),
  );

  for (const acc of candidates) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mint = new PublicKey((acc.account.data as any).parsed.info.mint as string);
    const position = derivePositionAddress(mint);
    const info = await connection.getAccountInfo(position);
    if (!info) continue;
    const state = await cpAmm.fetchPositionState(position);
    if (state.pool.equals(pool)) {
      return { position, positionNftAccount: derivePositionNftAccount(mint) };
    }
  }
  return null;
}

type DbcPoolStateResolved = Awaited<
  ReturnType<InstanceType<typeof DynamicBondingCurveClient>['state']['getPool']>
>;
type DammPoolStateResolved = Awaited<ReturnType<CpAmm['fetchPoolState']>>;

type PoolTokensResolved =
  | {
      mode: 'dbc';
      baseMint: PublicKey;
      quoteMint: PublicKey;
      tokenBaseProgram: PublicKey;
      tokenQuoteProgram: PublicKey;
      dbcPoolState: DbcPoolStateResolved;
    }
  | {
      mode: 'damm-v2';
      baseMint: PublicKey;
      quoteMint: PublicKey;
      tokenBaseProgram: PublicKey;
      tokenQuoteProgram: PublicKey;
      dammPoolState: DammPoolStateResolved;
    };

async function resolvePoolTokensByMode(
  connection: Connection,
  pool: PublicKey,
  mode: 'dbc' | 'damm-v2',
): Promise<PoolTokensResolved> {
  if (mode === 'dbc') {
    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    const dbcPoolState = await client.state.getPool(pool);
    const dbcPoolConfig = await client.state.getPoolConfig(dbcPoolState.config);
    return {
      mode: 'dbc',
      baseMint: dbcPoolState.baseMint,
      quoteMint: dbcPoolConfig.quoteMint,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
      tokenQuoteProgram: getTokenProgram(dbcPoolConfig.quoteTokenFlag),
      dbcPoolState,
    };
  }
  const cpAmm = new CpAmm(connection);
  const dammPoolState = await cpAmm.fetchPoolState(pool);
  return {
    mode: 'damm-v2',
    baseMint: dammPoolState.tokenAMint,
    quoteMint: dammPoolState.tokenBMint,
    tokenBaseProgram: getTokenProgram(dammPoolState.tokenAFlag),
    tokenQuoteProgram: getTokenProgram(dammPoolState.tokenBFlag),
    dammPoolState,
  };
}

// ─── ALT helpers ─────────────────────────────────────────────────────────────

async function createPoolAlt(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    pool: PublicKey;
    claimers: PublicKey[];
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseTokenProgram: PublicKey;
    quoteTokenProgram: PublicKey;
    // DBC-specific extras (pass undefined for DAMM v2)
    dbcPoolAuthority_?: PublicKey;
    dbcEventAuthority_?: PublicKey;
    dbcConfig?: PublicKey;
    dbcBaseVault?: PublicKey;
    dbcQuoteVault?: PublicKey;
    // DAMM v2 extras (pass undefined for DBC)
    cpAmmPoolAuthority?: PublicKey;
    cpAmmEventAuthority?: PublicKey;
    tokenAVault?: PublicKey;
    tokenBVault?: PublicKey;
    positionNftAccount?: PublicKey;
    position?: PublicKey;
    cpAmmProgram?: PublicKey;
  },
): Promise<PublicKey> {
  const { pool, claimers, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram } = params;

  // Use finalized slot to ensure the ALT creation tx references a confirmed slot
  const slot = await connection.getSlot('finalized');

  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: wallet.publicKey,
    payer: wallet.publicKey,
    recentSlot: slot,
  });

  // ── Derive all deterministic per-pool addresses ──
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(pool, baseMint, quoteMint);
  const poolClaimersPda = derivePoolClaimersPda(pool);
  const feeClaimerPda = deriveFeeClaimerPda();

  // Per claimer: wallet + all 4 PDAs/ATAs used in distribute
  const perClaimerAddresses = claimers.flatMap((claimer) => [
    claimer,
    deriveClaimerStatePda(pool, claimer),
    deriveClaimerPendingBaseVault(pool, claimer),
    deriveClaimerPendingQuoteVault(pool, claimer),
    getAssociatedTokenAddressSync(baseMint, claimer, false, baseTokenProgram),
    getAssociatedTokenAddressSync(quoteMint, claimer, false, quoteTokenProgram),
  ]);

  const fixedAddresses: PublicKey[] = [
    pool,
    baseMint,
    quoteMint,
    baseFeeVault,
    quoteFeeVault,
    poolClaimersPda,
    feeClaimerPda,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    SystemProgram.programId,
  ];

  const optionalAddresses: PublicKey[] = [
    params.dbcPoolAuthority_,
    params.dbcEventAuthority_,
    params.dbcConfig,
    params.dbcBaseVault,
    params.dbcQuoteVault,
    params.cpAmmPoolAuthority,
    params.cpAmmEventAuthority,
    params.tokenAVault,
    params.tokenBVault,
    params.positionNftAccount,
    params.position,
    params.cpAmmProgram,
  ].filter((a): a is PublicKey => a != null);

  const allAddresses = [...fixedAddresses, ...perClaimerAddresses, ...optionalAddresses];

  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());

  const BATCH_SIZE = 25;

  const firstBatch = allAddresses.slice(0, BATCH_SIZE);
  const firstExtendIx = AddressLookupTableProgram.extendLookupTable({
    payer: wallet.publicKey,
    authority: wallet.publicKey,
    lookupTable: tableAddress,
    addresses: firstBatch,
  });
  const createAndExtendTx = new Transaction().add(createIx, firstExtendIx);
  addMemoToLegacyTransaction(createAndExtendTx, `create-pool-alt:${pool.toBase58()}`, wallet.publicKey);
  await provider.sendAndConfirm(createAndExtendTx);

  // Remaining batches — ideally just 1 more tx for typical claimer counts
  for (let i = BATCH_SIZE; i < allAddresses.length; i += BATCH_SIZE) {
    const batch = allAddresses.slice(i, i + BATCH_SIZE);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      lookupTable: tableAddress,
      addresses: batch,
    });
    const extendTx = new Transaction().add(extendIx);
    await provider.sendAndConfirm(extendTx);
  }
  // Wait for ALT to be visible on-chain before returning.
  // On devnet ~1s is enough; on mainnet the ALT warmup is ~1 epoch so the
  // admin must save the altAddress and only pass it to claimAndDistribute
  // after the warmup period has elapsed.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  console.log('[createPoolAlt] ALT created:', tableAddress.toBase58(), '| total addresses:', allAddresses.length);
  return tableAddress;
}

/**
 * Sends a versioned (v0) transaction using the provided ALT.
 * altAddress is required — this function never falls back to legacy format.
 */
type SendV0Context = {
  flow?: 'claim_and_distribute_dbc' | 'claim_and_distribute_dammv2';
  poolAddress?: string;
};

const U64_MAX = BigInt('18446744073709551615');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractErrorLogs(error: any): string[] {
  const candidates: unknown[] = [];
  const pushLogs = (value: unknown): void => {
    if (Array.isArray(value)) candidates.push(...value);
  };

  pushLogs(error?.logs);
  pushLogs(error?.transactionLogs);
  pushLogs(error?.cause?.logs);
  pushLogs(error?.cause?.transactionLogs);
  pushLogs(error?.error?.logs);
  pushLogs(error?.error?.transactionLogs);

  const logs = candidates
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return Array.from(new Set(logs)).slice(0, 25);
}

function extractErrorMessages(error: unknown): string[] {
  const seen = new Set<unknown>();
  const out: string[] = [];

  const walk = (value: unknown): void => {
    if (value == null || seen.has(value)) return;
    seen.add(value);

    if (typeof value === 'string') {
      if (value.trim()) out.push(value.trim());
      return;
    }

    if (value instanceof Error) {
      if (value.message.trim()) out.push(value.message.trim());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maybeAny = value as any;
      walk(maybeAny.cause);
      walk(maybeAny.error);
      return;
    }

    if (typeof value === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maybeAny = value as any;
      if (typeof maybeAny.message === 'string' && maybeAny.message.trim()) out.push(maybeAny.message.trim());
      if (typeof maybeAny.toString === 'function') {
        const rendered = maybeAny.toString();
        if (typeof rendered === 'string' && rendered !== '[object Object]' && rendered.trim()) out.push(rendered.trim());
      }
      walk(maybeAny.cause);
      walk(maybeAny.error);
    }
  };

  walk(error);
  return Array.from(new Set(out)).slice(0, 8);
}

function formatSendV0Error(
  error: unknown,
  altAddress: string,
  context?: SendV0Context,
): Error {
  const messages = extractErrorMessages(error);
  const logs = extractErrorLogs(error);
  const primary = messages[0] ?? 'unknown wallet adapter error';
  const contextPrefix = context?.flow
    ? `[${context.flow}]${context.poolAddress ? ` pool=${context.poolAddress}` : ''}`
    : '[claim_and_distribute]';

  const combinedText = `${messages.join(' ')} ${logs.join(' ')}`.toLowerCase();
  const likelyAltAccountIssue =
    combinedText.includes('invalid account')
    || combinedText.includes('invalid index')
    || combinedText.includes('address table lookup')
    || combinedText.includes('account not found');

  const detailLines = [
    `${contextPrefix} Failed to send v0 transaction with ALT ${altAddress}.`,
    `Wallet error: ${primary}`,
  ];

  if (messages.length > 1) {
    detailLines.push(`Error details: ${messages.slice(1).join(' | ')}`);
  }

  if (logs.length > 0) {
    detailLines.push(`Program logs: ${logs.join(' | ')}`);
  }

  if (likelyAltAccountIssue) {
    detailLines.push(
      'Likely cause: ALT does not match the required account set for this pool/mode (stale, wrong pool, or incomplete table).',
    );
    detailLines.push('Action: regenerate the ALT from Set Pool Claimers and retry after ALT warmup.');
  }

  return new Error(detailLines.join('\n'));
}

async function sendV0Transaction(
  connection: Connection,
  wallet: AnchorWallet,
  instructions: import('@solana/web3.js').TransactionInstruction[],
  altAddress: string,
  sendTransaction?: (
    tx: VersionedTransaction,
    connection: Connection,
    options?: { skipPreflight?: boolean; maxRetries?: number },
  ) => Promise<string>,
  context?: SendV0Context,
): Promise<{ sig: string; blockhash: string; lastValidBlockHeight: number }> {
  if (!altAddress || altAddress.trim().length === 0) {
    throw new Error('sendV0Transaction requires an ALT address — versioned transaction cannot be built without one.');
  }
  const normalizedAltAddress = altAddress.trim();

  const latest = await connection.getLatestBlockhash('confirmed');

  let altPubkey: PublicKey;
  try {
    altPubkey = new PublicKey(normalizedAltAddress);
  } catch {
    throw new Error(`Invalid ALT address: "${normalizedAltAddress}". Please provide a valid lookup table pubkey.`);
  }
  const altResult = await connection.getAddressLookupTable(altPubkey);

  if (!altResult.value) {
    throw new Error(`ALT not found on-chain: ${normalizedAltAddress}. It may not have propagated yet — wait a moment and retry.`);
  }

  // Check ALT is not deactivated
  // deactivationSlot is u64::MAX (18446744073709551615n) when active
  if (altResult.value.state.deactivationSlot !== U64_MAX) {
    throw new Error(`ALT ${normalizedAltAddress} has been deactivated and cannot be used.`);
  }

  // Check ALT warmup: lastExtendedSlot must be < current finalized slot
  const currentSlot = await connection.getSlot('finalized');
  if (altResult.value.state.lastExtendedSlot >= currentSlot) {
    throw new Error(
      `ALT not yet active. Extended at slot ${altResult.value.state.lastExtendedSlot}, ` +
      `current finalized slot ${currentSlot}. Wait a few slots (devnet) or ~1 epoch (mainnet) and retry.`,
    );
  }

  const memoIxV0 = createMemoInstruction('dbc-custodian:send-v0', [wallet.publicKey]);
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [...instructions, memoIxV0],
  }).compileToV0Message([altResult.value]);

  const vtx = new VersionedTransaction(message);

  try {
    let sig: string;
    if (sendTransaction) {
      sig = await sendTransaction(vtx, connection, {
        skipPreflight: false,
        maxRetries: 3,
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signed = await (wallet as any).signTransaction(vtx);
      sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
    }
    return { sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };
  } catch (error) {
    console.error('[sendV0Transaction] failed', {
      altAddress: normalizedAltAddress,
      flow: context?.flow ?? 'unknown',
      poolAddress: context?.poolAddress ?? 'unknown',
      error,
    });
    throw formatSendV0Error(error, normalizedAltAddress, context);
  }
}

// ─── Program factory ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadIdl(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/idl/dbc_swap.json');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createProgram(wallet: AnchorWallet, connection: Connection): Program<any> {
  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  const idl = loadIdl();
  return new Program(idl, provider);
}

/** Anchor 0.32 + IDL: `.methods` builders hit TS2589 (excessively deep instantiation). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function programMethods(program: Program<any>): any {
  return program.methods;
}

// ─── View: Pool Claimers PDA state ───────────────────────────────────────────

export interface ClaimerInfo {
  address: string;
  bps: number;
  pct: string;
  claimedBase: string;
  claimedQuote: string;
}

export interface PoolClaimersState {
  pool: string;
  pda: string;
  poolStateMode: string;
  bump: number;
  lastClaimed: string;
  lastDistributed: string;
  claimers: ClaimerInfo[];
}

export async function viewPoolClaimers(
  connection: Connection,
  poolAddress: string,
): Promise<PoolClaimersState> {
  const dummyWallet: AnchorWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };
  const program = createProgram(dummyWallet, connection);
  const pool = new PublicKey(poolAddress);
  const pda = derivePoolClaimersPda(pool);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state: any = await (program.account as any).poolClaimers.fetch(pda);

  const claimers: ClaimerInfo[] = await Promise.all(
    state.claimerAddresses.map(async (addr: PublicKey, i: number) => {
      const claimerStatePda = deriveClaimerStatePda(pool, addr);
      let claimedBase = '0';
      let claimedQuote = '0';
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cs: any = await (program.account as any).claimerState.fetch(claimerStatePda);
        claimedBase = cs.claimedBase.toString();
        claimedQuote = cs.claimedQuote.toString();
      } catch {
        // ClaimerState PDA not created yet
      }
      return {
        address: addr.toBase58(),
        bps: state.claimerBps[i],
        pct: `${(state.claimerBps[i] / 100).toFixed(2)}%`,
        claimedBase,
        claimedQuote,
      };
    }),
  );

  return {
    pool: state.pool.toBase58(),
    pda: pda.toBase58(),
    poolStateMode: Object.keys(state.poolState)[0].toUpperCase(),
    bump: state.bump,
    lastClaimed: state.lastClaimed.toString(),
    lastDistributed: state.lastDistributed.toString(),
    claimers,
  };
}

export interface ClaimerPoolInfo {
  claimerStatePda: string;
  pool: string;
  claimer: string;
  isEnabled: boolean;
  claimedBase: string;
  claimedQuote: string;
}

export async function viewClaimerPoolInfo(
  connection: Connection,
  poolAddress: string,
  claimerAddress: string,
): Promise<ClaimerPoolInfo> {
  const dummyWallet: AnchorWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };
  const program = createProgram(dummyWallet, connection);
  const pool = new PublicKey(poolAddress);
  const claimer = new PublicKey(claimerAddress);
  const claimerStatePda = deriveClaimerStatePda(pool, claimer);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs: any = await (program.account as any).claimerState.fetch(claimerStatePda);
    return {
      claimerStatePda: claimerStatePda.toBase58(),
      pool: cs.pool.toBase58(),
      claimer: cs.claimer.toBase58(),
      isEnabled: Boolean(cs.isEnabled),
      claimedBase: cs.claimedBase.toString(),
      claimedQuote: cs.claimedQuote.toString(),
    };
  } catch {
    throw new Error(
      'ClaimerState not found — pool/claimer may be wrong or claimer not initialized (run initialize pool claimers first).',
    );
  }
}


// ─── View: Fee Vault Balances ─────────────────────────────────────────────────

export async function viewFeeVaultBalances(
  connection: Connection,
  poolAddress: string,
  baseMintAddress: string,
  quoteMintAddress: string,
) {
  const pool = new PublicKey(poolAddress);
  const baseMint = new PublicKey(baseMintAddress);
  const quoteMint = new PublicKey(quoteMintAddress);
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(pool, baseMint, quoteMint);

  const [baseInfo, quoteInfo] = await Promise.all([
    connection.getAccountInfo(baseFeeVault),
    connection.getAccountInfo(quoteFeeVault),
  ]);

  let baseBalance = 'vault does not exist yet';
  let quoteBalance = 'vault does not exist yet';

  if (baseInfo) {
    const bal = await connection.getTokenAccountBalance(baseFeeVault);
    baseBalance = bal.value.uiAmountString ?? '0';
  }
  if (quoteInfo) {
    const bal = await connection.getTokenAccountBalance(quoteFeeVault);
    quoteBalance = bal.value.uiAmountString ?? '0';
  }

  return {
    baseFeeVault: baseFeeVault.toBase58(),
    quoteFeeVault: quoteFeeVault.toBase58(),
    baseBalance,
    quoteBalance,
  };
}

// ─── View: Vault All Token Info (DAMM v2 positions) ──────────────────────────

interface VaultPositionInfo {
  pool: string;
  position: string;
  positionNftAccount: string;
  positionNftMint: string;
  tokenAMint: string;
  tokenAName: string;
  tokenASymbol: string;
  tokenBMint: string;
  tokenBName: string;
  tokenBSymbol: string;
  unclaimedFeeA: string;
  unclaimedFeeB: string;
}

interface VaultPositionInfoBase {
  pool: string;
  position: string;
  positionNftAccount: string;
  positionNftMint: string;
  tokenAMint: string;
  tokenBMint: string;
  unclaimedFeeA: string;
  unclaimedFeeB: string;
}

interface TokenDisplayInfo {
  name: string;
  symbol: string;
}

function isLikelyPositionNftAccount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account: any,
): boolean {
  const tokenAmount = account?.data?.parsed?.info?.tokenAmount;
  if (!tokenAmount) return false;
  return tokenAmount.decimals === 0 && tokenAmount.amount === '1';
}

async function getTokenDisplayInfo(connection: Connection, mint: PublicKey): Promise<TokenDisplayInfo> {
  if (mint.equals(WSOL_MINT)) return { name: 'Solana', symbol: 'SOL' };

  const mintAccountInfo = await connection.getAccountInfo(mint);
  const ownerProgram = mintAccountInfo?.owner;
  const isToken22 = ownerProgram?.equals(TOKEN_2022_PROGRAM_ID) ?? false;

  if (isToken22) {
    try {
      const meta = await getTokenMetadata(connection, mint);
      if (meta) {
        return {
          name: (meta.name ?? 'Unknown').trim() || 'Unknown',
          symbol: (meta.symbol ?? '???').trim() || '???',
        };
      }
    } catch {
      // fallthrough
    }
  }

  return { name: 'Unknown', symbol: '???' };
}

export async function viewVaultAllTokenInfo(connection: Connection): Promise<{
  vaultPubkey: string;
  totalPositions: number;
  positions: VaultPositionInfo[];
}> {
  const cpAmm = new CpAmm(connection);
  const vault = deriveFeeClaimerPda();

  const [legacyTokenAccounts, token2022Accounts] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(vault, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(vault, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const allTokenAccounts = [...legacyTokenAccounts.value, ...token2022Accounts.value];
  const nftCandidates = allTokenAccounts.filter((acc) => isLikelyPositionNftAccount(acc.account));

  const positionsMaybe = await Promise.all(
    nftCandidates.map(async (acc) => {
      const nftMint = new PublicKey(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (acc.account.data as any).parsed.info.mint as string,
      );
      const position = derivePositionAddress(nftMint);
      const positionInfo = await connection.getAccountInfo(position);
      if (!positionInfo) return null;

      const positionState = await cpAmm.fetchPositionState(position);
      const pool = positionState.pool;
      const poolState = await cpAmm.fetchPoolState(pool);
      const unclaimedFees = getUnClaimLpFee(poolState, positionState);

      return {
        pool: pool.toBase58(),
        position: position.toBase58(),
        positionNftAccount: acc.pubkey.toBase58(),
        positionNftMint: nftMint.toBase58(),
        tokenAMint: poolState.tokenAMint.toBase58(),
        tokenBMint: poolState.tokenBMint.toBase58(),
        unclaimedFeeA: unclaimedFees.feeTokenA.toString(),
        unclaimedFeeB: unclaimedFees.feeTokenB.toString(),
      } satisfies VaultPositionInfoBase;
    }),
  );

  const positionsRaw = positionsMaybe.filter((p): p is VaultPositionInfoBase => p !== null);

  const uniqueMintStrings = [...new Set(positionsRaw.flatMap((p) => [p.tokenAMint, p.tokenBMint]))];
  const mintMetadataEntries = await Promise.all(
    uniqueMintStrings.map(async (mintStr) => {
      const info = await getTokenDisplayInfo(connection, new PublicKey(mintStr));
      return [mintStr, info] as const;
    }),
  );
  const mintMetadataMap = new Map<string, TokenDisplayInfo>(mintMetadataEntries);

  const positions = positionsRaw.map((p) => {
    const tokenAInfo = mintMetadataMap.get(p.tokenAMint) ?? { name: 'Unknown', symbol: '???' };
    const tokenBInfo = mintMetadataMap.get(p.tokenBMint) ?? { name: 'Unknown', symbol: '???' };
    return {
      ...p,
      tokenAName: tokenAInfo.name,
      tokenASymbol: tokenAInfo.symbol,
      tokenBName: tokenBInfo.name,
      tokenBSymbol: tokenBInfo.symbol,
    };
  });

  return { vaultPubkey: vault.toBase58(), totalPositions: positions.length, positions };
}

// ─── Admin: Initialize pool claimers ─────────────────────────────────────────

export interface ClaimerEntry {
  address: string;
  bps: number;
}

export async function initializePoolClaimers(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    mode: 'dbc' | 'damm-v2';
    claimers: ClaimerEntry[];
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string; altAddress: string }> {
  const program = createProgram(wallet, connection);
  const pool = new PublicKey(params.poolAddress);
  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);

  const claimerPubkeys = params.claimers.map((c) => new PublicKey(c.address));
  const bps = params.claimers.map((c) => c.bps);
  const poolStateArg = params.mode === 'dbc' ? { dbc: {} } : { dammV2: {} };

  const poolTokens = await resolvePoolTokensByMode(connection, pool, params.mode);
  const { baseMint, quoteMint, tokenBaseProgram, tokenQuoteProgram } = poolTokens;

  let dbcPoolStateResolved: DbcPoolStateResolved | null = null;
  let dammPoolStateResolved: DammPoolStateResolved | null = null;
  let dammPositionResolved: { position: PublicKey; positionNftAccount: PublicKey } | null = null;

  if (poolTokens.mode === 'dbc') {
    dbcPoolStateResolved = poolTokens.dbcPoolState;
  } else {
    dammPoolStateResolved = poolTokens.dammPoolState;
    dammPositionResolved = await resolveDammV2Position(connection, pool);
  }

  const initRemaining = buildInitClaimersRemainingAccounts(pool, claimerPubkeys);

  const sig: string = await programMethods(program)
    .initializePoolClaimers(claimerPubkeys, bps, poolStateArg)
    .accounts({
      deployer: wallet.publicKey,
      pool,
      baseMint,
      quoteMint,
      poolClaimers: poolClaimersPdaPubKey,
      tokenBaseProgram,
      tokenQuoteProgram,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(initRemaining)
    .preInstructions([createMemoInstruction(`init-pool-claimers:${pool.toBase58()}`, [wallet.publicKey])])
    .rpc();

  // ── Create ALT right after pool claimers are initialized ──
  let altAddress = '';
  try {
    const altPubkey = await createPoolAlt(connection, wallet, {
      pool,
      claimers: claimerPubkeys,
      baseMint,
      quoteMint,
      baseTokenProgram: tokenBaseProgram,
      quoteTokenProgram: tokenQuoteProgram,
      // DBC-specific extras
      ...(params.mode === 'dbc' && dbcPoolStateResolved != null && {
        dbcPoolAuthority_: dbcPoolAuthority,
        dbcEventAuthority_: dbcEventAuthority,
        dbcConfig: dbcPoolStateResolved.config,
        dbcBaseVault: dbcPoolStateResolved.baseVault,
        dbcQuoteVault: dbcPoolStateResolved.quoteVault,
      }),
      // DAMM v2-specific extras
      ...(params.mode === 'damm-v2' && dammPoolStateResolved != null && {
        cpAmmPoolAuthority: derivePoolAuthority(),
        cpAmmEventAuthority: deriveCpAmmEventAuthority(DAMMV2_PROGRAM_ID),
        cpAmmProgram: DAMMV2_PROGRAM_ID,
        tokenAVault: dammPoolStateResolved.tokenAVault,
        tokenBVault: dammPoolStateResolved.tokenBVault,
        ...(dammPositionResolved != null && {
          position: dammPositionResolved.position,
          positionNftAccount: dammPositionResolved.positionNftAccount,
        }),
      }),
    });
    altAddress = altPubkey.toBase58();
    console.log('[initializePoolClaimers] ALT created:', altAddress);
  } catch (e) {
    console.error('[initializePoolClaimers] ALT creation failed:', e);
    throw new Error(`Address Lookup Table creation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { tx: sig, link: solscanLink(sig, params.network), altAddress };
}

// ─── Admin: Update Claimers BPS ───────────────────────────────────────────────

export async function updateClaimersBps(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    claimers: ClaimerEntry[];
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string }> {
  const program = createProgram(wallet, connection);
  const pool = new PublicKey(params.poolAddress);
  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
  const bps = params.claimers.map((c) => c.bps);

  const sig: string = await programMethods(program)
    .updateClaimersBps(bps)
    .accounts({
      deployer: wallet.publicKey,
      pool,
      poolClaimers: poolClaimersPdaPubKey,
    })
    .preInstructions([createMemoInstruction(`update-claimers-bps:${pool.toBase58()}`, [wallet.publicKey])])
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network) };
}

// ─── Admin: Set claimer enabled ───────────────────────────────────────────────

export async function setClaimerEnabled(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    claimerAddress: string;
    isEnabled: boolean;
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string }> {
  const program = createProgram(wallet, connection);
  const pool = new PublicKey(params.poolAddress);
  const claimer = new PublicKey(params.claimerAddress);
  const claimerState = deriveClaimerStatePda(pool, claimer);

  const sig: string = await programMethods(program)
    .setClaimerEnabled(params.isEnabled)
    .accounts({
      admin: wallet.publicKey,
      pool,
      claimer,
      claimerState,
    })
    .preInstructions([createMemoInstruction(`set-claimer-enabled:${pool.toBase58()}:${claimer.toBase58()}:${params.isEnabled}`, [wallet.publicKey])])
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network) };
}

// ─── Admin: Sweep locked / pending claimer vaults ────────────────────────────

export async function adminSweepClaimer(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    mode: 'dbc' | 'damm-v2';
    claimerAddress: string;
    recipientAddress: string;
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string; ataTx?: string }> {
  const program = createProgram(wallet, connection);
  const pool = new PublicKey(params.poolAddress);
  const claimer = new PublicKey(params.claimerAddress);
  const recipient = new PublicKey(params.recipientAddress);

  const { baseMint, quoteMint, tokenBaseProgram, tokenQuoteProgram } = await resolvePoolTokensByMode(
    connection,
    pool,
    params.mode,
  );

  const claimerState = deriveClaimerStatePda(pool, claimer);
  const claimerPendingBaseVault = deriveClaimerPendingBaseVault(pool, claimer);
  const claimerPendingQuoteVault = deriveClaimerPendingQuoteVault(pool, claimer);

  const destinationBaseAta = getAssociatedTokenAddressSync(baseMint, recipient, false, tokenBaseProgram);
  const destinationQuoteAta = getAssociatedTokenAddressSync(quoteMint, recipient, false, tokenQuoteProgram);

  const createAtaIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, destinationBaseAta, recipient, baseMint, tokenBaseProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, destinationQuoteAta, recipient, quoteMint, tokenQuoteProgram,
    ),
  ];

  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  const createAtaTransaction = new Transaction().add(...createAtaIxs);
  addMemoToLegacyTransaction(createAtaTransaction, `admin-sweep-create-atas:${pool.toBase58()}`, wallet.publicKey);
  const ataTx = await provider.sendAndConfirm(createAtaTransaction);

  const sig: string = await programMethods(program)
    .adminSweepClaimer()
    .accounts({
      admin: wallet.publicKey,
      pool,
      claimer,
      claimerState,
      claimerPendingBaseVault,
      claimerPendingQuoteVault,
      baseMint,
      quoteMint,
      destinationBaseAta,
      destinationQuoteAta,
      tokenBaseProgram,
      tokenQuoteProgram,
    })
    .preInstructions([createMemoInstruction(`admin-sweep-claimer:${pool.toBase58()}:${claimer.toBase58()}`, [wallet.publicKey])])
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network), ataTx };
}

// ─── Non-Admin: Claim DBC Partner Trading Fee ─────────────────────────────────

export async function claimDbcPartnerFee(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    network: 'devnet' | 'mainnet';
    sendTransaction?: (
      tx: Transaction,
      connection: Connection,
      options?: { skipPreflight?: boolean; maxRetries?: number },
    ) => Promise<string>;
  },
): Promise<{ tx: string; link: string }> {
  try {
    console.log('[claimDbcPartnerFee] start', {
      poolAddress: params.poolAddress,
      network: params.network,
      wallet: wallet.publicKey.toBase58(),
    });

    const program = createProgram(wallet, connection);
    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    const pool = new PublicKey(params.poolAddress);

    const poolAccountInfo = await connection.getAccountInfo(pool, 'confirmed');
    if (!poolAccountInfo) throw new Error(`Pool account not found: ${pool.toBase58()}`);
    if (!poolAccountInfo.owner.equals(DBC_PROGRAM_ID)) {
      throw new Error(
        [
          'Invalid pool address for DBC.',
          `Expected owner ${DBC_PROGRAM_ID.toBase58()} but got ${poolAccountInfo.owner.toBase58()}.`,
          `Pool: ${pool.toBase58()}`,
          `Network: ${params.network}`,
          'This usually means you pasted a non-DBC pool (e.g. cp_amm pool), or the pool is on a different cluster (mainnet vs devnet).',
        ].join(' '),
      );
    }

    let dbcPoolState: Awaited<ReturnType<typeof client.state.getPool>>;
    try {
      dbcPoolState = await client.state.getPool(pool);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        [
          `Failed to decode DBC pool account (${pool.toBase58()}).`,
          `Underlying error: ${msg}`,
          `Owner: ${poolAccountInfo.owner.toBase58()}`,
          `Data length: ${poolAccountInfo.data.length}`,
          'If you see "Invalid account discriminator", the pool address is not a DBC pool account for this SDK/program version.',
        ].join(' '),
      );
    }

    const dbcPoolConfig2 = await client.state.getPoolConfig(dbcPoolState.config);
    const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
    const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(pool, dbcPoolState.baseMint, dbcPoolConfig2.quoteMint);
    const feeClaimerPda = deriveFeeClaimerPda();

    const builder = programMethods(program)
      .claimPartnerTradingFee(
        new BN('18446744073709551615'),
        new BN('18446744073709551615'),
      )
      .accounts({
        poolAuthority: dbcPoolAuthority,
        config: dbcPoolState.config,
        pool,
        poolClaimers: poolClaimersPdaPubKey,
        baseFeeVault,
        quoteFeeVault,
        basePoolVault: dbcPoolState.baseVault,
        quotePoolVault: dbcPoolState.quoteVault,
        baseMint: dbcPoolState.baseMint,
        quoteMint: dbcPoolConfig2.quoteMint,
        feeClaimer: feeClaimerPda,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: getTokenProgram(dbcPoolConfig2.quoteTokenFlag),
        eventAuthority: dbcEventAuthority,
        dbcProgram: DBC_PROGRAM_ID,
        payer: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      });

    const tx = await builder.transaction();

    try {
      const sim = await builder.simulate();
      console.log('[claimDbcPartnerFee] simulate ok', { hasLogs: Boolean(sim.raw?.logs?.length) });
    } catch (simError) {
      console.error('[claimDbcPartnerFee] simulate failed', simError);
    }

    let sig: string;
    try {
      const latest = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = latest.blockhash;
      tx.feePayer = wallet.publicKey;
      addMemoToLegacyTransaction(tx, `claim-dbc-partner-fee:${pool.toBase58()}`, wallet.publicKey);

      if (params.sendTransaction) {
        sig = await params.sendTransaction(tx, connection, { skipPreflight: false, maxRetries: 3 });
      } else {
        const signedTx = await wallet.signTransaction(tx);
        sig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false, maxRetries: 3 });
      }
      await connection.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed',
      );
    } catch (rpcError) {
      const e = rpcError as { name?: string; message?: string; code?: string | number };
      console.error('[claimDbcPartnerFee] tx failed', e);
      throw new Error(`claimDbcPartnerFee wallet/tx failed: ${e?.name ?? 'UnknownError'}: ${e?.message ?? 'No message'}`);
    }

    console.log('[claimDbcPartnerFee] rpc success', { sig });
    return { tx: sig, link: solscanLink(sig, params.network) };
  } catch (error) {
    console.error('[claimDbcPartnerFee] failed', error);
    throw error;
  }
}

// ─── Non-Admin: Claim DAMM v2 Position Fee ────────────────────────────────────

export async function claimDammV2PositionFee(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string }> {
  const program = createProgram(wallet, connection);
  const cpAmm = new CpAmm(connection);
  const pool = new PublicKey(params.poolAddress);

  const resolved = await resolveDammV2Position(connection, pool);
  if (!resolved) {
    throw new Error(`No vault-owned position found for DAMM v2 pool ${params.poolAddress}`);
  }
  const { position, positionNftAccount } = resolved;

  const poolState = await cpAmm.fetchPoolState(pool);
  const tokenAProgram = getTokenProgram(poolState.tokenAFlag);
  const tokenBProgram = getTokenProgram(poolState.tokenBFlag);
  const poolAuthority = derivePoolAuthority();
  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(pool, poolState.tokenAMint, poolState.tokenBMint);
  const feeClaimerPda = deriveFeeClaimerPda();
  const cpAmmEventAuthority = deriveCpAmmEventAuthority(DAMMV2_PROGRAM_ID);

  const sig: string = await programMethods(program)
    .claimPositionFee()
    .accounts({
      poolAuthority,
      pool,
      poolClaimers: poolClaimersPdaPubKey,
      position,
      baseFeeVault,
      quoteFeeVault,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      positionNftAccount,
      tokenAProgram,
      tokenBProgram,
      eventAuthority: cpAmmEventAuthority,
      cpAmmProgram: DAMMV2_PROGRAM_ID,
      payer: wallet.publicKey,
      feeClaimer: feeClaimerPda,
    })
    .preInstructions([createMemoInstruction(`claim-damm-v2-position-fee:${pool.toBase58()}`, [wallet.publicKey])])
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network) };
}

// ─── Non-Admin: Distribute Fees ───────────────────────────────────────────────

export async function distributeFees(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    mode: 'dbc' | 'damm-v2';
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string; ataTx?: string }> {
  const program = createProgram(wallet, connection);
  const pool = new PublicKey(params.poolAddress);

  const poolTokens = await resolvePoolTokensByMode(connection, pool, params.mode);
  const { baseMint, quoteMint, tokenBaseProgram: baseTokenProgram, tokenQuoteProgram: quoteTokenProgram } =
    poolTokens;

  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(pool, baseMint, quoteMint);
  const feeClaimerPda = deriveFeeClaimerPda();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onchainPoolState: any = await (program.account as any).poolClaimers.fetch(poolClaimersPdaPubKey);

  const createAtaIxs = onchainPoolState.claimerAddresses.flatMap((claimerAddr: PublicKey) => [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(baseMint, claimerAddr, false, baseTokenProgram),
      claimerAddr, baseMint, baseTokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(quoteMint, claimerAddr, false, quoteTokenProgram),
      claimerAddr, quoteMint, quoteTokenProgram,
    ),
  ]);

  let ataTx: string | undefined;
  if (createAtaIxs.length > 0) {
    const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
    const createAtaTransaction = new Transaction().add(...createAtaIxs);
    addMemoToLegacyTransaction(createAtaTransaction, `distribute-fees-create-atas:${pool.toBase58()}`, wallet.publicKey);
    ataTx = await provider.sendAndConfirm(createAtaTransaction);
  }

  const remainingAccounts = buildDistributeFeesRemainingAccounts(
    pool,
    onchainPoolState.claimerAddresses as PublicKey[],
    baseMint, quoteMint, baseTokenProgram, quoteTokenProgram,
  );

  const sig: string = await programMethods(program)
    .distributeFees()
    .accounts({
      caller: wallet.publicKey,
      pool,
      poolClaimers: poolClaimersPdaPubKey,
      baseFeeVault,
      quoteFeeVault,
      baseMint,
      quoteMint,
      feeClaimer: feeClaimerPda,
      tokenBaseProgram: baseTokenProgram,
      tokenQuoteProgram: quoteTokenProgram,
    })
    .remainingAccounts(remainingAccounts)
    .preInstructions([createMemoInstruction(`distribute-fees:${pool.toBase58()}`, [wallet.publicKey])])
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network), ataTx };
}

// ─── Non-Admin: Claim + Distribute DBC Fees (one transaction) ────────────────

export async function claimAndDistributeFeesDbc(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    network: 'devnet' | 'mainnet';
    altAddress: string;
    sendTransaction?: (
      tx: VersionedTransaction,
      connection: Connection,
      options?: { skipPreflight?: boolean; maxRetries?: number },
    ) => Promise<string>;
  },
): Promise<{ tx: string; link: string }> {
  const program = createProgram(wallet, connection);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const pool = new PublicKey(params.poolAddress);

  const poolAccountInfo = await connection.getAccountInfo(pool, 'confirmed');
  if (!poolAccountInfo) throw new Error(`Pool account not found: ${pool.toBase58()}`);
  if (!poolAccountInfo.owner.equals(DBC_PROGRAM_ID)) {
    throw new Error(
      `Invalid pool address for DBC. Expected owner ${DBC_PROGRAM_ID.toBase58()} but got ${poolAccountInfo.owner.toBase58()}.`,
    );
  }

  const dbcPoolState = await client.state.getPool(pool);
  const dbcPoolConfig4 = await client.state.getPoolConfig(dbcPoolState.config);
  const baseMint = dbcPoolState.baseMint;
  const quoteMint = dbcPoolConfig4.quoteMint;
  const baseTokenProgram = TOKEN_2022_PROGRAM_ID;
  const quoteTokenProgram = getTokenProgram(dbcPoolConfig4.quoteTokenFlag);

  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(pool, baseMint, quoteMint);
  const feeClaimerPda = deriveFeeClaimerPda();

  const claimIx = await programMethods(program)
    .claimPartnerTradingFee(
      new BN('18446744073709551615'),
      new BN('18446744073709551615'),
    )
    .accounts({
      poolAuthority: dbcPoolAuthority,
      config: dbcPoolState.config,
      pool,
      poolClaimers: poolClaimersPdaPubKey,
      baseFeeVault,
      quoteFeeVault,
      basePoolVault: dbcPoolState.baseVault,
      quotePoolVault: dbcPoolState.quoteVault,
      baseMint,
      quoteMint,
      feeClaimer: feeClaimerPda,
      tokenBaseProgram: baseTokenProgram,
      tokenQuoteProgram: quoteTokenProgram,
      eventAuthority: dbcEventAuthority,
      dbcProgram: DBC_PROGRAM_ID,
      payer: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onchainPoolState: any = await (program.account as any).poolClaimers.fetch(poolClaimersPdaPubKey);
  const claimerAddresses = onchainPoolState.claimerAddresses as PublicKey[];

  const createAtaIxs = claimerAddresses.flatMap((claimerAddr) => [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(baseMint, claimerAddr, false, baseTokenProgram),
      claimerAddr, baseMint, baseTokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(quoteMint, claimerAddr, false, quoteTokenProgram),
      claimerAddr, quoteMint, quoteTokenProgram,
    ),
  ]);

  const remainingAccounts = buildDistributeFeesRemainingAccounts(
    pool, claimerAddresses, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram,
  );

  const distributeIx = await programMethods(program)
    .distributeFees()
    .accounts({
      caller: wallet.publicKey,
      pool,
      poolClaimers: poolClaimersPdaPubKey,
      baseFeeVault,
      quoteFeeVault,
      baseMint,
      quoteMint,
      feeClaimer: feeClaimerPda,
      tokenBaseProgram: baseTokenProgram,
      tokenQuoteProgram: quoteTokenProgram,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  const { sig, blockhash, lastValidBlockHeight } = await sendV0Transaction(
    connection,
    wallet,
    [claimIx, ...createAtaIxs, distributeIx],
    params.altAddress,
    params.sendTransaction,
    { flow: 'claim_and_distribute_dbc', poolAddress: params.poolAddress },
  );

  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  return { tx: sig, link: solscanLink(sig, params.network) };
}

// ─── Non-Admin: Claim + Distribute DAMM v2 Fees (one transaction) ────────────

export async function claimAndDistributeFeesDammV2(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    network: 'devnet' | 'mainnet';
    altAddress: string;
    sendTransaction?: (
      tx: VersionedTransaction,
      connection: Connection,
      options?: { skipPreflight?: boolean; maxRetries?: number },
    ) => Promise<string>;
  },
): Promise<{ tx: string; link: string }> {
  const program = createProgram(wallet, connection);
  const cpAmm = new CpAmm(connection);
  const pool = new PublicKey(params.poolAddress);

  const resolved = await resolveDammV2Position(connection, pool);
  if (!resolved) {
    throw new Error(`No vault-owned position found for DAMM v2 pool ${params.poolAddress}`);
  }
  const { position, positionNftAccount } = resolved;

  const poolState = await cpAmm.fetchPoolState(pool);
  const baseMint = poolState.tokenAMint;
  const quoteMint = poolState.tokenBMint;
  const baseTokenProgram = getTokenProgram(poolState.tokenAFlag);
  const quoteTokenProgram = getTokenProgram(poolState.tokenBFlag);
  const poolAuthority = derivePoolAuthority();
  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(pool, baseMint, quoteMint);
  const feeClaimerPda = deriveFeeClaimerPda();
  const cpAmmEventAuthority = deriveCpAmmEventAuthority(DAMMV2_PROGRAM_ID);

  const claimIx = await programMethods(program)
    .claimPositionFee()
    .accounts({
      poolAuthority,
      pool,
      poolClaimers: poolClaimersPdaPubKey,
      position,
      baseFeeVault,
      quoteFeeVault,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: baseMint,
      tokenBMint: quoteMint,
      positionNftAccount,
      tokenAProgram: baseTokenProgram,
      tokenBProgram: quoteTokenProgram,
      eventAuthority: cpAmmEventAuthority,
      cpAmmProgram: DAMMV2_PROGRAM_ID,
      payer: wallet.publicKey,
      feeClaimer: feeClaimerPda,
    })
    .instruction();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onchainPoolState: any = await (program.account as any).poolClaimers.fetch(poolClaimersPdaPubKey);
  const claimerAddresses = onchainPoolState.claimerAddresses as PublicKey[];

  const createAtaIxs = claimerAddresses.flatMap((claimerAddr) => [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(baseMint, claimerAddr, false, baseTokenProgram),
      claimerAddr, baseMint, baseTokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(quoteMint, claimerAddr, false, quoteTokenProgram),
      claimerAddr, quoteMint, quoteTokenProgram,
    ),
  ]);

  const remainingAccounts = buildDistributeFeesRemainingAccounts(
    pool, claimerAddresses, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram,
  );

  const distributeIx = await programMethods(program)
    .distributeFees()
    .accounts({
      caller: wallet.publicKey,
      pool,
      poolClaimers: poolClaimersPdaPubKey,
      baseFeeVault,
      quoteFeeVault,
      baseMint,
      quoteMint,
      feeClaimer: feeClaimerPda,
      tokenBaseProgram: baseTokenProgram,
      tokenQuoteProgram: quoteTokenProgram,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  const { sig, blockhash, lastValidBlockHeight } = await sendV0Transaction(
    connection,
    wallet,
    [claimIx, ...createAtaIxs, distributeIx],
    params.altAddress,
    params.sendTransaction,
    { flow: 'claim_and_distribute_dammv2', poolAddress: params.poolAddress },
  );

  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  return { tx: sig, link: solscanLink(sig, params.network) };
}