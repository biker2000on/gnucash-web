'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { PersonalToolNotice } from '@/components/PersonalToolNotice';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { useToast } from '@/contexts/ToastContext';
import type { ShoeboxSummary } from '@/lib/hsa-shoebox';

/* ------------------------------------------------------------------ */
/* API payload types                                                   */
/* ------------------------------------------------------------------ */

interface ShoeboxReceipt {
  id: number;
  filename: string;
  createdAt: string;
  date: string | null;
  merchant: string | null;
  amount: number | null;
  transactionGuid: string | null;
  transactionDescription: string | null;
  reimbursedTxnGuid: string | null;
}

interface HsaAccount {
  guid: string;
  name: string;
  fullname: string;
  retirementAccountType: string;
  balance: number;
  currencyMnemonic: string | null;
}

interface ShoeboxPayload {
  summary: ShoeboxSummary;
  receipts: ShoeboxReceipt[];
  hsaAccounts: HsaAccount[];
  hsaAccountsFlagged: boolean;
}

interface FlatAccount {
  guid: string;
  name: string;
  account_type: string;
  fullname: string;
}

/** Row shape from GET /api/receipts (subset we use on the Mark tab). */
interface RawReceipt {
  id: number;
  filename: string;
  created_at: string;
  transaction_description?: string;
  hsa_eligible: boolean;
  hsa_reimbursed_txn_guid: string | null;
  extracted_data: { amount?: unknown; vendor?: unknown; date?: unknown } | null;
}

const MONO = { fontFeatureSettings: "'tnum'" } as const;
const BANK_TYPES = new Set(['BANK', 'CASH', 'ASSET']);

function receiptDate(r: { date: string | null; createdAt: string }): string {
  return r.date ?? r.createdAt.slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function HsaShoeboxPage() {
  const toast = useToast();
  const [data, setData] = useState<ShoeboxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'shoebox' | 'mark'>('shoebox');

  // Reimburse form state
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bankAccounts, setBankAccounts] = useState<FlatAccount[]>([]);
  const [bankAccountGuid, setBankAccountGuid] = useState('');
  const [hsaAccountGuid, setHsaAccountGuid] = useState('');
  const [reimburseDate, setReimburseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [posting, setPosting] = useState(false);

  // Mark tab state
  const [allReceipts, setAllReceipts] = useState<RawReceipt[]>([]);
  const [markLoading, setMarkLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const fetchShoebox = useCallback(async () => {
    try {
      const res = await fetch('/api/tools/hsa-shoebox');
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to load HSA shoebox');
      }
      const payload = (await res.json()) as ShoeboxPayload;
      setData(payload);
      setError(null);
      setHsaAccountGuid(prev => prev || payload.hsaAccounts[0]?.guid || '');
      // Drop selections that were reimbursed
      setSelected(prev => {
        const stillOpen = new Set(
          payload.receipts.filter(r => !r.reimbursedTxnGuid).map(r => r.id),
        );
        return new Set([...prev].filter(id => stillOpen.has(id)));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchShoebox();
  }, [fetchShoebox]);

  // Bank account list for the reimburse form
  useEffect(() => {
    fetch('/api/accounts?flat=true&noBalances=true')
      .then(res => (res.ok ? res.json() : null))
      .then((payload: { accounts?: FlatAccount[] } | FlatAccount[] | null) => {
        if (!payload) return;
        const list = Array.isArray(payload) ? payload : payload.accounts ?? [];
        setBankAccounts(list.filter(a => BANK_TYPES.has(a.account_type)));
      })
      .catch(() => { /* selector stays empty */ });
  }, []);

  // Mark tab: recent receipts (searchable)
  useEffect(() => {
    if (tab !== 'mark') return;
    let cancelled = false;
    setMarkLoading(true);
    const params = new URLSearchParams({ limit: '100', offset: '0' });
    if (search) params.set('search', search);
    const timer = setTimeout(() => {
      fetch(`/api/receipts?${params}`)
        .then(res => (res.ok ? res.json() : Promise.reject()))
        .then((payload: { receipts: RawReceipt[] }) => {
          if (!cancelled) setAllReceipts(payload.receipts);
        })
        .catch(() => { if (!cancelled) toast.error('Failed to load receipts'); })
        .finally(() => { if (!cancelled) setMarkLoading(false); });
    }, search ? 300 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, search]);

  const toggleEligible = async (id: number, eligible: boolean) => {
    setTogglingId(id);
    try {
      const res = await fetch(`/api/receipts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hsa_eligible: eligible }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to update receipt');
      }
      setAllReceipts(prev => prev.map(r => (r.id === id ? { ...r, hsa_eligible: eligible } : r)));
      await fetchShoebox();
      toast.success(eligible ? 'Marked HSA-eligible' : 'Removed from shoebox');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update receipt');
    } finally {
      setTogglingId(null);
    }
  };

  const unreimbursed = useMemo(
    () => (data?.receipts ?? []).filter(r => !r.reimbursedTxnGuid),
    [data],
  );
  const selectedTotal = useMemo(
    () =>
      unreimbursed
        .filter(r => selected.has(r.id) && r.amount !== null)
        .reduce((s, r) => s + Math.round((r.amount ?? 0) * 100), 0) / 100,
    [unreimbursed, selected],
  );
  const selectionHasMissingAmount = useMemo(
    () => unreimbursed.some(r => selected.has(r.id) && r.amount === null),
    [unreimbursed, selected],
  );

  const submitReimbursement = async () => {
    if (selected.size === 0 || !bankAccountGuid || !hsaAccountGuid) return;
    setPosting(true);
    try {
      const res = await fetch('/api/tools/hsa-shoebox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiptIds: [...selected],
          bankAccountGuid,
          hsaAccountGuid,
          date: reimburseDate,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? 'Failed to post reimbursement');
      toast.success(
        `Reimbursed ${body.receiptCount} receipt${body.receiptCount === 1 ? '' : 's'} — ${formatCurrency(body.total)}`,
      );
      setSelected(new Set());
      await fetchShoebox();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to post reimbursement');
    } finally {
      setPosting(false);
    }
  };

  const summary = data?.summary ?? null;

  return (
    <div className="space-y-6 max-w-[1100px]">
      <header>
        <h1 className="text-3xl font-bold text-foreground">HSA Shoebox</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Bank eligible medical receipts now, keep the HSA invested, and reimburse yourself
          tax-free whenever you choose.
        </p>
      </header>

      <PersonalToolNotice />

      {/* Explainer */}
      <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-2">
        <h2 className="text-base font-semibold text-foreground">The pay-out-of-pocket strategy</h2>
        <p className="text-sm text-foreground-secondary">
          Qualified medical expenses have <span className="text-foreground">no reimbursement deadline</span>.
          Pay them from your checking account today, mark the receipt HSA-eligible here, and let the
          HSA compound untouched. Years later, withdraw the banked total in one tax-free
          reimbursement — every receipt in this shoebox is documentation the IRS expects you to keep.
          Expenses must be incurred after the HSA was established, and a receipt can only be
          reimbursed once.
        </p>
      </section>

      {loading && (
        <div className="flex items-center justify-center min-h-[200px] text-foreground-muted text-sm">
          Loading shoebox…
        </div>
      )}
      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-6 text-sm text-error">{error}</div>
      )}

      {summary && !loading && !error && (
        <>
          <StatGrid cols={4}>
            <StatCard
              label="Eligible unreimbursed"
              value={formatCurrency(summary.totalEligibleUnreimbursed)}
              sub={`${summary.unreimbursedCount} receipt${summary.unreimbursedCount === 1 ? '' : 's'}${summary.missingAmountCount > 0 ? ` · ${summary.missingAmountCount} missing amount` : ''}`}
              tone="primary"
            />
            <StatCard
              label="Current HSA balance"
              value={formatCurrency(summary.hsaBalance)}
              sub={
                data && data.hsaAccounts.length > 0
                  ? data.hsaAccounts.map(a => a.name).join(', ')
                  : 'No HSA accounts flagged'
              }
            />
            <StatCard
              label="Tax-free headroom"
              value={formatCurrency(summary.headroom)}
              sub="min(unreimbursed, balance)"
              tone="positive"
            />
            <StatCard
              label="Already reimbursed"
              value={formatCurrency(summary.totalReimbursed)}
              sub={`${summary.reimbursedCount} receipt${summary.reimbursedCount === 1 ? '' : 's'}`}
            />
          </StatGrid>

          {data && !data.hsaAccountsFlagged && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-foreground-secondary">
              No HSA accounts are flagged in this book. Edit your HSA account and set its
              retirement type to <span className="font-mono">HSA</span> (self-only or family) so the
              balance and headroom can be computed.
            </div>
          )}

          {/* Tabs */}
          <div className="flex rounded-lg border border-border overflow-hidden text-sm w-fit">
            {(['shoebox', 'mark'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 transition-colors ${
                  tab === t
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'bg-background text-foreground-secondary hover:bg-surface-hover hover:text-foreground'
                }`}
              >
                {t === 'shoebox' ? `Shoebox (${data?.receipts.length ?? 0})` : 'Mark receipts'}
              </button>
            ))}
          </div>

          {tab === 'shoebox' && (
            <>
              {/* Eligible receipts table */}
              <section className="rounded-lg border border-border bg-surface/30 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-[11px] uppercase tracking-wider text-foreground-muted">
                        <th className="px-3 py-2 text-left w-8"></th>
                        <th className="px-3 py-2 text-left">Date</th>
                        <th className="px-3 py-2 text-left">Merchant</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.receipts ?? []).length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-3 py-8 text-center text-foreground-muted">
                            No receipts marked HSA-eligible yet. Use the &ldquo;Mark receipts&rdquo; tab
                            to add some.
                          </td>
                        </tr>
                      )}
                      {(data?.receipts ?? []).map(r => {
                        const reimbursed = r.reimbursedTxnGuid !== null;
                        return (
                          <tr key={r.id} className="border-b border-border/60 hover:bg-surface-hover/50">
                            <td className="px-3 py-2">
                              {!reimbursed && (
                                <input
                                  type="checkbox"
                                  className="accent-[var(--primary)]"
                                  checked={selected.has(r.id)}
                                  onChange={e => {
                                    setSelected(prev => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(r.id);
                                      else next.delete(r.id);
                                      return next;
                                    });
                                  }}
                                />
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono text-foreground-secondary" style={MONO}>
                              {receiptDate(r)}
                            </td>
                            <td className="px-3 py-2 text-foreground">
                              {r.merchant ?? r.transactionDescription ?? r.filename}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-foreground" style={MONO}>
                              {r.amount !== null ? formatCurrency(r.amount) : <span className="text-warning">no amount</span>}
                            </td>
                            <td className="px-3 py-2">
                              {reimbursed ? (
                                <span className="text-xs text-positive">Reimbursed</span>
                              ) : (
                                <span className="text-xs text-foreground-secondary">Banked</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              <a
                                href={`/api/receipts/${r.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-primary hover:text-primary-hover mr-3"
                              >
                                View
                              </a>
                              {!reimbursed && (
                                <button
                                  onClick={() => toggleEligible(r.id, false)}
                                  disabled={togglingId === r.id}
                                  className="text-xs text-foreground-muted hover:text-negative transition-colors disabled:opacity-50"
                                >
                                  Unmark
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Reimburse panel */}
              <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Reimburse selected receipts</h2>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    Creates one GnuCash transaction: money into your bank account, out of the HSA.
                    Each receipt is stamped with the transaction so it can&apos;t be reimbursed twice.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                  <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
                    Deposit to (bank)
                    <select
                      value={bankAccountGuid}
                      onChange={e => setBankAccountGuid(e.target.value)}
                      className="max-w-[280px] bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                    >
                      <option value="">Select account…</option>
                      {bankAccounts.map(a => (
                        <option key={a.guid} value={a.guid}>{a.fullname}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
                    From HSA
                    <select
                      value={hsaAccountGuid}
                      onChange={e => setHsaAccountGuid(e.target.value)}
                      className="max-w-[280px] bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                    >
                      <option value="">Select HSA…</option>
                      {(data?.hsaAccounts ?? []).map(a => (
                        <option key={a.guid} value={a.guid}>
                          {a.fullname} ({formatCurrency(a.balance)})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
                    Date
                    <input
                      type="date"
                      value={reimburseDate}
                      onChange={e => setReimburseDate(e.target.value)}
                      className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                    />
                  </label>
                  <button
                    onClick={submitReimbursement}
                    disabled={
                      posting ||
                      selected.size === 0 ||
                      !bankAccountGuid ||
                      !hsaAccountGuid ||
                      selectionHasMissingAmount
                    }
                    className="px-4 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-primary-foreground rounded-lg text-sm font-medium transition-colors"
                  >
                    {posting
                      ? 'Posting…'
                      : `Reimburse ${selected.size > 0 ? `${selected.size} · ${formatCurrency(selectedTotal)}` : ''}`}
                  </button>
                </div>
                {selectionHasMissingAmount && (
                  <p className="text-xs text-warning">
                    A selected receipt has no extracted amount — deselect it or fix the receipt first.
                  </p>
                )}
                {selected.size > 0 && selectedTotal > (summary?.hsaBalance ?? 0) && (
                  <p className="text-xs text-warning">
                    Selection exceeds the current HSA balance — the transaction will still post, but
                    the HSA account will go negative.
                  </p>
                )}
              </section>
            </>
          )}

          {tab === 'mark' && (
            <section className="rounded-lg border border-border bg-surface/30 overflow-hidden">
              <div className="p-3 border-b border-border">
                <input
                  type="search"
                  placeholder="Search receipt text…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder-foreground-secondary focus:outline-none focus:border-primary"
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-[11px] uppercase tracking-wider text-foreground-muted">
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Merchant / file</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2 text-right">HSA eligible</th>
                    </tr>
                  </thead>
                  <tbody>
                    {markLoading && (
                      <tr>
                        <td colSpan={4} className="px-3 py-8 text-center text-foreground-muted">Loading…</td>
                      </tr>
                    )}
                    {!markLoading && allReceipts.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-8 text-center text-foreground-muted">
                          No receipts found. Upload receipts from the Receipts page first.
                        </td>
                      </tr>
                    )}
                    {!markLoading && allReceipts.map(r => {
                      const amount =
                        r.extracted_data && typeof r.extracted_data.amount === 'number'
                          ? r.extracted_data.amount
                          : null;
                      const vendor =
                        r.extracted_data && typeof r.extracted_data.vendor === 'string'
                          ? r.extracted_data.vendor
                          : null;
                      const date =
                        r.extracted_data && typeof r.extracted_data.date === 'string'
                          ? r.extracted_data.date
                          : r.created_at.slice(0, 10);
                      return (
                        <tr key={r.id} className="border-b border-border/60 hover:bg-surface-hover/50">
                          <td className="px-3 py-2 font-mono text-foreground-secondary" style={MONO}>{date}</td>
                          <td className="px-3 py-2 text-foreground">
                            {vendor ?? r.transaction_description ?? r.filename}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-foreground" style={MONO}>
                            {amount !== null ? formatCurrency(amount) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => toggleEligible(r.id, !r.hsa_eligible)}
                              disabled={togglingId === r.id || r.hsa_reimbursed_txn_guid !== null}
                              className={`text-xs px-2.5 py-1 rounded-md border transition-colors disabled:opacity-50 ${
                                r.hsa_eligible
                                  ? 'border-primary/40 bg-primary-light text-primary'
                                  : 'border-border text-foreground-secondary hover:border-border-hover hover:text-foreground'
                              }`}
                            >
                              {r.hsa_reimbursed_txn_guid
                                ? 'Reimbursed'
                                : r.hsa_eligible
                                  ? 'Eligible ✓'
                                  : 'Mark eligible'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="text-[11px] text-foreground-muted">
            Amounts come from receipt OCR extraction. Keep original receipts — reimbursements are
            only tax-free for qualified medical expenses incurred after the HSA was established.
            Not tax advice.
          </p>
        </>
      )}
    </div>
  );
}
