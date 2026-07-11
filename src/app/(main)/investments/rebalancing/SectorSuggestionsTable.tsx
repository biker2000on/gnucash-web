'use client';

import type { RebalanceSuggestion } from '@/lib/rebalancing';
import type { SectorSuggestionGroup } from '@/lib/rebalancing-sector';
import { formatCurrency } from '@/lib/format';

interface SectorSuggestionsTableProps {
    groups: SectorSuggestionGroup[];
    /** Netted per-symbol suggestions (tax lives there), keyed by symbol. */
    netBySymbol: RebalanceSuggestion[];
    mode: 'buy-only' | 'full';
}

/**
 * Sector-mode suggestions: one group per out-of-band sector, with the
 * per-symbol trades that implement it listed underneath. A sector
 * cannot be traded directly, so each sector delta is split across the
 * symbols exposing that sector, proportional to their dollar
 * contribution (rounded to cents; residual assigned to the largest
 * contributor). Tax impact is estimated on each symbol's NET trade
 * across all sectors and shown in the table below this one.
 */
export function SectorSuggestionsTable({ groups, netBySymbol, mode }: SectorSuggestionsTableProps) {
    const netMap = new Map(netBySymbol.map(s => [s.key, s]));
    // Symbols appearing in more than one sector group (their slices net together)
    const symbolSectorCount = new Map<string, number>();
    for (const g of groups) {
        for (const t of g.trades) {
            symbolSectorCount.set(t.symbol, (symbolSectorCount.get(t.symbol) ?? 0) + 1);
        }
    }

    const totalBuys = groups
        .filter(g => g.action === 'BUY')
        .reduce((sum, g) => sum + g.amount, 0);
    const totalSells = groups
        .filter(g => g.action === 'SELL')
        .reduce((sum, g) => sum + g.amount, 0);

    return (
        <div className="bg-background-secondary rounded-lg border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground">
                    {mode === 'buy-only'
                        ? 'Sector Buy-Only Suggestions (New Cash)'
                        : 'Sector Rebalance Suggestions'}
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

            <div className="px-4 py-2 text-xs text-foreground-muted bg-background-tertiary/40 border-b border-border">
                Sectors cannot be traded directly — each sector delta is split
                across the holdings exposing it, proportional to their dollar
                contribution. Slices are rounded to cents (residual goes to the
                largest contributor); a fund spanning several sectors is netted
                into one trade below.
            </div>

            {groups.length === 0 ? (
                <div className="px-4 py-8 text-center text-foreground-muted text-sm">
                    Nothing to do — sector allocation is on target.
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                        <thead className="bg-background-tertiary/50">
                            <tr className="text-left text-xs text-foreground-secondary">
                                <th className="px-4 py-2 font-medium">Sector / Symbol</th>
                                <th className="px-4 py-2 font-medium text-right">Share of Sector</th>
                                <th className="px-4 py-2 font-medium text-right">Amount</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {groups.map(group => (
                                <SectorGroup
                                    key={`${group.action}:${group.sector}`}
                                    group={group}
                                    netMap={netMap}
                                    symbolSectorCount={symbolSectorCount}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function SectorGroup({
    group,
    netMap,
    symbolSectorCount,
}: {
    group: SectorSuggestionGroup;
    netMap: Map<string, RebalanceSuggestion>;
    symbolSectorCount: Map<string, number>;
}) {
    return (
        <>
            <tr className="bg-background-tertiary/30">
                <td className="px-4 py-2">
                    <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-semibold mr-2 ${
                            group.action === 'BUY'
                                ? 'bg-positive/15 text-positive'
                                : 'bg-negative/15 text-negative'
                        }`}
                    >
                        {group.action}
                    </span>
                    <span className="font-medium text-foreground">{group.sector}</span>
                    {!group.outsideBand && (
                        <span className="ml-2 text-xs text-foreground-muted" title="Drift is within the tolerance band">
                            within band
                        </span>
                    )}
                </td>
                <td className="px-4 py-2" />
                <td className="px-4 py-2 text-right font-mono tabular-nums font-medium text-foreground">
                    {formatCurrency(group.amount)}
                </td>
            </tr>
            {group.trades.length === 0 ? (
                <tr>
                    <td colSpan={3} className="px-4 py-2 pl-10 text-xs text-foreground-muted">
                        No current holding exposes this sector — a new position
                        would be needed to reach the target.
                    </td>
                </tr>
            ) : (
                group.trades.map(trade => {
                    const spansMultiple = (symbolSectorCount.get(trade.symbol) ?? 0) > 1;
                    const net = netMap.get(trade.symbol);
                    return (
                        <tr key={`${group.sector}:${trade.symbol}`} className="hover:bg-surface-hover/40">
                            <td className="px-4 py-1.5 pl-10">
                                <span className="font-mono text-foreground">{trade.symbol}</span>
                                {trade.label !== trade.symbol && (
                                    <span className="ml-2 text-xs text-foreground-muted">{trade.label}</span>
                                )}
                                {spansMultiple && net && (
                                    <span
                                        className="ml-2 text-xs text-foreground-muted"
                                        title="This holding appears in multiple sectors; its slices net into a single trade in the table below."
                                    >
                                        net {net.action.toLowerCase()} {formatCurrency(net.amount)}
                                    </span>
                                )}
                            </td>
                            <td className="px-4 py-1.5 text-right font-mono tabular-nums text-xs text-foreground-muted">
                                {(trade.shareOfSector * 100).toFixed(1)}%
                            </td>
                            <td className="px-4 py-1.5 text-right font-mono tabular-nums text-foreground-secondary">
                                {formatCurrency(trade.amount)}
                            </td>
                        </tr>
                    );
                })
            )}
        </>
    );
}
