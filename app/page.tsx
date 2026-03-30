'use client';

import { useState } from 'react';
import { useConnection, useWallet, useAnchorWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Providers, getRpcEndpoint } from '@/app/providers';
import {
  viewPoolClaimers,
  viewFeeVaultBalances,
  setPoolClaimers,
  updateClaimersBps,
  claimDbcPartnerFee,
  claimDammV2PositionFee,
  distributeFees,
} from '@/lib/custodian';

// ─── Types ──────────────────────────────────────────────────────────────────

type Network = 'devnet' | 'mainnet';
type SectionId = 'view' | 'non_admin' | 'admin';

interface FieldDef {
  name: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'select' | 'textarea';
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
    number: '1E',
    title: 'View Fee Vault Balances',
    description: 'Check the current token balances in the program-owned fee vaults for a pool.',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey' },
      { name: 'base_mint', label: 'Base Mint', placeholder: 'Base token mint pubkey' },
      { name: 'quote_mint', label: 'Quote Mint', placeholder: 'Quote token mint pubkey (wSOL for DBC)' },
    ],
    submitLabel: 'Fetch Fee Vaults',
  },
];

const NON_ADMIN_FUNCTIONS: FunctionDef[] = [
  {
    id: 'claim_dbc_fee',
    number: '2A',
    title: 'Claim DBC Partner Trading Fee',
    description: "Permissionless — sweeps all accrued partner trading fees from a DBC pool into this program's PDA-owned fee vaults. Anyone can call this.",
    fields: [
      { name: 'pool_address', label: 'DBC Pool Address', placeholder: 'DBC pool pubkey' },
    ],
    submitLabel: 'Claim DBC Fees',
  },
  {
    id: 'claim_dammv2_fee',
    number: '2B',
    title: 'Claim DAMM v2 Position Fee',
    description: "Claims accumulated LP position fees from a DAMM v2 pool into this program's fee vaults. Pass the position NFT mint — everything else is resolved on-chain.",
    fields: [
      { name: 'nft_mint', label: 'Position NFT Mint', placeholder: 'Position NFT mint pubkey', hint: 'The NFT mint address representing the LP position' },
    ],
    submitLabel: 'Claim Position Fees',
  },
  {
    id: 'distribute_fees',
    number: '2C',
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
        label: 'Claimers (JSON array)',
        type: 'textarea',
        placeholder: '[{"address":"<pubkey>","bps":5000},{"address":"<pubkey>","bps":5000}]',
        hint: 'JSON array of {address, bps} objects. BPS must sum to 10000.',
      },
    ],
    submitLabel: 'Set Pool Claimers',
  },
  {
    id: 'update_claimers_bps',
    number: '3B',
    title: 'Update Claimers BPS',
    description: 'Admin-only. Update the BPS (fee share) for existing claimers on a pool without resetting claimed amounts.',
    fields: [
      { name: 'pool_address', label: 'Pool Address', placeholder: 'Pool pubkey (DBC or DAMM v2)' },
      {
        name: 'claimers_json',
        label: 'Claimers (JSON array)',
        type: 'textarea',
        placeholder: '[{"address":"<pubkey>","bps":7000},{"address":"<pubkey>","bps":3000}]',
        hint: 'JSON array of {address, bps} objects. BPS must sum to 10000.',
      },
    ],
    submitLabel: 'Update BPS',
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
  'claim_dbc_fee', 'claim_dammv2_fee', 'distribute_fees',
  'set_pool_claimers', 'update_claimers_bps',
]);

function formatResult(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
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
  const [result, setResult] = useState<{ type: 'info' | 'success' | 'error'; text: string; solscan?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const { publicKey, connected } = useWallet();
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
      }

      // ── Non-Admin ──
      else if (fn.id === 'claim_dbc_fee') {
        const r = await claimDbcPartnerFee(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
      } else if (fn.id === 'claim_dammv2_fee') {
        const r = await claimDammV2PositionFee(connection, anchorWallet!, {
          nftMint: values.nft_mint,
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
      }

      // ── Admin ──
      else if (fn.id === 'set_pool_claimers') {
        let claimers: { address: string; bps: number }[];
        try {
          claimers = JSON.parse(values.claimers_json);
        } catch {
          throw new Error('Invalid JSON in Claimers field. Expected: [{"address":"...","bps":5000},...]');
        }
        const r = await setPoolClaimers(connection, anchorWallet!, {
          poolAddress: values.pool_address,
          mode: (values.mode ?? 'dbc') as 'dbc' | 'damm-v2',
          claimers,
          network: net,
        });
        data = { tx: r.tx, solscan: r.link };
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
      }

      const solscanUrl =
        data && typeof data === 'object' && 'solscan' in data
          ? (data as { solscan: string }).solscan
          : undefined;
      const displayData = solscanUrl
        ? { ...((data as object)), solscan: undefined }
        : data;
      setResult({ type: 'success', text: formatResult(displayData), solscan: solscanUrl });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRejection =
        msg.toLowerCase().includes('user rejected') ||
        msg.toLowerCase().includes('rejected the request') ||
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
              <div key={field.name} className={field.type === 'textarea' ? 'sm:col-span-2' : ''}>
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
              className="rounded-lg px-4 py-3 text-xs font-mono whitespace-pre-wrap leading-relaxed break-all"
              style={{
                background: result.type === 'error' ? '#1a0a0a' : result.type === 'success' ? '#0a1a0a' : '#0a0a1a',
                border: `1px solid ${result.type === 'error' ? '#7f1d1d' : result.type === 'success' ? '#14532d' : '#1e3a5f'}`,
                color: result.type === 'error' ? '#fca5a5' : result.type === 'success' ? '#86efac' : '#93c5fd',
              }}
            >
              {result.text}
              {result.solscan && (
                <div className="mt-2 pt-2" style={{ borderTop: '1px solid #14532d' }}>
                  <a
                    href={result.solscan}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    style={{ color: '#4ade80' }}
                  >
                    View on Solscan ↗
                  </a>
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
