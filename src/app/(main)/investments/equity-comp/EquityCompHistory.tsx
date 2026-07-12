'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

interface HistoryItem {
    txGuid: string;
    kind: 'vest' | 'espp';
    postDate: string;
    description: string;
    symbol: string | null;
    stockAccountGuid: string | null;
    shares: number;
    costBasis: number;
    compensationIncome: number;
}

/**
 * History of previously posted vest/ESPP transactions, identified by their
 * gnucash_web_equity_comp slot tag. `version` bumps trigger a refetch.
 */
export function EquityCompHistory({ version }: { version: number }) {
    const [items, setItems] = useState<HistoryItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/equity-comp/history')
            .then(async res => {
                if (!res.ok) throw new Error((await res.json()).error || 'Failed to load history');
                return res.json() as Promise<HistoryItem[]>;
            })
            .then(data => { if (!cancelled) { setItems(data); setError(null); } })
            .catch(err => { if (!cancelled) setError(err.message); });
        return () => { cancelled = true; };
    }, [version]);

    return (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-4 sm:px-6 py-3 border-b border-border">
                <h2 className="text-base font-semibold text-foreground">Posted Vests &amp; Purchases</h2>
            </div>

            {error ? (
                <div className="p-6 text-center text-sm text-negative">{error}</div>
            ) : items === null ? (
                <div className="p-6 space-y-2">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="h-8 bg-background-tertiary rounded animate-pulse" />
                    ))}
                </div>
            ) : items.length === 0 ? (
                <div className="p-8 text-center">
                    <p className="text-foreground-secondary mb-1">No equity compensation recorded yet</p>
                    <p className="text-sm text-foreground-muted">
                        RSU vests and ESPP purchases posted from this page will appear here.
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-background-tertiary text-xs text-foreground-muted uppercase tracking-wider">
                                <th className="text-left font-semibold px-4 py-2">Date</th>
                                <th className="text-left font-semibold px-4 py-2">Type</th>
                                <th className="text-left font-semibold px-4 py-2">Description</th>
                                <th className="text-left font-semibold px-4 py-2">Symbol</th>
                                <th className="text-right font-semibold px-4 py-2">Shares</th>
                                <th className="text-right font-semibold px-4 py-2">Cost Basis</th>
                                <th className="text-right font-semibold px-4 py-2">Comp Income</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map(item => (
                                <tr key={item.txGuid} className="border-t border-border hover:bg-surface-hover/50">
                                    <td className="px-4 py-2 font-mono text-foreground-secondary whitespace-nowrap" style={MONO}>
                                        {item.postDate}
                                    </td>
                                    <td className="px-4 py-2">
                                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                                            item.kind === 'vest'
                                                ? 'bg-primary-light text-primary'
                                                : 'bg-secondary-light text-secondary'
                                        }`}>
                                            {item.kind === 'vest' ? 'RSU Vest' : 'ESPP'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2 text-foreground max-w-[24rem] truncate">
                                        {item.stockAccountGuid ? (
                                            <Link
                                                href={`/accounts/${item.stockAccountGuid}`}
                                                className="hover:text-primary transition-colors"
                                            >
                                                {item.description}
                                            </Link>
                                        ) : (
                                            item.description
                                        )}
                                    </td>
                                    <td className="px-4 py-2 font-mono text-foreground-secondary" style={MONO}>
                                        {item.symbol ?? '—'}
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                                        {item.shares.toLocaleString('en-US', { maximumFractionDigits: 6 })}
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                                        {formatCurrency(item.costBasis)}
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-positive" style={MONO}>
                                        {formatCurrency(item.compensationIncome)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
