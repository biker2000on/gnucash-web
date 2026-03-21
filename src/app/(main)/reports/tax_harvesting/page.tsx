'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';
import Link from 'next/link';

interface HarvestCandidate {
  accountGuid: string;
  accountName: string;
  ticker: string;
  lotGuid: string;
  lotTitle: string;
  shares: number;
  costBasis: number;
  marketValue: number;
  unrealizedLoss: number;
  holdingPeriod: 'short_term' | 'long_term' | null;
  projectedSavings: { shortTerm: number; longTerm: number };
}

interface WashSale {
  splitGuid: string;
  sellDate: string;
  sellAccountName: string;
  ticker: string;
  shares: number;
  loss: number;
  washBuyDate: string;
  washBuyAccountName: string;
  daysApart: number;
}

interface TaxHarvestingData {
  candidates: HarvestCandidate[];
  washSales: WashSale[];
  taxRates: { shortTerm: number; longTerm: number };
  summary: {
    totalHarvestableLoss: number;
    totalProjectedSavingsShortTerm: number;
    totalProjectedSavingsLongTerm: number;
    washSaleCount: number;
    candidateCount: number;
  };
  generatedAt: string;
}

export default function TaxHarvestingPage() {
  const [data, setData] = useState<TaxHarvestingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shortTermRate, setShortTermRate] = useState(37);
  const [longTermRate, setLongTermRate] = useState(20);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/reports/tax-harvesting');
      if (!res.ok) throw new Error('Failed to fetch report');
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []); // No rate dependencies — rates applied client-side

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tax-Loss Harvesting Dashboard</h1>
          <p className="text-sm text-foreground-muted mt-1">
            Identify lots with unrealized losses and potential wash sale conflicts.
          </p>
        </div>
      </div>

      <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4">
        <h3 className="text-sm font-medium text-foreground-secondary mb-3">Tax Rates</h3>
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted">Short-Term Rate:</span>
            <input
              type="number"
              value={shortTermRate}
              onChange={e => setShortTermRate(Number(e.target.value))}
              min={0}
              max={100}
              className="w-16 px-2 py-1 text-sm bg-input-bg border border-border rounded text-foreground text-right"
            />
            <span className="text-xs text-foreground-muted">%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted">Long-Term Rate:</span>
            <input
              type="number"
              value={longTermRate}
              onChange={e => setLongTermRate(Number(e.target.value))}
              min={0}
              max={100}
              className="w-16 px-2 py-1 text-sm bg-input-bg border border-border rounded text-foreground text-right"
            />
            <span className="text-xs text-foreground-muted">%</span>
          </label>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
            <span className="text-foreground-secondary">Loading...</span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 text-rose-400">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Harvestable Loss</div>
              <div className="text-lg font-bold font-mono text-rose-400">
                {formatCurrency(data.summary.totalHarvestableLoss, 'USD')}
              </div>
            </div>
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Projected Savings (ST)</div>
              <div className="text-lg font-bold font-mono text-emerald-400">
                {formatCurrency(Math.abs(data.summary.totalHarvestableLoss) * (shortTermRate / 100), 'USD')}
              </div>
            </div>
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Candidates</div>
              <div className="text-lg font-bold text-foreground">{data.summary.candidateCount}</div>
            </div>
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Wash Sales</div>
              <div className={`text-lg font-bold ${data.summary.washSaleCount > 0 ? 'text-amber-400' : 'text-foreground'}`}>
                {data.summary.washSaleCount}
              </div>
            </div>
          </div>

          <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                Harvest Candidates
              </h3>
            </div>
            {data.candidates.length === 0 ? (
              <div className="p-8 text-center text-foreground-muted text-sm">
                No lots with unrealized losses found.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                      <th className="px-4 py-3 text-left">Ticker</th>
                      <th className="px-4 py-3 text-left">Account</th>
                      <th className="px-4 py-3 text-left">Lot</th>
                      <th className="px-4 py-3 text-right">Shares</th>
                      <th className="px-4 py-3 text-right">Cost Basis</th>
                      <th className="px-4 py-3 text-right">Market Value</th>
                      <th className="px-4 py-3 text-right">Unrealized Loss</th>
                      <th className="px-4 py-3 text-center">Period</th>
                      <th className="px-4 py-3 text-right">Tax Savings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.map(c => (
                      <tr key={c.lotGuid} className="border-b border-border/30 hover:bg-background-secondary/20 transition-colors">
                        <td className="px-4 py-3 font-medium text-foreground">{c.ticker}</td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/accounts/${c.accountGuid}`}
                            className="text-cyan-400 hover:text-cyan-300 transition-colors"
                          >
                            {c.accountName}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-foreground-secondary">{c.lotTitle}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{c.shares.toFixed(4)}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{formatCurrency(c.costBasis, 'USD')}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{formatCurrency(c.marketValue, 'USD')}</td>
                        <td className="px-4 py-3 text-right font-mono text-rose-400">{formatCurrency(c.unrealizedLoss, 'USD')}</td>
                        <td className="px-4 py-3 text-center">
                          {c.holdingPeriod && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              c.holdingPeriod === 'long_term'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : 'bg-amber-500/20 text-amber-400'
                            }`}>
                              {c.holdingPeriod === 'long_term' ? 'LT' : 'ST'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-emerald-400">
                          {formatCurrency(
                            Math.abs(c.unrealizedLoss) * (
                              c.holdingPeriod === 'long_term'
                                ? longTermRate / 100
                                : shortTermRate / 100
                            ),
                            'USD'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {data.washSales.length > 0 && (
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl overflow-hidden">
              <div className="p-4 border-b border-amber-500/20">
                <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider">
                  Wash Sale Warnings
                </h3>
                <p className="text-xs text-foreground-muted mt-1">
                  These sales occurred within 30 days of a purchase of the same security (including across accounts).
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-amber-500/20">
                      <th className="px-4 py-3 text-left">Ticker</th>
                      <th className="px-4 py-3 text-left">Sell Date</th>
                      <th className="px-4 py-3 text-left">Sell Account</th>
                      <th className="px-4 py-3 text-right">Shares</th>
                      <th className="px-4 py-3 text-right">Loss</th>
                      <th className="px-4 py-3 text-left">Wash Buy Date</th>
                      <th className="px-4 py-3 text-left">Buy Account</th>
                      <th className="px-4 py-3 text-center">Days Apart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.washSales.map((ws, i) => (
                      <tr key={`${ws.splitGuid}-${i}`} className="border-b border-amber-500/10 hover:bg-amber-500/5 transition-colors">
                        <td className="px-4 py-3 font-medium text-foreground">{ws.ticker}</td>
                        <td className="px-4 py-3 text-foreground-secondary">{new Date(ws.sellDate).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-foreground-secondary">{ws.sellAccountName}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{ws.shares.toFixed(4)}</td>
                        <td className="px-4 py-3 text-right font-mono text-rose-400">{formatCurrency(ws.loss, 'USD')}</td>
                        <td className="px-4 py-3 text-foreground-secondary">{new Date(ws.washBuyDate).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-foreground-secondary">{ws.washBuyAccountName}</td>
                        <td className="px-4 py-3 text-center font-mono text-amber-400">{ws.daysApart}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
