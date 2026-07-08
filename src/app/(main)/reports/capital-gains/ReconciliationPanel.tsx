'use client';

import { useState, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';

interface ReconMatch {
  ticker: string;
  dateSold: string;
  shares: number;
  computedProceeds: number;
  brokerProceeds: number;
  computedBasis: number;
  brokerBasis: number;
  basisDelta: number;
  basisMismatch: boolean;
}

interface BrokerRow {
  ticker: string;
  dateSold: string;
  proceeds: number;
  basis: number;
}

interface RealizedSale {
  ticker: string;
  dateSold: string;
  shares: number;
  proceeds: number;
  costBasis: number;
}

interface ReconResult {
  year: number;
  matched: ReconMatch[];
  missingInBooks: BrokerRow[];
  missingInBroker: RealizedSale[];
  summary: {
    matchedCount: number;
    mismatchCount: number;
    missingInBooksCount: number;
    missingInBrokerCount: number;
  };
}

function fmtDate(s: string): string {
  return s ? s.slice(0, 10) : '';
}

export default function ReconciliationPanel({ year }: { year: number }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<ReconResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ''));
    reader.readAsText(file);
  }, []);

  const reconcile = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (!text.trim()) {
        setError('Paste or upload 1099-B rows first.');
        return;
      }
      const res = await fetch('/api/reports/capital-gains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, csv: text }),
      });
      if (!res.ok) throw new Error('Reconciliation request failed');
      const json: ReconResult = await res.json();
      if (
        json.summary.matchedCount === 0 &&
        json.summary.missingInBooksCount === 0 &&
        json.summary.missingInBrokerCount === 0
      ) {
        setError('No valid rows parsed. Expected: ticker,dateSold,proceeds,basis');
        return;
      }
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setBusy(false);
    }
  }, [text, year]);

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">1099-B Reconciliation</h3>
        <p className="text-xs text-foreground-muted mt-1">
          Paste or upload your broker&rsquo;s 1099-B as CSV columns <span className="font-mono">ticker,dateSold,proceeds,basis</span>.
          Rows are matched to computed sales by ticker, sale date, and proceeds.
        </p>
      </div>

      <div className="p-4 space-y-3">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={5}
          placeholder={'AAPL,2024-03-15,1500.00,1000.00\nMSFT,2024-06-01,800.00,950.00'}
          className="w-full px-3 py-2 text-sm bg-background-secondary border border-border rounded-md text-foreground font-mono resize-y placeholder:text-foreground-muted"
        />
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={reconcile}
            disabled={busy || !text.trim()}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Reconciling...' : 'Reconcile'}
          </button>
          <label className="px-3 py-1.5 text-sm bg-surface border border-border rounded-md text-foreground-secondary hover:border-border-hover transition-colors cursor-pointer">
            Upload CSV
            <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
          </label>
        </div>

        {error && (
          <div className="bg-negative/10 border border-negative/20 rounded-md p-3 text-sm text-negative">{error}</div>
        )}

        {result && (
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Matched" value={result.summary.matchedCount} />
              <Stat label="Basis Mismatch" value={result.summary.mismatchCount} warn={result.summary.mismatchCount > 0} />
              <Stat label="Missing in Books" value={result.summary.missingInBooksCount} warn={result.summary.missingInBooksCount > 0} />
              <Stat label="Missing on 1099-B" value={result.summary.missingInBrokerCount} warn={result.summary.missingInBrokerCount > 0} />
            </div>

            {result.matched.length > 0 && (
              <div className="overflow-x-auto border border-border rounded-md">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                      <th className="px-3 py-2 text-left">Ticker</th>
                      <th className="px-3 py-2 text-left">Sold</th>
                      <th className="px-3 py-2 text-right">Proceeds (books)</th>
                      <th className="px-3 py-2 text-right">Basis (books)</th>
                      <th className="px-3 py-2 text-right">Basis (1099-B)</th>
                      <th className="px-3 py-2 text-right">Δ Basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.matched.map((m, i) => (
                      <tr key={`${m.ticker}-${m.dateSold}-${i}`} className={`border-b border-border/40 ${m.basisMismatch ? 'bg-warning/5' : ''}`}>
                        <td className="px-3 py-2 font-medium text-foreground">{m.ticker}</td>
                        <td className="px-3 py-2 font-mono tabular-nums text-foreground-secondary">{fmtDate(m.dateSold)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{formatCurrency(m.computedProceeds, 'USD')}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{formatCurrency(m.computedBasis, 'USD')}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{formatCurrency(m.brokerBasis, 'USD')}</td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${m.basisMismatch ? 'text-warning' : 'text-foreground-secondary'}`}>
                          {formatCurrency(m.basisDelta, 'USD')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.missingInBooks.length > 0 && (
              <div>
                <div className="text-xs text-foreground-muted uppercase tracking-wider mb-1">On 1099-B, not in books</div>
                <div className="overflow-x-auto border border-border rounded-md">
                  <table className="w-full text-sm">
                    <tbody>
                      {result.missingInBooks.map((b, i) => (
                        <tr key={`mb-${i}`} className="border-b border-border/40">
                          <td className="px-3 py-2 font-medium text-foreground">{b.ticker}</td>
                          <td className="px-3 py-2 font-mono tabular-nums text-foreground-secondary">{fmtDate(b.dateSold)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{formatCurrency(b.proceeds, 'USD')}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{formatCurrency(b.basis, 'USD')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {result.missingInBroker.length > 0 && (
              <div>
                <div className="text-xs text-foreground-muted uppercase tracking-wider mb-1">In books, not on 1099-B</div>
                <div className="overflow-x-auto border border-border rounded-md">
                  <table className="w-full text-sm">
                    <tbody>
                      {result.missingInBroker.map((s, i) => (
                        <tr key={`ms-${i}`} className="border-b border-border/40">
                          <td className="px-3 py-2 font-medium text-foreground">{s.ticker}</td>
                          <td className="px-3 py-2 font-mono tabular-nums text-foreground-secondary">{fmtDate(s.dateSold)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{formatCurrency(s.proceeds, 'USD')}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{formatCurrency(s.costBasis, 'USD')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="bg-background-secondary border border-border rounded-md p-3">
      <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-bold font-mono tabular-nums ${warn ? 'text-warning' : 'text-foreground'}`}>{value}</div>
    </div>
  );
}
