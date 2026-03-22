'use client';

import { useState } from 'react';
import { formatCurrency } from '@/lib/format';

type ScrubMethod = 'fifo' | 'lifo' | 'average';

interface ScrubResult {
  lotsCreated: number;
  splitsAssigned: number;
  splitsCreated: number;
  gainsTransactions: number;
  totalRealizedGain: number;
  method: string;
  runId: string;
  warnings: string[];
}

export function ScrubAllButton() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [method, setMethod] = useState<ScrubMethod>('fifo');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScrubResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setDialogOpen(true);
    setResult(null);
    setError(null);
  }

  function closeDialog() {
    setDialogOpen(false);
    setResult(null);
    setError(null);
    setLoading(false);
  }

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/lots/scrub-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Unknown error occurred');
      } else {
        // API returns { results: AutoAssignResult[], order: string[] }
        // Aggregate into a single summary
        const results = data.results || [];
        const aggregated: ScrubResult = {
          lotsCreated: results.reduce((sum: number, r: ScrubResult) => sum + (r.lotsCreated || 0), 0),
          splitsAssigned: results.reduce((sum: number, r: ScrubResult) => sum + (r.splitsAssigned || 0), 0),
          splitsCreated: results.reduce((sum: number, r: ScrubResult) => sum + (r.splitsCreated || 0), 0),
          gainsTransactions: results.reduce((sum: number, r: ScrubResult) => sum + (r.gainsTransactions || 0), 0),
          totalRealizedGain: results.reduce((sum: number, r: ScrubResult) => sum + (r.totalRealizedGain || 0), 0),
          method,
          runId: results[0]?.runId || '',
          warnings: results.flatMap((r: ScrubResult) => r.warnings || []),
        };
        setResult(aggregated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scrub accounts');
    } finally {
      setLoading(false);
    }
  }

  const methodLabels: Record<ScrubMethod, string> = {
    fifo: 'FIFO (First In, First Out)',
    lifo: 'LIFO (Last In, First Out)',
    average: 'Average Cost',
  };

  return (
    <>
      <button
        onClick={openDialog}
        className="flex items-center gap-2 px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors font-medium"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
        Scrub All Accounts
      </button>

      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) closeDialog(); }}
        >
          <div className="bg-background-secondary border border-border rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-foreground">Scrub All Accounts</h2>
              <button
                onClick={closeDialog}
                className="text-foreground-muted hover:text-foreground transition-colors p-1 rounded"
                disabled={loading}
                aria-label="Close"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content — method selection or results */}
            {!result ? (
              <>
                <p className="text-foreground-secondary text-sm mb-4">
                  Automatically assign all unassigned investment splits to lots across all accounts.
                  This will create lots and calculate realized gains where applicable.
                </p>

                <fieldset className="mb-6" disabled={loading}>
                  <legend className="text-sm font-medium text-foreground mb-2">Cost basis method</legend>
                  <div className="space-y-2">
                    {(Object.keys(methodLabels) as ScrubMethod[]).map((m) => (
                      <label
                        key={m}
                        className="flex items-center gap-3 cursor-pointer group"
                      >
                        <input
                          type="radio"
                          name="scrub-method"
                          value={m}
                          checked={method === m}
                          onChange={() => setMethod(m)}
                          className="accent-cyan-500 w-4 h-4"
                        />
                        <span className="text-sm text-foreground-secondary group-hover:text-foreground transition-colors">
                          {methodLabels[m]}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                {error && (
                  <div className="mb-4 bg-red-900/30 border border-red-600/50 rounded-lg px-4 py-3 text-sm text-red-300">
                    {error}
                  </div>
                )}

                <div className="flex justify-end gap-3">
                  <button
                    onClick={closeDialog}
                    disabled={loading}
                    className="px-4 py-2 text-sm rounded-lg border border-border text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirm}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors disabled:opacity-50"
                  >
                    {loading && (
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z" />
                      </svg>
                    )}
                    {loading ? 'Running...' : 'Confirm'}
                  </button>
                </div>
              </>
            ) : (
              /* Results summary */
              <>
                <div className="mb-4 flex items-center gap-2 text-emerald-400">
                  <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="font-medium text-sm">Scrub completed successfully</span>
                </div>

                <dl className="space-y-2 text-sm mb-4">
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">Method</dt>
                    <dd className="text-foreground font-medium capitalize">{result.method.toUpperCase()}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">Lots created</dt>
                    <dd className="text-foreground font-medium">{result.lotsCreated}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">Splits assigned</dt>
                    <dd className="text-foreground font-medium">{result.splitsAssigned}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">Splits created</dt>
                    <dd className="text-foreground font-medium">{result.splitsCreated}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-foreground-muted">Gains transactions</dt>
                    <dd className="text-foreground font-medium">{result.gainsTransactions}</dd>
                  </div>
                  <div className="flex justify-between border-t border-border pt-2">
                    <dt className="text-foreground-muted">Total realized gain/loss</dt>
                    <dd className={`font-semibold ${result.totalRealizedGain >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatCurrency(result.totalRealizedGain)}
                    </dd>
                  </div>
                </dl>

                {result.warnings.length > 0 && (
                  <div className="mb-4 bg-amber-900/30 border border-amber-600/50 rounded-lg p-3">
                    <p className="text-amber-300 text-xs font-medium mb-1">
                      {result.warnings.length} warning{result.warnings.length !== 1 ? 's' : ''}
                    </p>
                    <ul className="space-y-1 max-h-32 overflow-y-auto">
                      {result.warnings.map((w, i) => (
                        <li key={i} className="text-amber-300/80 text-xs">
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    onClick={closeDialog}
                    className="px-4 py-2 text-sm rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors"
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
