'use client';

// Polyfill Buffer for Turbopack builds.
import { Buffer as NodeBuffer } from 'buffer';
if (typeof globalThis !== 'undefined' && !('Buffer' in globalThis)) {
  (globalThis as { Buffer?: typeof NodeBuffer }).Buffer = NodeBuffer;
}

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
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

// ─── Program IDs ─────────────────────────────────────────────────────────────

export const MY_DBC_CUSTODIAN_PROGRAM_ID = new PublicKey(
  '2VgCjezWK4kHxoute1Jy986AXVPvSkwquPX5VBVwQMzV',
);
export const DBC_PROGRAM_ID = new PublicKey(
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
);
export const DAMMV2_PROGRAM_ID = new PublicKey(
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
);
export const WSOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
);

import { solscanLink } from './solscanLink';

// ─── PDA helpers ─────────────────────────────────────────────────────────────

export function derivePoolClaimersPda(pool: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_claimers'), pool.toBuffer()],
    MY_DBC_CUSTODIAN_PROGRAM_ID,
  );
  return pda;
}

export function deriveFeeClaimerPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_claimer')],
    MY_DBC_CUSTODIAN_PROGRAM_ID,
  );
  return pda;
}

export function derivePoolFeeVaults(
  pool: PublicKey,
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
): { baseFeeVault: PublicKey; quoteFeeVault: PublicKey } {
  const [baseFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_vault'), pool.toBuffer(), tokenAMint.toBuffer()],
    MY_DBC_CUSTODIAN_PROGRAM_ID,
  );
  const [quoteFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_vault'), pool.toBuffer(), tokenBMint.toBuffer()],
    MY_DBC_CUSTODIAN_PROGRAM_ID,
  );
  return { baseFeeVault, quoteFeeVault };
}

export function deriveCpAmmEventAuthority(cpAmmProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    cpAmmProgramId,
  );
  return pda;
}

export const [dbcPoolAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('pool_authority')],
  DBC_PROGRAM_ID,
);
export const [dbcEventAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  DBC_PROGRAM_ID,
);

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
  // Use a dummy wallet for read-only — no signing needed
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

  const claimers: ClaimerInfo[] = state.claimerAddresses.map(
    (addr: PublicKey, i: number) => ({
      address: addr.toBase58(),
      bps: state.claimerBps[i],
      pct: `${(state.claimerBps[i] / 100).toFixed(2)}%`,
      claimedBase: state.claimedBase[i].toString(),
      claimedQuote: state.claimedQuote[i].toString(),
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

// ─── View: DBC Pool State ─────────────────────────────────────────────────────

export async function viewDbcPool(
  connection: Connection,
  poolAddress: string,
) {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const pool = new PublicKey(poolAddress);
  const state = await client.state.getPool(pool);
  return {
    pool: pool.toBase58(),
    config: state.config.toBase58(),
    baseMint: state.baseMint.toBase58(),
    quoteMint: WSOL_MINT.toBase58(),
    baseVault: state.baseVault.toBase58(),
    quoteVault: state.quoteVault.toBase58(),
  };
}

// ─── View: DAMM v2 Pool State ─────────────────────────────────────────────────

export async function viewDammV2Pool(
  connection: Connection,
  poolAddress: string,
) {
  const cpAmm = new CpAmm(connection);
  const pool = new PublicKey(poolAddress);
  const state = await cpAmm.fetchPoolState(pool);
  return {
    pool: pool.toBase58(),
    tokenAMint: state.tokenAMint.toBase58(),
    tokenBMint: state.tokenBMint.toBase58(),
    tokenAVault: state.tokenAVault.toBase58(),
    tokenBVault: state.tokenBVault.toBase58(),
    tokenAFlag: state.tokenAFlag,
    tokenBFlag: state.tokenBFlag,
  };
}

// ─── View: DAMM v2 Position Info ──────────────────────────────────────────────

export async function viewDammV2Position(
  connection: Connection,
  nftMint: string,
) {
  const cpAmm = new CpAmm(connection);
  const nftMintPk = new PublicKey(nftMint);

  const position = derivePositionAddress(nftMintPk);
  const positionNftAccount = derivePositionNftAccount(nftMintPk);

  const positionAccountInfo = await connection.getAccountInfo(position);
  if (!positionAccountInfo) {
    throw new Error(`Position account not found for NFT mint ${nftMint}`);
  }

  const positionState = await cpAmm.fetchPositionState(position);
  const pool = positionState.pool;
  const poolState = await cpAmm.fetchPoolState(pool);
  const unclaimedFees = getUnClaimLpFee(poolState, positionState);

  return {
    pool: pool.toBase58(),
    position: position.toBase58(),
    positionNftAccount: positionNftAccount.toBase58(),
    tokenAMint: poolState.tokenAMint.toBase58(),
    tokenBMint: poolState.tokenBMint.toBase58(),
    unclaimedFeeA: unclaimedFees.feeTokenA.toString(),
    unclaimedFeeB: unclaimedFees.feeTokenB.toString(),
  };
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

async function getTokenDisplayInfo(
  connection: Connection,
  mint: PublicKey,
): Promise<TokenDisplayInfo> {
  if (mint.equals(WSOL_MINT)) {
    return { name: 'Solana', symbol: 'SOL' };
  }

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
      // Continue to generic fallback below.
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

  const uniqueMintStrings = [
    ...new Set(
      positionsRaw.flatMap((p) => [p.tokenAMint, p.tokenBMint]),
    ),
  ];
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

  return {
    vaultPubkey: vault.toBase58(),
    totalPositions: positions.length,
    positions,
  };
}

// ─── Admin: Set Pool Claimers ─────────────────────────────────────────────────

export interface ClaimerEntry {
  address: string;
  bps: number;
}

export async function setPoolClaimers(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    mode: 'dbc' | 'damm-v2';
    claimers: ClaimerEntry[];
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string }> {
  const program = createProgram(wallet, connection);
  const pool = new PublicKey(params.poolAddress);
  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);

  const claimerPubkeys = params.claimers.map((c) => new PublicKey(c.address));
  const bps = params.claimers.map((c) => c.bps);
  const poolState = params.mode === 'dbc' ? { dbc: {} } : { dammV2: {} };

  const sig: string = await programMethods(program)
    .setPoolClaimers(claimerPubkeys, bps, poolState)
    .accounts({
      deployer: wallet.publicKey,
      pool,
      poolClaimersPdaPubKey,
    })
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network) };
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

  const claimerPubkeys = params.claimers.map((c) => new PublicKey(c.address));
  const bps = params.claimers.map((c) => c.bps);

  const sig: string = await programMethods(program)
    .updateClaimersBps(claimerPubkeys, bps)
    .accounts({
      deployer: wallet.publicKey,
      pool,
      poolClaimers: poolClaimersPdaPubKey,
    })
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network) };
}

// ─── Non-Admin: Claim DBC Partner Trading Fee ─────────────────────────────────

export async function claimDbcPartnerFee(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    poolAddress: string;
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string }> {
  const program = createProgram(wallet, connection);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const pool = new PublicKey(params.poolAddress);

  const dbcPoolState = await client.state.getPool(pool);
  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(
    pool,
    dbcPoolState.baseMint,
    WSOL_MINT,
  );
  const feeClaimerPda = deriveFeeClaimerPda();

  const sig: string = await programMethods(program)
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
      quoteMint: WSOL_MINT,
      feeClaimer: feeClaimerPda,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      eventAuthority: dbcEventAuthority,
      dbcProgram: DBC_PROGRAM_ID,
      payer: wallet.publicKey,
    })
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network) };
}

// ─── Non-Admin: Claim DAMM v2 Position Fee ────────────────────────────────────

export async function claimDammV2PositionFee(
  connection: Connection,
  wallet: AnchorWallet,
  params: {
    nftMint: string;
    network: 'devnet' | 'mainnet';
  },
): Promise<{ tx: string; link: string }> {
  const program = createProgram(wallet, connection);
  const cpAmm = new CpAmm(connection);
  const nftMintPk = new PublicKey(params.nftMint);

  const position = derivePositionAddress(nftMintPk);
  const positionNftAccount = derivePositionNftAccount(nftMintPk);

  const positionAccountInfo = await connection.getAccountInfo(position);
  if (!positionAccountInfo) {
    throw new Error(`Position account not found for NFT mint ${params.nftMint}`);
  }

  const positionState = await cpAmm.fetchPositionState(position);
  const pool = positionState.pool;
  const poolState = await cpAmm.fetchPoolState(pool);

  const tokenAProgram = getTokenProgram(poolState.tokenAFlag);
  const tokenBProgram = getTokenProgram(poolState.tokenBFlag);
  const poolAuthority = derivePoolAuthority();
  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(
    pool,
    poolState.tokenAMint,
    poolState.tokenBMint,
  );
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
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const cpAmm = new CpAmm(connection);
  const pool = new PublicKey(params.poolAddress);

  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let baseTokenProgram: PublicKey;
  let quoteTokenProgram: PublicKey;

  if (params.mode === 'dbc') {
    const dbcPoolState = await client.state.getPool(pool);
    baseMint = dbcPoolState.baseMint;
    quoteMint = WSOL_MINT;
    baseTokenProgram = TOKEN_2022_PROGRAM_ID;
    quoteTokenProgram = TOKEN_PROGRAM_ID;
  } else {
    const poolState = await cpAmm.fetchPoolState(pool);
    baseMint = poolState.tokenAMint;
    quoteMint = poolState.tokenBMint;
    baseTokenProgram = getTokenProgram(poolState.tokenAFlag);
    quoteTokenProgram = getTokenProgram(poolState.tokenBFlag);
  }

  const poolClaimersPdaPubKey = derivePoolClaimersPda(pool);
  const { baseFeeVault, quoteFeeVault } = derivePoolFeeVaults(pool, baseMint, quoteMint);
  const feeClaimerPda = deriveFeeClaimerPda();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onchainPoolState: any = await (program.account as any).poolClaimers.fetch(poolClaimersPdaPubKey);

  // Create all claimer ATAs idempotently
  const createAtaIxs = onchainPoolState.claimerAddresses.flatMap((claimerAddr: PublicKey) => [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(baseMint, claimerAddr, false, baseTokenProgram),
      claimerAddr,
      baseMint,
      baseTokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      getAssociatedTokenAddressSync(quoteMint, claimerAddr, false, quoteTokenProgram),
      claimerAddr,
      quoteMint,
      quoteTokenProgram,
    ),
  ]);

  let ataTx: string | undefined;
  if (createAtaIxs.length > 0) {
    const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
    const createAtaTransaction = new Transaction().add(...createAtaIxs);
    ataTx = await provider.sendAndConfirm(createAtaTransaction);
  }

  const remainingAccounts = onchainPoolState.claimerAddresses.flatMap(
    (claimerAddr: PublicKey) => [
      {
        pubkey: getAssociatedTokenAddressSync(baseMint, claimerAddr, false, baseTokenProgram),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: getAssociatedTokenAddressSync(quoteMint, claimerAddr, false, quoteTokenProgram),
        isSigner: false,
        isWritable: true,
      },
    ],
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
    .rpc();

  return { tx: sig, link: solscanLink(sig, params.network), ataTx };
}
