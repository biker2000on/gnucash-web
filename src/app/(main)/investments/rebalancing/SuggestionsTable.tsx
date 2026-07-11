'use client';

import { useState } from 'react';
import type { RebalanceSuggestion } from '@/lib/rebalancing';
import { formatCurrency } from '@/lib/format';

interface SuggestionsTableProps {
    suggestions: RebalanceSuggestion[];
    mode: 'buy-only' | 'full';
    /** Optional header override (sector mode uses this for net symbol trades). */
    title?: string;
}

function termLabel(term: 'short_term' | 'long_term' | null): string {
    if (term === 'long_term') return 'LT';
    if (term === 'short_term') return 'ST';
    return '?';
}

/**
 * Rebalancing suggestions: BUY/SELL rows with mono amounts. SELL rows
 * carry a tax annotation — estimated realized gain/loss with term
 * breakdown, harvested losses framed positively — and expand to show
 * the tax-ordered lot consumption plan.
 */
export function SuggestionsTable({ suggestions, mode, title }: SuggestionsTableProps) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const toggle = (key: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const totalBuys = suggestions
        .filter(s => s.action === 'BUY')
        .reduce((sum, s) => sum + s.amount, 0);
    const totalSells = suggestions
        .filter(s => s.action === 'SELL')
        .reduce((sum, s) => sum + s.amount, 0);

    return (
        <div className="bg-background-secondary rounded-lg border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground">
                    {title ?? (mode === 'buy-only' ? 'Buy-Only Suggestions (New Cash)' : 'Rebalance Suggestions')}
                </h3>
                <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
                    {totalSells > 0 && (
                        <span className="text-foreground-secondary">
                            Sells: <span className="text-negative">{formatCurrency(totalSells)}</span>
                        </span>
                    )}
                    <span className="text-foreground-secondary">
                        Buys: <span className="text-positive">{formatCurrency(totalBuys)}</span>
                    </span>
                </div>
            </div>

            {mode === 'buy-only' && (
                <div className="px-4 py-2 text-xs text-foreground-muted bg-background-tertiary/40 border-b border-border">
                    Cash-flow rebalancing: new cash is allocated to underweight
                    positions in proportion to their dollar shortfall — no sells,
                    no realized gains.
                </div>
            )}

            {suggestions.length === 0 ? (
                <div className="px-4 py-8 text-center text-foreground-muted text-sm">
                    Nothing to do — portfolio is on target.
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                        <thead className="bg-background-tertiary/50">
                            <tr className="text-left text-xs text-foreground-secondary">
                                <th className="px-4 py-2 font-medium">Action</th>
                                <th className="px-4 py-2 font-medium">Symbol</th>
                                <th className="px-4 py-2 font-medium text-right">Amount</th>
                                <th className="px-4 py-2 font-medium">Est. Tax Impact</th>
                                <th className="px-2 py-2 w-8" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {suggestions.map(s => {
                                const rowKey = `${s.action}:${s.key}`;
                                const isOpen = expanded.has(rowKey);
                                const hasLots = s.tax && s.tax.lots.length > 0;
                                return (
                                    <SuggestionRow
                                        key={rowKey}
                                        suggestion={s}
                                        isOpen={isOpen}
                                        canExpand={!!hasLots}
                                        onToggle={() => toggle(rowKey)}
                                    />
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function SuggestionRow({
    suggestion: s,
    isOpen,
    canExpand,
    onToggle,
}: {
    suggestion: RebalanceSuggestion;
    isOpen: boolean;
    canExpand: boolean;
    onToggle: () => void;
}) {
    const tax = s.tax;
    const netLoss = tax !== undefined && tax.estimatedGain < 0;

    return (
        <>
            <tr className={`hover:bg-surface-hover/40 ${!s.outsideBand ? 'opacity-70' : ''}`}>
                <td className="px-4 py-2">
                    <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                            s.action === 'BUY'
                                ? 'bg-positive/15 text-positive'
                                : 'bg-negative/15 text-negative'
                        }`}
                    >
                        {s.action}
                    </span>
                    {!s.outsideBand && (
                        <span className="ml-2 text-xs text-foreground-muted" title="Drift is within the tolerance band">
                            within band
                        </span>
                    )}
                </td>
                <td className="px-4 py-2">
                    <div className="font-mono font-medium text-foreground">{s.key}</div>
                    {s.label !== s.key && (
                        <div className="text-xs text-foreground-muted truncate max-w-[200px]">{s.label}</div>
                    )}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">
                    {formatCurrency(s.amount)}
                </td>
                <td className="px-4 py-2 text-xs">
                    {s.action === 'BUY' ? (
                        <span className="text-foreground-muted">None (buy)</span>
                    ) : tax ? (
                        <div className="space-y-0.5">
                            <div className={`font-mono tabular-nums ${netLoss ? 'text-positive' : 'text-foreground-secondary'}`}>
                                {netLoss
                                    ? `Harvests ${formatCurrency(Math.abs(tax.estimatedGain))} loss`
                                    : `Est. gain ${formatCurrency(tax.estimatedGain)}`}
                            </div>
                            <div className="text-foreground-muted font-mono tabular-nums">
                                {tax.harvestedLoss < 0 && !netLoss && (
                                    <span className="text-positive">
                                        {formatCurrency(Math.abs(tax.harvestedLoss))} loss offset ·{' '}
                                    </span>
                                )}
                                {tax.longTermGain > 0 && <span>LT +{formatCurrency(tax.longTermGain)} · </span>}
                                {tax.shortTermGain > 0 && (
                                    <span className="text-warning">ST +{formatCurrency(tax.shortTermGain)} · </span>
                                )}
                                {Math.round(tax.coverage * 100)}% lot coverage
                            </div>
                        </div>
                    ) : (
                        <span className="text-foreground-muted">No lot data</span>
                    )}
                </td>
                <td className="px-2 py-2 text-right">
                    {canExpand && (
                        <button
                            onClick={onToggle}
                            className="p-1 text-foreground-muted hover:text-foreground rounded hover:bg-surface-hover transition-colors"
                            aria-label={isOpen ? `Hide lots for ${s.key}` : `Show lots for ${s.key}`}
                            aria-expanded={isOpen}
                        >
                            <svg
                                className={`w-4 h-4 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </button>
                    )}
                </td>
            </tr>
            {isOpen && tax && tax.lots.length > 0 && (
                <tr>
                    <td colSpan={5} className="px-4 pb-3 pt-0 bg-background-tertiary/30">
                        <div className="mt-2 text-xs text-foreground-muted mb-1.5">
                            Sell order (losses → long-term gains → short-term gains):
                        </div>
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-left text-foreground-muted">
                                    <th className="py-1 pr-3 font-medium">Lot</th>
                                    <th className="py-1 pr-3 font-medium">Account</th>
                                    <th className="py-1 pr-3 font-medium">Term</th>
                                    <th className="py-1 pr-3 font-medium text-right">Sell</th>
                                    <th className="py-1 font-medium text-right">Est. Gain/Loss</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tax.lots.map(lot => (
                                    <tr key={lot.lotGuid} className="border-t border-border/60">
                                        <td className="py-1 pr-3 text-foreground-secondary">{lot.title}</td>
                                        <td className="py-1 pr-3 text-foreground-muted">{lot.accountName || '—'}</td>
                                        <td className="py-1 pr-3">
                                            <span
                                                className={
                                                    lot.term === 'long_term'
                                                        ? 'text-foreground-secondary'
                                                        : 'text-warning'
                                                }
                                            >
                                                {termLabel(lot.term)}
                                            </span>
                                        </td>
                                        <td className="py-1 pr-3 text-right font-mono tabular-nums text-foreground-secondary">
                                            {formatCurrency(lot.sellValue)}
                                        </td>
                                        <td
                                            className={`py-1 text-right font-mono tabular-nums ${
                                                lot.estimatedGain < 0 ? 'text-positive' : 'text-foreground-secondary'
                                            }`}
                                        >
                                            {lot.estimatedGain < 0
                                                ? `−${formatCurrency(Math.abs(lot.estimatedGain))} loss`
                                                : `+${formatCurrency(lot.estimatedGain)}`}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </td>
                </tr>
            )}
        </>
    );
}
