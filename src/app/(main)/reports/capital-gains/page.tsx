'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';
import ReconciliationPanel from './ReconciliationPanel';
import { RelatedLinks } from '@/components/RelatedLinks';

interface TermTotals {
  proceeds: number;
  costBasis: number;
  adjustments: number;
  gain: number;
}

interface Form8949Row {
  description: string;
  ticker: string;
  accountGuid: string;
  dateAcquired: string;
  dateSold: string;
  proceeds: number;
  costBasis: number;
  code: string;
  adjustment: number;
  gain: number;
  term: 'short_term' | 'long_term';
  basisReported: boolean;
  box: string;
  suspect?: boolean;
  suspectReason?: string;
}

interface Form8949Bucket {
  box: string;
  part: 'I' | 'II';
  term: 'short_term' | 'long_term';
  basisReported: boolean;
  label: string;
  rows: Form8949Row[];
  totals: TermTotals;
}

interface CapitalGainsReport {
  year: number;
  rows: Form8949Row[];
  buckets: Form8949Bucket[];
  scheduleD: {
    shortTerm: TermTotals;
    longTerm: TermTotals;
    netShortTerm: number;
    netLongTerm: number;
    net: number;
  };
  warnings?: string[];
  generatedAt: string;
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 8 }, (_, i) => CURRENT_YEAR - i);

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

function gainClass(v: number): string {
  if (v > 0) return 'text-positive';
  if (v < 0) return 'text-negative';
  return 'text-foreground-secondary';
}

export default function CapitalGainsPage() {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [data, setData] = useState<CapitalGainsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/capital-gains?year=${year}`);
      if (!res.ok) throw new Error('Failed to fetch report');
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const downloadCSV = useCallback(async (doc: '8949' | 'schedule-d') => {
    try {
      const res = await fetch(`/api/reports/capital-gains?year=${year}&format=csv&doc=${doc}`);
      if (!res.ok) throw new Error('Download failed');
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = doc === 'schedule-d' ? `schedule-d-${year}.csv` : `form-8949-${year}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch {
      setError('CSV download failed');
    }
  }, [year]);

  const nonEmptyBuckets = data?.buckets.filter(b => b.rows.length > 0) ?? [];

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Capital Gains — Form 8949 / Schedule D</h1>
          <p className="text-sm text-foreground-muted mt-1">
            Realized stock &amp; fund sales for the tax year, ready for IRS Form 8949 and Schedule D.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted uppercase tracking-wider">Tax Year</span>
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="px-3 py-1.5 text-sm bg-surface border border-border rounded-md text-foreground font-mono tabular-nums"
            >
              {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="bg-warning/5 border border-warning/20 rounded-lg p-3 text-xs text-foreground-secondary">
        Broker-reported basis is not tracked in GnuCash, so every lot defaults to
        <span className="text-foreground"> Box C</span> (short-term) or
        <span className="text-foreground"> Box F</span> (long-term) — &ldquo;not reported to the IRS&rdquo;.
        Use the 1099-B reconciliation below to confirm basis; matched rows are upgraded to Box A / Box D.
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <span className="text-foreground-secondary">Loading...</span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-negative/10 border border-negative/20 rounded-lg p-4 text-negative">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-surface border border-border rounded-lg p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Net Short-Term</div>
              <div className={`text-xl font-bold font-mono tabular-nums ${gainClass(data.scheduleD.netShortTerm)}`}>
                {formatCurrency(data.scheduleD.netShortTerm, 'USD')}
              </div>
            </div>
            <div className="bg-surface border border-border rounded-lg p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Net Long-Term</div>
              <div className={`text-xl font-bold font-mono tabular-nums ${gainClass(data.scheduleD.netLongTerm)}`}>
                {formatCurrency(data.scheduleD.netLongTerm, 'USD')}
              </div>
            </div>
            <div className="bg-surface border border-border rounded-lg p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Net Capital Gain/Loss</div>
              <div className={`text-xl font-bold font-mono tabular-nums ${gainClass(data.scheduleD.net)}`}>
                {formatCurrency(data.scheduleD.net, 'USD')}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => downloadCSV('8949')}
              disabled={data.rows.length === 0}
              className="px-3 py-1.5 text-sm bg-surface border border-border rounded-md text-foreground hover:border-border-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Download 8949 CSV
            </button>
            <button
              onClick={() => downloadCSV('schedule-d')}
              disabled={data.rows.length === 0}
              className="px-3 py-1.5 text-sm bg-surface border border-border rounded-md text-foreground hover:border-border-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Download Schedule D CSV
            </button>
          </div>

          {data.warnings && data.warnings.length > 0 && (
            <div className="bg-negative/10 border border-negative/40 rounded-lg p-4">
              <div className="flex items-center gap-2 text-negative font-semibold text-sm mb-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                Review before filing — {data.warnings.length} suspect {data.warnings.length === 1 ? 'row' : 'rows'}
              </div>
              <ul className="space-y-1 text-sm text-foreground-secondary list-disc pl-5">
                {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
              <p className="text-xs text-foreground-muted mt-2">
                These figures come straight from your book. A per-share price far from the same security&apos;s
                other sales usually means the underlying transaction is wrong — fix it in the ledger before relying on these numbers.
              </p>
            </div>
          )}

          {nonEmptyBuckets.length === 0 ? (
            <div className="bg-surface border border-border rounded-lg p-8 text-center text-foreground-muted text-sm">
              No realized sales found for {year}.
            </div>
          ) : (
            nonEmptyBuckets.map(bucket => (
              <div key={bucket.box} className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="p-4 border-b border-border">
                  <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{bucket.label}</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                        <th className="px-4 py-3 text-left">Description</th>
                        <th className="px-4 py-3 text-left">Acquired</th>
                        <th className="px-4 py-3 text-left">Sold</th>
                        <th className="px-4 py-3 text-right">Proceeds</th>
                        <th className="px-4 py-3 text-right">Cost Basis</th>
                        <th className="px-4 py-3 text-center">Code</th>
                        <th className="px-4 py-3 text-right">Adjustment</th>
                        <th className="px-4 py-3 text-right">Gain/Loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bucket.rows.map((r, i) => (
                        <tr
                          key={`${r.accountGuid}-${r.dateSold}-${i}`}
                          className={`border-b border-border/40 transition-colors ${r.suspect ? 'bg-negative/10' : r.code === 'W' ? 'bg-warning/5' : 'hover:bg-surface-hover'}`}
                        >
                          <td className="px-4 py-3 font-medium text-foreground">
                            {r.description}
                            {r.suspect && (
                              <span
                                className="ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-negative/20 text-negative align-middle"
                                title={r.suspectReason}
                              >
                                REVIEW
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono tabular-nums text-foreground-secondary">{fmtDate(r.dateAcquired)}</td>
                          <td className="px-4 py-3 font-mono tabular-nums text-foreground-secondary">{fmtDate(r.dateSold)}</td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-foreground">{formatCurrency(r.proceeds, 'USD')}</td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-foreground">{formatCurrency(r.costBasis, 'USD')}</td>
                          <td className="px-4 py-3 text-center">
                            {r.code === 'W' && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-warning/20 text-warning" title="Wash sale — loss disallowed">W</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-warning">
                            {r.adjustment ? formatCurrency(r.adjustment, 'USD') : ''}
                          </td>
                          <td className={`px-4 py-3 text-right font-mono tabular-nums ${gainClass(r.gain)}`}>{formatCurrency(r.gain, 'USD')}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border text-xs uppercase tracking-wider">
                        <td className="px-4 py-3 text-foreground-muted" colSpan={3}>Box {bucket.box} totals</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-foreground">{formatCurrency(bucket.totals.proceeds, 'USD')}</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-foreground">{formatCurrency(bucket.totals.costBasis, 'USD')}</td>
                        <td />
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-warning">{bucket.totals.adjustments ? formatCurrency(bucket.totals.adjustments, 'USD') : ''}</td>
                        <td className={`px-4 py-3 text-right font-mono tabular-nums ${gainClass(bucket.totals.gain)}`}>{formatCurrency(bucket.totals.gain, 'USD')}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            ))
          )}

          <ReconciliationPanel year={year} />
        </>
      )}
      <RelatedLinks ids={['tool-sell-planner', 'rpt-tax-harvesting', 'rpt-tax-schedule', 'rpt-tax-package']} />
    </div>
  );
}
