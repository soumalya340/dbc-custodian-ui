'use client';

import { Buffer as NodeBuffer } from 'buffer';
if (typeof globalThis !== 'undefined' && !('Buffer' in globalThis)) {
  (globalThis as { Buffer?: typeof NodeBuffer }).Buffer = NodeBuffer;
}

import {
  PublicKey,
  Connection,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  BaseFeeMode,
  DammV2BaseFeeMode,
  DynamicBondingCurveClient,
  buildCurve,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import { deriveFeeClaimerPda } from './custodian';
import { solscanLink } from './solscanLink';

export interface CreateConfigAndPoolParams {
  migrationQuoteThreshold: number;
  name: string;
  symbol: string;
  uri: string;
  network: 'devnet' | 'mainnet';
}


const quoteMint = new PublicKey('So11111111111111111111111111111111111111112');

export async function createConfigAndPool(
  connection: Connection,
  wallet: AnchorWallet,
  params: CreateConfigAndPoolParams,
): Promise<{
  configTx: string;
  configTxLink: string;
  poolTx: string;
  poolTxLink: string;
  configAddress: string;
  poolAddress: string;
  baseMint: string;
}> {
  const { migrationQuoteThreshold, name, symbol, uri, network } = params;

  if (!Number.isFinite(migrationQuoteThreshold) || migrationQuoteThreshold <= 0) {
    throw new Error('Invalid migration quote threshold. Provide a positive number (e.g. 0.15).');
  }

  const feeClaimerPda = deriveFeeClaimerPda();
  const client = new DynamicBondingCurveClient(connection, 'confirmed');

  const config = Keypair.generate();
  const baseMint = Keypair.generate();

  // ── Build curve configuration with Market Cap Fee Scheduler ──

  const preMigrationEndingFeeBps = 500;
  const postMigrationEndingFeeBps = 1;
  const dammV2BaseFeeMode = DammV2BaseFeeMode.FeeMarketCapSchedulerLinear;

  const curveConfig = buildCurve({
    token: {
      tokenType: 1,
      tokenBaseDecimal: 9,
      tokenQuoteDecimal: 9,
      tokenUpdateAuthority: 1,
      totalTokenSupply: 1000000000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: 100,
          endingFeeBps: 100,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: 0,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: 1,
      migrationFeeOption: 6,
      migrationFee: {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
      migratedPoolFee: {
        collectFeeMode: 0,
        dynamicFee: 0,
        poolFeeBps: preMigrationEndingFeeBps,
        baseFeeMode: dammV2BaseFeeMode,
        marketCapFeeSchedulerParams: {
          endingBaseFeeBps: postMigrationEndingFeeBps,
          numberOfPeriod: 10,
          startingMarketCap: 20_000,
          endingMarketCap: 20_000_000,
          schedulerExpirationDuration: 86400 * 30,
        },
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 90,
      creatorLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 10,
      creatorPermanentLockedLiquidityPercentage: 0,
      partnerLiquidityVestingInfoParams: {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        totalDuration: 0,
      },
      creatorLiquidityVestingInfoParams: {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        totalDuration: 0,
      },
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: 1,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold,
  });

  // ── Build config instructions ──

  const configLegacyTx = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: feeClaimerPda,
    leftoverReceiver: feeClaimerPda,
    payer: wallet.publicKey,
    quoteMint,
    ...curveConfig,
  });

  const { blockhash: configBlockhash } = await connection.getLatestBlockhash('confirmed');
  const configMessageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: configBlockhash,
    instructions: configLegacyTx.instructions,
  }).compileToV0Message();

  const configVersionedTransaction = new VersionedTransaction(configMessageV0);
  configVersionedTransaction.sign([config]);
  const signedConfigTx = await wallet.signTransaction(configVersionedTransaction);
  const configSignature = await connection.sendTransaction(signedConfigTx, {
    skipPreflight: true,
    maxRetries: 3,
  });
  await connection.confirmTransaction(configSignature, 'confirmed');

  // ── Build and send pool tx only after config exists on-chain ──
  const createPoolLegacyTx = await client.pool.createPool({
    baseMint: baseMint.publicKey,
    config: config.publicKey,
    name,
    symbol,
    uri,
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
  });

  const { blockhash: poolBlockhash } = await connection.getLatestBlockhash('confirmed');
  const poolMessageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: poolBlockhash,
    instructions: createPoolLegacyTx.instructions,
  }).compileToV0Message();

  const poolVersionedTransaction = new VersionedTransaction(poolMessageV0);
  poolVersionedTransaction.sign([baseMint]);

  const signedPoolTx = await wallet.signTransaction(poolVersionedTransaction);
  
  const signature = await connection.sendTransaction(signedPoolTx, {
    skipPreflight: true,
    maxRetries: 3,
  });
  await connection.confirmTransaction(signature, 'confirmed');

  const poolAddress = deriveDbcPoolAddress(quoteMint, baseMint.publicKey, config.publicKey);

  return {
    configTx: configSignature,
    configTxLink: solscanLink(configSignature, network),
    poolTx: signature,
    poolTxLink: solscanLink(signature, network),
    configAddress: config.publicKey.toBase58(),
    poolAddress: poolAddress.toBase58(),
    baseMint: baseMint.publicKey.toBase58(),
  };
}
