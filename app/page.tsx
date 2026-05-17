'use client';

import { useState } from 'react';
import { useConnection, useWallet, useAnchorWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Providers, getRpcEndpoint } from '@/app/providers';
import {
  viewPoolClaimers,
  viewClaimerPoolInfo,
  viewFeeVaultBalances,
  viewVaultAllTokenInfo,
  viewDammV2PoolInfo,
  initializePoolClaimers,
  updateClaimersBps,
  setClaimerEnabled,
  adminSweepClaimer,
  claimDbcPartnerFee,
  claimDammV2PositionFee,
  distributeFees,
  claimAndDistributeFeesDbc,
  claimAndDistributeFeesDammV2,
} from '@/lib/custodian';
import { createConfigAndPool } from '@/lib/createConfigAndPool';

// ─── Types ──────────────────────────────────────────────────────────────────

type Network = 'devnet' | 'mainnet';
type SectionId = 'view' | 'non_admin' | 'admin';

interface FieldDef {
  name: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'select' | 'textarea' | 'claimers' | 'claimers_live';
  options?: { label: string; value: string }[];
  hint?: string;
}

interface FunctionDef {
  id: string;
  number: string;
  title: string;
  description: string;
  fields: FieldDef[];
  submitLabel: string;
}

// ─── Data ────────────────────────────────────────────────────────────────────

const VIEW_FUNCTIONS: FunctionDef[] = [
  {
    id: 'view_pool_claimers',
    number: '1A',
    title: 'View Pool Info',
    description: 'Fetch the on-chain PoolClaimers PDA for a given pool — claimers list, BPS splits, claimed amounts, and timestamps.',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey (DBC or DAMM v2)' },
    ],
    submitLabel: 'Fetch Pool Claimers',
  },
  {
    id: 'view_fee_vaults',
    number: '1B',
    title: 'View Fee Vault Balances',
    description: 'Check the current token balances in the program-owned fee vaults for a pool.',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey' },
      { name: 'base_mint', label: 'Base Mint', placeholder: 'Base token mint pubkey' },
      { name: 'quote_mint', label: 'Quote Mint', placeholder: 'Quote token mint pubkey (wSOL for DBC)' },
    ],
    submitLabel: 'Fetch Fee Vaults',
  },
  {
    id: 'view_vault_all_token_info',
    number: '1C',
    title: 'Vault All Token Info',
    description: 'Derive the vault pubkey and fetch all DAMM v2 position NFTs currently held by that vault, including pool/token info and unclaimed fees.',
    fields: [],
    submitLabel: 'Fetch Vault Token Info',
  },
  {
    id: 'view_claimer_pool_info',
    number: '1D',
    title: 'Claimer Pool Info',
    description:
      'Fetch the on-chain ClaimerState PDA for a pool + claimer — enabled flag and cumulative claimed base/quote (excludes bump).',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey (DBC or DAMM v2)' },
      { name: 'claimer_address', label: 'Claimer Address', placeholder: 'Claimer wallet pubkey' },
    ],
    submitLabel: 'Fetch Claimer Pool Info',
  },
  {
    id: 'view_dammv2_pool_info',
    number: '1E',
    title: 'DAMM v2 Pool Info',
    description: 'Fetch live on-chain state for a DAMM v2 liquidity pool — price, reserves, fees, liquidity, positions, and token metadata.',
    fields: [
      { name: 'pool_address', label: 'DAMM v2 Pool Address', placeholder: 'DAMM v2 pool pubkey' },
    ],
    submitLabel: 'Fetch Pool Info',
  },
];

const NON_ADMIN_FUNCTIONS: FunctionDef[] = [
  {
    id: 'create_config_and_pool',
    number: '2A',
    title: 'Create Config & Pool',
    description: 'Creates a new DBC config and pool in a single transaction. Generates config and base mint keypairs automatically.',
    fields: [
      { name: 'migration_quote_threshold', label: 'Migration Quote Threshold (SOL)', type: 'number', placeholder: '0.15' },
      { name: 'token_name', label: 'Token Name', placeholder: 'e.g. MyToken' },
      { name: 'token_symbol', label: 'Token Symbol', placeholder: 'e.g. MTK' },
      { name: 'token_uri', label: 'Token URI', placeholder: 'https://...' },
    ],
    submitLabel: 'Create Config & Pool',
  },
  {
    id: 'claim_dbc_fee',
    number: '2B',
    title: 'Claim DBC Partner Trading Fee',
    description: "Permissionless — sweeps all accrued partner trading fees from a DBC pool into this program's PDA-owned fee vaults. Anyone can call this.",
    fields: [
      { name: 'pool_address', label: 'DBC Pool Address', placeholder: 'DBC pool pubkey' },
    ],
    submitLabel: 'Claim DBC Fees',
  },
  {
    id: 'claim_dammv2_fee',
    number: '2C',
    title: 'Claim DAMM v2 Position Fee',
    description: "Claims accumulated LP position fees from a DAMM v2 pool into this program's fee vaults. Pass the DAMM v2 pool address — the vault-owned position is resolved automatically.",
    fields: [
      { name: 'pool_address', label: 'DAMM v2 Pool Address', placeholder: 'DAMM v2 pool pubkey' },
    ],
    submitLabel: 'Claim Position Fees',
  },
  {
    id: 'distribute_fees',
    number: '2D',
    title: 'Distribute Fees',
    description: 'Distributes accumulated fee vault balances proportionally to all registered claimers (based on BPS). Creates claimer ATAs if needed (first tx), then distributes (second tx).',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey (DBC or DAMM v2)' },
      {
        name: 'mode',
        label: 'Pool Mode',
        type: 'select',
        options: [
          { label: 'DBC', value: 'dbc' },
          { label: 'DAMM v2', value: 'damm-v2' },
        ],
      },
    ],
    submitLabel: 'Distribute Fees',
  },
  {
    id: 'claim_and_distribute_dbc',
    number: '2E',
    title: 'Claim + Distribute DBC Fees (One Tx)',
    description: 'One-shot for end users — claims DBC partner trading fees, creates any missing claimer ATAs, and distributes to all registered claimers in a single transaction (single wallet signature).',
    fields: [
      { name: 'pool_address', label: 'DBC Pool Address', placeholder: 'DBC pool pubkey' },
      { name: 'alt_address', label: 'ALT Address (required)', placeholder: 'Address Lookup Table pubkey from Set Pool Claimers result' },
    ],
    submitLabel: 'Claim + Distribute (DBC)',
  },
  {
    id: 'claim_and_distribute_dammv2',
    number: '2F',
    title: 'Claim + Distribute DAMM v2 Fees (One Tx)',
    description: 'One-shot for end users — claims DAMM v2 LP position fees into the vault, creates any missing claimer ATAs, and distributes to all registered claimers in a single transaction (single wallet signature).',
    fields: [
      { name: 'pool_address', label: 'DAMM v2 Pool Address', placeholder: 'DAMM v2 pool pubkey' },
      { name: 'alt_address', label: 'ALT Address (required)', placeholder: 'Address Lookup Table pubkey from Set Pool Claimers result' },
    ],
    submitLabel: 'Claim + Distribute (DAMM v2)',
  },
];

const ADMIN_FUNCTIONS: FunctionDef[] = [
  {
    id: 'set_pool_claimers',
    number: '3A',
    title: 'Set Pool Claimers',
    description: 'Admin-only. Initialize or reset the claimers list and BPS distribution for a pool. Resets all claimed amounts. Total BPS should sum to 10000.',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey (DBC or DAMM v2)' },
      {
        name: 'mode',
        label: 'Pool Mode',
        type: 'select',
        options: [
          { label: 'DBC', value: 'dbc' },
          { label: 'DAMM v2', value: 'damm-v2' },
        ],
      },
      {
        name: 'claimers_json',
        label: 'Claimers',
        type: 'claimers',
        hint: 'Total BPS must sum to 10,000.',
      },
    ],
    submitLabel: 'Set Pool Claimers',
  },
  {
    id: 'update_claimers_bps',
    number: '3B',
    title: 'Update Claimers BPS',
    description: 'Admin-only. Fetch the current claimers and BPS for a pool, then update the splits without resetting claimed amounts. Total BPS must sum to 10,000.',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey (DBC or DAMM v2)' },
      {
        name: 'claimers_json',
        label: 'Claimers',
        type: 'claimers_live',
        hint: 'Total BPS must sum to 10,000.',
      },
    ],
    submitLabel: 'Update BPS',
  },
  {
    id: 'admin_locked_amount_withdraw',
    number: '3C',
    title: 'Admin Locked Asset Recovery & Distribution',
    description:
      'Admin-only. Moves tokens from a registered claimer’s pending vaults (locked amounts, e.g. after distributeFees parked funds for a disabled claimer) into the recipient’s base and quote ATAs. Creates recipient ATAs if needed, then sweeps.',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey (DBC or DAMM v2)' },
      {
        name: 'mode',
        label: 'Pool Mode',
        type: 'select',
        options: [
          { label: 'DBC', value: 'dbc' },
          { label: 'DAMM v2', value: 'damm-v2' },
        ],
      },
      {
        name: 'claimer_address',
        label: 'Claimer Address',
        placeholder: 'Registered claimer pubkey (pending vault owner)',
      },
      {
        name: 'recipient_address',
        label: 'Recipient Address',
        placeholder: 'Wallet that receives the swept tokens (destination ATAs)',
      },
    ],
    submitLabel: 'Admin Locked Amount Withdraw and Transfer',
  },
  {
    id: 'set_claimer_status',
    number: '3D',
    title: 'Set Claim Status',
    description:
      'Admin-only. Enables or disables a claimer for live distribute_fees payouts (disabled claimers receive fees into pending vaults instead).',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey (DBC or DAMM v2)' },
      { name: 'claimer_address', label: 'Claimer Address', placeholder: 'Claimer wallet pubkey' },
      {
        name: 'enabled',
        label: 'Status',
        type: 'select',
        options: [
          { label: 'Enabled', value: 'true' },
          { label: 'Disabled', value: 'false' },
        ],
      },
    ],
    submitLabel: 'Set Claim Status',
  },
];

// ─── Section colors ──────────────────────────────────────────────────────────

const SECTION_STYLE: Record<SectionId, { badge: string; accent: string; glow: string }> = {
  view:      { badge: 'bg-cyan-900/60 text-cyan-300 border-cyan-700/50',       accent: '#06b6d4', glow: 'rgba(6,182,212,0.15)' },
  non_admin: { badge: 'bg-violet-900/60 text-violet-300 border-violet-700/50', accent: '#8b5cf6', glow: 'rgba(139,92,246,0.15)' },
  admin:     { badge: 'bg-rose-900/60 text-rose-300 border-rose-700/50',       accent: '#f43f5e', glow: 'rgba(244,63,94,0.15)' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REQUIRES_WALLET = new Set([
  'create_config_and_pool', 'claim_dbc_fee', 'claim_dammv2_fee', 'distribute_fees',
  'claim_and_distribute_dbc', 'claim_and_distribute_dammv2',
  'set_pool_claimers', 'update_claimers_bps', 'admin_locked_amount_withdraw', 'set_claimer_status',
]);

function formatResult(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}

// ─── Claimers Input ──────────────────────────────────────────────────────────

interface ClaimerRow {
  address: string;
  bps: string;
}

function ClaimersInput({
  value,
  onChange,
  accent,
}: {
  value: string;
  onChange: (json: string) => void;
  accent: string;
}) {
  const parseRows = (json: string): ClaimerRow[] => {
    try {
      const arr = JSON.parse(json);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((c: { address?: string; bps?: number }) => ({
          address: c.address ?? '',
          bps: c.bps != null ? String(c.bps) : '',
        }));
      }
    } catch { /* ignore */ }
    return [{ address: '', bps: '' }];
  };

  const [rows, setRows] = useState<ClaimerRow[]>(() => parseRows(value));

  const syncToParent = (updated: ClaimerRow[]) => {
    const arr = updated
      .filter(r => r.address.trim() !== '' || r.bps.trim() !== '')
      .map(r => ({ address: r.address.trim(), bps: Number(r.bps) || 0 }));
    onChange(JSON.stringify(arr));
  };

  const updateRow = (idx: number, key: keyof ClaimerRow, val: string) => {
    const updated = rows.map((r, i) => (i === idx ? { ...r, [key]: val } : r));
    setRows(updated);
    syncToParent(updated);
  };

  const addRow = () => {
    const updated = [...rows, { address: '', bps: '' }];
    setRows(updated);
  };

  const removeRow = (idx: number) => {
    if (rows.length <= 1) return;
    const updated = rows.filter((_, i) => i !== idx);
    setRows(updated);
    syncToParent(updated);
  };

  const totalBps = rows.reduce((sum, r) => sum + (Number(r.bps) || 0), 0);
  const isValid = totalBps === 10000;

  return (
    <div className="sm:col-span-2 space-y-2">
      {rows.map((row, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <div className="flex-1">
            {idx === 0 && <label className="block text-xs font-medium text-slate-300 mb-1">Address</label>}
            <input
              type="text"
              placeholder="Claimer pubkey"
              value={row.address}
              onChange={e => updateRow(idx, 'address', e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600"
              style={{ background: '#161626', border: '1px solid #2a2a40' }}
            />
          </div>
          <div className="w-28">
            {idx === 0 && <label className="block text-xs font-medium text-slate-300 mb-1">BPS</label>}
            <input
              type="number"
              placeholder="5000"
              value={row.bps}
              onChange={e => updateRow(idx, 'bps', e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600"
              style={{ background: '#161626', border: '1px solid #2a2a40' }}
            />
          </div>
          <button
            type="button"
            onClick={() => removeRow(idx)}
            disabled={rows.length <= 1}
            className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-sm text-slate-500 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ background: '#161626', border: '1px solid #2a2a40', marginTop: idx === 0 ? '20px' : '0' }}
          >
            &times;
          </button>
        </div>
      ))}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
          style={{ background: accent + '18', color: accent, border: `1px solid ${accent}44` }}
        >
          + Add More Claimers
        </button>
        <span
          className="text-xs font-mono font-semibold px-2 py-1 rounded-lg"
          style={{
            background: isValid ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            color: isValid ? '#4ade80' : '#f87171',
            border: `1px solid ${isValid ? '#16a34a44' : '#dc262644'}`,
          }}
        >
          {totalBps.toLocaleString()} / 10,000 BPS
        </span>
      </div>
    </div>
  );
}

// ─── Claimers Live Input ─────────────────────────────────────────────────────
// Fetches on-chain PoolClaimers state, shows current claimers as an editable
// table, and lets the admin adjust BPS before submitting.

function ClaimersLiveInput({
  poolAddress,
  value,
  onChange,
  accent,
  connection,
}: {
  poolAddress: string;
  value: string;
  onChange: (json: string) => void;
  accent: string;
  connection: import('@solana/web3.js').Connection;
}) {
  const parseRows = (json: string): ClaimerRow[] => {
    try {
      const arr = JSON.parse(json);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((c: { address?: string; bps?: number }) => ({
          address: c.address ?? '',
          bps: c.bps != null ? String(c.bps) : '',
        }));
      }
    } catch { /* ignore */ }
    return [];
  };

  const [rows, setRows] = useState<ClaimerRow[]>(() => parseRows(value));
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  const syncToParent = (updated: ClaimerRow[]) => {
    const arr = updated
      .filter(r => r.address.trim() !== '')
      .map(r => ({ address: r.address.trim(), bps: Number(r.bps) || 0 }));
    onChange(JSON.stringify(arr));
  };

  const fetchClaimers = async () => {
    if (!poolAddress.trim()) {
      setFetchError('Enter a Pool Address above first.');
      return;
    }
    setFetching(true);
    setFetchError(null);
    try {
      const state = await viewPoolClaimers(connection, poolAddress.trim());
      const loaded = state.claimers.map(c => ({ address: c.address, bps: String(c.bps) }));
      setRows(loaded);
      syncToParent(loaded);
      setFetched(true);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const updateRow = (idx: number, key: keyof ClaimerRow, val: string) => {
    const updated = rows.map((r, i) => (i === idx ? { ...r, [key]: val } : r));
    setRows(updated);
    syncToParent(updated);
  };

  const totalBps = rows.reduce((sum, r) => sum + (Number(r.bps) || 0), 0);
  const isValid = totalBps === 10000;

  return (
    <div className="sm:col-span-2 space-y-3">
      {/* Fetch button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={fetchClaimers}
          disabled={fetching}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: accent + '22', color: accent, border: `1px solid ${accent}55` }}
        >
          {fetching ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
              Fetching...
            </>
          ) : fetched ? 'Re-fetch Current Claimers' : 'Fetch Current Claimers'}
        </button>
        {fetched && !fetching && (
          <span className="text-xs text-slate-400">{rows.length} claimer{rows.length !== 1 ? 's' : ''} loaded</span>
        )}
      </div>

      {fetchError && (
        <div className="text-xs text-red-400 px-3 py-2 rounded-lg" style={{ background: '#1a0a0a', border: '1px solid #7f1d1d' }}>
          {fetchError}
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Table header */}
          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #2a2a40' }}>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: '#161626', borderBottom: '1px solid #2a2a40' }}>
                  <th className="px-3 py-2 text-left font-medium text-slate-400 w-6">#</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-400">Claimer Address</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-400 w-28">BPS (0–10000)</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-400 w-16">%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  const bpsNum = Number(row.bps) || 0;
                  const pct = (bpsNum / 100).toFixed(2);
                  const bpsInvalid = bpsNum < 0 || bpsNum > 10000;
                  return (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: idx < rows.length - 1 ? '1px solid #1e1e30' : 'none',
                        background: idx % 2 === 0 ? '#0e0e1a' : '#0a0a16',
                      }}
                    >
                      <td className="px-3 py-2 text-slate-500 font-mono">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <span
                          className="font-mono text-slate-300 text-xs"
                          title={row.address}
                        >
                          {row.address.slice(0, 8)}...{row.address.slice(-8)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          max={10000}
                          value={row.bps}
                          onChange={e => updateRow(idx, 'bps', e.target.value)}
                          className="w-full rounded px-2 py-1 text-right text-white font-mono text-xs"
                          style={{
                            background: '#161626',
                            border: `1px solid ${bpsInvalid ? '#dc2626' : '#2a2a40'}`,
                          }}
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-mono" style={{ color: accent }}>
                        {pct}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#161626', borderTop: '1px solid #2a2a40' }}>
                  <td colSpan={2} className="px-3 py-2 text-xs text-slate-400 font-semibold">Total</td>
                  <td className="px-3 py-2 text-right font-mono font-bold" style={{ color: isValid ? '#4ade80' : '#f87171' }}>
                    {totalBps.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs" style={{ color: isValid ? '#4ade80' : '#f87171' }}>
                    {(totalBps / 100).toFixed(2)}%
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* BPS validity badge */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Edit BPS per row — must total exactly 10,000</span>
            <span
              className="text-xs font-mono font-semibold px-2 py-1 rounded-lg"
              style={{
                background: isValid ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                color: isValid ? '#4ade80' : '#f87171',
                border: `1px solid ${isValid ? '#16a34a44' : '#dc262644'}`,
              }}
            >
              {isValid ? '✓ 10,000 / 10,000' : `${totalBps.toLocaleString()} / 10,000`}
            </span>
          </div>
        </>
      )}

      {rows.length === 0 && !fetching && fetched && (
        <p className="text-xs text-slate-500 italic">No claimers found for this pool.</p>
      )}

      {rows.length === 0 && !fetched && (
        <p className="text-xs text-slate-500 italic">Click &quot;Fetch Current Claimers&quot; to load the on-chain state.</p>
      )}
    </div>
  );
}

// ─── Accordion Item ───────────────────────────────────────────────────────────

function AccordionItem({
  fn,
  section,
  network,
}: {
  fn: FunctionDef;
  section: SectionId;
  network: Network;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ type: 'info' | 'success' | 'error'; text: string; solscan?: string; altAddress?: string; jupiterLink?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const { publicKey, connected, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const style = SECTION_STYLE[section];
  const needsWallet = REQUIRES_WALLET.has(fn.id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (needsWallet && !connected) {
      setVisible(true);
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      let data: unknown;
      const net = network;

      // ── View ──
      if (fn.id === 'view_pool_claimers') {
        data = await viewPoolClaimers(connection, values.pool_address);
      } else if (fn.id === 'view_fee_vaults') {
        data = await viewFeeVaultBalances(connection, values.pool_address, values.base_mint, values.quote_mint);
      } else if (fn.id === 'view_vault_all_token_info') {
        data = await viewVaultAllTokenInfo(connection);
      } else if (fn.id === 'view_claimer_pool_info') {
        data = await viewClaimerPoolInfo(connection, values.pool_address, values.claimer_address);
      } else if (fn.id === 'view_dammv2_pool_info') {
        data = await viewDammV2PoolInfo(connection, values.pool_address);
      }

      // ── Non-Admin ──
      else if (fn.id === 'create_config_and_pool') {
        const r = await createConfigAndPool(connection, anchorWallet!, {
          migrationQuoteThreshold: Number(values.migration_quote_threshold),
          name: values.token_name,
          symbol: values.token_symbol,
          uri: values.token_uri,
          network: net,
        });
        data = {
          configAddress: r.configAddress,
          poolAddress: r.poolAddress,
          baseMint: r.baseMint,
          configTx: r.configTx,
          configTxLink: r.configTxLink,
          poolTx: r.poolTx,
          solscan: r.poolTxLink,
          jupiterLink: r.jupiterLink,
        };
      } else if (fn.id === 'claim_dbc_fee') {
        const r = await claimDbcPartnerFee(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          network: net,
          sendTransaction,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'claim_dammv2_fee') {
        const r = await claimDammV2PositionFee(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'distribute_fees') {
        const r = await distributeFees(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          mode: (values.mode ?? 'dbc') as 'dbc' | 'damm-v2',
          network: net,
        });
        data = { tx: r.tx, solscan: r.link, ataTx: r.ataTx };
      } else if (fn.id === 'claim_and_distribute_dbc') {
        const altAddress = values.alt_address?.trim();
        if (!altAddress) throw new Error('ALT Address is required — copy it from the Set Pool Claimers result.');
        const r = await claimAndDistributeFeesDbc(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          network: net,
          altAddress,
          sendTransaction,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'claim_and_distribute_dammv2') {
        const altAddress = values.alt_address?.trim();
        if (!altAddress) throw new Error('ALT Address is required — copy it from the Set Pool Claimers result.');
        const r = await claimAndDistributeFeesDammV2(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          network: net,
          altAddress,
          sendTransaction,
        });
        data = { tx: r.tx, solscan: r.link };
      }

      // ── Admin ──
      else if (fn.id === 'set_pool_claimers') {
        let claimers: { address: string; bps: number }[];
        try {
          claimers = JSON.parse(values.claimers_json);
        } catch {
          throw new Error('Invalid JSON in Claimers field. Expected: [{"address":"...","bps":5000},...]');
        }
        const r = await initializePoolClaimers(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          mode: (values.mode ?? 'dbc') as 'dbc' | 'damm-v2',
          claimers,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link, altAddress: r.altAddress };
      } else if (fn.id === 'update_claimers_bps') {
        let claimers: { address: string; bps: number }[];
        try {
          claimers = JSON.parse(values.claimers_json);
        } catch {
          throw new Error('Invalid JSON in Claimers field. Expected: [{"address":"...","bps":7000},...]');
        }
        const r = await updateClaimersBps(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          claimers,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'admin_locked_amount_withdraw') {
        const r = await adminSweepClaimer(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          mode: (values.mode ?? 'dbc') as 'dbc' | 'damm-v2',
          claimerAddress: values.claimer_address,
          recipientAddress: values.recipient_address,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link, ataTx: r.ataTx };
      } else if (fn.id === 'set_claimer_status') {
        const r = await setClaimerEnabled(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          claimerAddress: values.claimer_address,
          isEnabled: values.enabled === 'true',
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      }

      const solscanUrl =
        data && typeof data === 'object' && 'solscan' in data
          ? (data as { solscan: string }).solscan
          : undefined;
      const altAddressVal =
        data && typeof data === 'object' && 'altAddress' in data
          ? (data as { altAddress: string }).altAddress
          : undefined;
      const jupiterLinkVal =
        data && typeof data === 'object' && 'jupiterLink' in data
          ? (data as { jupiterLink: string }).jupiterLink
          : undefined;
      const displayData =
        data && typeof data === 'object'
          ? { ...(data as object), solscan: undefined, altAddress: undefined, jupiterLink: undefined }
          : data;
      setResult({ type: 'success', text: formatResult(displayData), solscan: solscanUrl, altAddress: altAddressVal, jupiterLink: jupiterLinkVal });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRejection =
        msg.toLowerCase().includes('user rejected') ||
        msg.toLowerCase().includes('rejected the request') ||
        msg.toLowerCase().includes('not been authorized by the user') ||
        msg.toLowerCase().includes('transaction cancelled') ||
        msg.toLowerCase().includes('transaction canceled') ||
        (err as { code?: number })?.code === 4001;
      setResult({
        type: isRejection ? 'info' : 'error',
        text: isRejection ? 'Transaction cancelled — you rejected the wallet signing request.' : msg,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="rounded-xl border transition-all duration-200"
      style={{
        borderColor: open ? style.accent + '55' : '#1e1e30',
        boxShadow: open ? `0 0 20px ${style.glow}` : 'none',
        background: '#0e0e1a',
      }}
    >
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-4 px-5 py-4 text-left group"
      >
        <span
          className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold tracking-wide"
          style={{ background: style.accent + '22', color: style.accent, border: `1px solid ${style.accent}44` }}
        >
          {fn.number}
        </span>
        <span className="flex-1 font-semibold text-white/90 group-hover:text-white transition-colors">
          {fn.title}
        </span>
        <span
          className="flex-shrink-0 text-lg transition-transform duration-200 select-none"
          style={{ color: style.accent, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          &#8964;
        </span>
      </button>

      {/* Body */}
      <div className={`accordion-content ${open ? 'open' : ''}`}>
        <form onSubmit={handleSubmit} className="px-5 pb-5 pt-1 space-y-4">
          {/* Description */}
          <p className="text-sm text-slate-400 leading-relaxed border-l-2 pl-3" style={{ borderColor: style.accent + '66' }}>
            {fn.description}
          </p>

          {fn.fields.length === 0 && (
            <p className="text-xs text-slate-500 italic">No parameters required.</p>
          )}

          {/* Wallet hint for write functions */}
          {needsWallet && !connected && (
            <div
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
              style={{ background: '#161626', border: '1px solid #2a2a40', color: '#94a3b8' }}
            >
              <span>Connect your wallet to execute this function.</span>
            </div>
          )}

          {/* Connected wallet badge */}
          {needsWallet && connected && publicKey && (
            <div
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)', color: '#a78bfa' }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
              <span className="font-mono">{publicKey.toBase58().slice(0, 6)}...{publicKey.toBase58().slice(-6)}</span>
            </div>
          )}

          {/* Fields */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fn.fields.map(field => (
              <div key={field.name} className={field.type === 'textarea' || field.type === 'claimers' || field.type === 'claimers_live' ? 'sm:col-span-2' : ''}>
                {field.type === 'claimers_live' ? (
                  <ClaimersLiveInput
                    poolAddress={values.pool_address ?? ''}
                    value={values[field.name] ?? '[]'}
                    onChange={v => setValues(prev => ({ ...prev, [field.name]: v }))}
                    accent={style.accent}
                    connection={connection}
                  />
                ) : field.type === 'claimers' ? (
                  <ClaimersInput
                    value={values[field.name] ?? '[]'}
                    onChange={v => setValues(prev => ({ ...prev, [field.name]: v }))}
                    accent={style.accent}
                  />
                ) : (
                <>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  {field.label}
                </label>
                {field.type === 'select' ? (
                  <select
                    value={values[field.name] ?? field.options?.[0]?.value ?? ''}
                    onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm text-white appearance-none cursor-pointer"
                    style={{ background: '#161626', border: '1px solid #2a2a40' }}
                  >
                    {field.options?.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : field.type === 'textarea' ? (
                  <textarea
                    placeholder={field.placeholder}
                    value={values[field.name] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))}
                    rows={4}
                    className="w-full rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 font-mono resize-y"
                    style={{ background: '#161626', border: '1px solid #2a2a40' }}
                  />
                ) : (
                  <input
                    type={field.type ?? 'text'}
                    placeholder={field.placeholder}
                    value={values[field.name] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600"
                    style={{ background: '#161626', border: '1px solid #2a2a40' }}
                  />
                )}
                {field.hint && (
                  <p className="mt-1 text-xs text-slate-500">{field.hint}</p>
                )}
                </>
                )}
              </div>
            ))}
          </div>

          {/* Submit */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: loading ? '#2a2a40' : `linear-gradient(135deg, ${style.accent}, ${style.accent}cc)`,
                boxShadow: loading ? 'none' : `0 0 12px ${style.glow}`,
              }}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Processing...
                </span>
              ) : needsWallet && !connected ? 'Connect Wallet' : fn.submitLabel}
            </button>
          </div>

          {/* Result */}
          {result && (
            <div
              className="rounded-lg px-4 py-3 text-xs font-mono whitespace-pre-wrap leading-relaxed break-all min-h-0 overflow-y-auto overscroll-y-contain [height:min(400px,50vh)] [-webkit-overflow-scrolling:touch]"
              style={{
                background: result.type === 'error' ? '#1a0a0a' : result.type === 'success' ? '#0a1a0a' : '#0a0a1a',
                border: `1px solid ${result.type === 'error' ? '#7f1d1d' : result.type === 'success' ? '#14532d' : '#1e3a5f'}`,
                color: result.type === 'error' ? '#fca5a5' : result.type === 'success' ? '#86efac' : '#93c5fd',
              }}
            >
              {result.text}
              {result.altAddress && (
                <div className="mt-3 pt-2" style={{ borderTop: '1px solid #14532d' }}>
                  <div className="text-xs font-semibold mb-1" style={{ color: '#4ade80' }}>
                    ALT Address — copy this into the claim functions below:
                  </div>
                  <div
                    className="rounded px-3 py-2 text-xs font-mono break-all select-all cursor-text"
                    style={{ background: '#0d2010', border: '1px solid #166534', color: '#86efac' }}
                  >
                    {result.altAddress}
                  </div>
                </div>
              )}
              {(result.solscan || result.jupiterLink) && (
                <div className="mt-2 pt-2 flex flex-wrap gap-4" style={{ borderTop: '1px solid #14532d' }}>
                  {result.solscan && (
                    <a
                      href={result.solscan}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                      style={{ color: '#4ade80' }}
                    >
                      View on Solscan ↗
                    </a>
                  )}
                  {result.jupiterLink && (
                    <a
                      href={result.jupiterLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                      style={{ color: '#4ade80' }}
                    >
                      View on Jupiter ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

// ─── Section Block ────────────────────────────────────────────────────────────

function SectionBlock({
  id,
  label,
  icon,
  functions,
  network,
}: {
  id: SectionId;
  label: string;
  icon: string;
  functions: FunctionDef[];
  network: Network;
}) {
  const style = SECTION_STYLE[id];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-xl">{icon}</span>
        <h2 className="text-lg font-bold text-white tracking-wide">{label}</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${style.badge}`}>
          {functions.length} functions
        </span>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, ${style.accent}44, transparent)` }} />
      </div>

      <div className="space-y-2">
        {functions.map(fn => (
          <AccordionItem key={fn.id} fn={fn} section={id} network={network} />
        ))}
      </div>
    </div>
  );
}

// ─── Network Toggle ───────────────────────────────────────────────────────────

function NetworkToggle({ network, setNetwork }: { network: Network; setNetwork: (n: Network) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-xl" style={{ background: '#0e0e1a', border: '1px solid #1e1e30' }}>
      <button
        onClick={() => setNetwork('devnet')}
        className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150 ${
          network === 'devnet' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
        }`}
        style={
          network === 'devnet'
            ? { background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', boxShadow: '0 0 12px rgba(124,58,237,0.4)' }
            : {}
        }
      >
        Devnet
      </button>
      <button
        onClick={() => setNetwork('mainnet')}
        className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150 ${
          network === 'mainnet' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
        }`}
        style={
          network === 'mainnet'
            ? { background: 'linear-gradient(135deg, #dc2626, #b91c1c)', boxShadow: '0 0 12px rgba(220,38,38,0.4)' }
            : {}
        }
      >
        Mainnet
      </button>
    </div>
  );
}

// ─── Wallet Button ────────────────────────────────────────────────────────────

function WalletButton() {
  const { publicKey, connected, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const [showMenu, setShowMenu] = useState(false);

  if (!connected || !publicKey) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all duration-150"
        style={{
          background: 'linear-gradient(135deg, #7c3aed, #06b6d4)',
          boxShadow: '0 0 16px rgba(124,58,237,0.35)',
        }}
      >
        <span>Connect Wallet</span>
      </button>
    );
  }

  const short = `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`;

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(m => !m)}
        className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold transition-all"
        style={{
          background: '#0e0e1a',
          border: '1px solid rgba(139,92,246,0.4)',
          color: '#a78bfa',
        }}
      >
        {wallet?.adapter.icon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={wallet.adapter.icon} alt={wallet.adapter.name} className="w-4 h-4 rounded" />
        )}
        <span className="font-mono">{short}</span>
        <span className="text-slate-500 text-xs">&#8964;</span>
      </button>

      {showMenu && (
        <div
          className="absolute right-0 top-full mt-2 rounded-xl overflow-hidden z-50 min-w-[180px]"
          style={{ background: '#0e0e1a', border: '1px solid #1e1e30', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
        >
          <div className="px-3 py-2 border-b" style={{ borderColor: '#1e1e30' }}>
            <p className="text-xs text-slate-500">Connected via {wallet?.adapter.name}</p>
            <p className="text-xs font-mono text-slate-300 mt-0.5 truncate">{publicKey.toBase58()}</p>
          </div>
          <button
            onClick={() => { disconnect(); setShowMenu(false); }}
            className="w-full px-3 py-2.5 text-left text-sm text-red-400 hover:bg-red-900/20 transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Mainnet Banner ───────────────────────────────────────────────────────────

function MainnetBanner() {
  return (
    <div
      className="rounded-xl p-4 flex items-start gap-3"
      style={{ background: '#1a0a0a', border: '1px solid #7f1d1d' }}
    >
      <span className="text-2xl flex-shrink-0 mt-0.5">&#9888;</span>
      <div>
        <p className="font-semibold text-red-300 text-sm">You are on Mainnet</p>
        <p className="text-red-400/80 text-xs mt-1 leading-relaxed">
          Transactions on Mainnet use <strong>real funds</strong>. Please double-check all inputs before submitting.
        </p>
      </div>
    </div>
  );
}

// ─── Tab Nav ──────────────────────────────────────────────────────────────────

const TABS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'view',      label: 'View',      icon: '&#128269;' },
  { id: 'non_admin', label: 'Non-Admin', icon: '&#128100;' },
  { id: 'admin',     label: 'Admin',     icon: '&#128274;' },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Home() {
  const [network, setNetwork] = useState<Network>('devnet');

  return (
    <Providers key={network} endpoint={getRpcEndpoint(network)}>
      <HomeInner network={network} setNetwork={setNetwork} />
    </Providers>
  );
}

function HomeInner({ network, setNetwork }: { network: Network; setNetwork: (n: Network) => void }) {
  const [activeTab, setActiveTab] = useState<SectionId>('view');

  return (
    <div className="min-h-screen" style={{ background: '#07070f' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 px-6 py-4"
        style={{
          background: 'rgba(7,7,15,0.85)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #1e1e30',
        }}
      >
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          {/* Logo + title */}
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-black text-white flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
            >
              DBC
            </div>
            <div>
              <h1 className="text-sm font-bold text-white leading-none">DBC Custodian</h1>
              <p className="text-xs text-slate-400 leading-none mt-0.5">Fee Management</p>
            </div>
          </div>

          {/* Right controls */}
          <div className="flex items-center gap-3">
            <NetworkToggle network={network} setNetwork={setNetwork} />
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Mainnet warning */}
        {network === 'mainnet' && <MainnetBanner />}

        {/* Network badge */}
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
            style={{
              background: network === 'devnet' ? 'rgba(124,58,237,0.15)' : 'rgba(220,38,38,0.15)',
              color: network === 'devnet' ? '#a78bfa' : '#f87171',
              border: `1px solid ${network === 'devnet' ? '#7c3aed44' : '#dc262644'}`,
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ background: network === 'devnet' ? '#7c3aed' : '#dc2626' }}
            />
            {network === 'devnet' ? 'Devnet' : 'Mainnet'}
          </span>
          <span className="text-xs text-slate-500">
            {network === 'devnet' ? 'Connected to Solana Devnet' : 'Connected to Solana Mainnet'}
          </span>
        </div>

        {/* Tab navigation */}
        <div
          className="flex gap-1 p-1 rounded-xl"
          style={{ background: '#0e0e1a', border: '1px solid #1e1e30' }}
        >
          {TABS.map(tab => {
            const active = activeTab === tab.id;
            const s = SECTION_STYLE[tab.id];
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200"
                style={
                  active
                    ? { background: s.accent + '22', color: s.accent, border: `1px solid ${s.accent}44` }
                    : { color: '#64648a', border: '1px solid transparent' }
                }
              >
                <span dangerouslySetInnerHTML={{ __html: tab.icon }} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Section content */}
        <div className="space-y-10">
          {activeTab === 'view' && (
            <SectionBlock
              id="view"
              label="View"
              icon="&#128269;"
              functions={VIEW_FUNCTIONS}
              network={network}
            />
          )}
          {activeTab === 'non_admin' && (
            <SectionBlock
              id="non_admin"
              label="Non-Admin (Permissionless)"
              icon="&#128100;"
              functions={NON_ADMIN_FUNCTIONS}
              network={network}
            />
          )}
          {activeTab === 'admin' && (
            <SectionBlock
              id="admin"
              label="Admin Functions"
              icon="&#128274;"
              functions={ADMIN_FUNCTIONS}
              network={network}
            />
          )}
        </div>

        {/* Footer */}
        <footer className="pt-8 border-t text-center text-xs text-slate-600" style={{ borderColor: '#1e1e30' }}>
          DBC Custodian &mdash; Solana {network === 'devnet' ? 'Devnet' : 'Mainnet'} &mdash; v0.1.0
        </footer>
      </main>
    </div>
  );
}
