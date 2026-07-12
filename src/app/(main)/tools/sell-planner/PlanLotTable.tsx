'use client';

import { formatCurrency } from '@/lib/format';
import type { SellPlan } from '@/lib/sell-planner';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

function fmtShares(v: number): string {
    return parseFloat(v.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function TermBadge({ term }: { term: 'short_term' | 'long_term' }) {
    return term === 'long_term' ? (
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-secondary-light text-secondary">
            LT
        </span>
    ) : (
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-warning/15 text-warning">
            ST
        </span>
    );
}

export default function PlanLotTable({ plan }: { plan: SellPlan }) {
    if (plan.sales.length === 0) {
        return (
            <p className="text-sm text-foreground-muted">
                No lots selected — nothing sellable for this strategy.
            </p>
        );
    }

    return (
        <div className="space-y-3">
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border text-[11px] uppercase tracking-wide text-foreground-muted">
                            <th className="text-left py-2 pr-3 font-medium">Security</th>
                            <th className="text-left py-2 pr-3 font-medium">Account</th>
                            <th className="text-right py-2 pr-3 font-medium">Sell shares</th>
                            <th className="text-left py-2 pr-3 font-medium">Acquired</th>
                            <th className="text-center py-2 pr-3 font-medium">Term</th>
                            <th className="text-right py-2 pr-3 font-medium">Basis</th>
                            <th className="text-right py-2 pr-3 font-medium">Proceeds</th>
                            <th className="text-right py-2 pr-3 font-medium">Gain</th>
                            <th className="text-left py-2 font-medium">Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {plan.sales.map(sale => (
                            <tr key={`${sale.lotGuid}`} className="border-b border-border/50">
                                <td className="py-2 pr-3 font-medium text-foreground">{sale.ticker}</td>
                                <td className="py-2 pr-3 text-foreground-secondary" title={sale.accountPath}>
                                    {sale.accountName}
                                </td>
                                <td className="py-2 pr-3 text-right font-mono text-foreground" style={MONO}>
                                    {fmtShares(sale.sharesToSell)}
                                    {sale.partial && (
                                        <span className="text-foreground-muted"> / {fmtShares(sale.lotShares)}</span>
                                    )}
                                </td>
                                <td className="py-2 pr-3 font-mono text-foreground-secondary" style={MONO}>
                                    {sale.acquiredDate}
                                </td>
                                <td className="py-2 pr-3 text-center"><TermBadge term={sale.term} /></td>
                                <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={MONO}>
                                    {formatCurrency(sale.costBasis)}
                                </td>
                                <td className="py-2 pr-3 text-right font-mono text-foreground" style={MONO}>
                                    {formatCurrency(sale.proceeds)}
                                </td>
                                <td
                                    className={`py-2 pr-3 text-right font-mono ${
                                        sale.gain > 0.005 ? 'text-positive' : sale.gain < -0.005 ? 'text-negative' : 'text-foreground-secondary'
                                    }`}
                                    style={MONO}
                                >
                                    {formatCurrency(sale.gain)}
                                </td>
                                <td className="py-2 text-[11px] text-foreground-muted space-x-1.5">
                                    {sale.partial && (
                                        <span className="px-1.5 py-0.5 rounded bg-background-tertiary text-foreground-secondary">
                                            partial
                                        </span>
                                    )}
                                    {sale.almostLongTerm && sale.daysUntilLongTerm !== null && (
                                        <span className="px-1.5 py-0.5 rounded bg-warning/15 text-warning">
                                            LT in {sale.daysUntilLongTerm}d
                                            {sale.waitSavesTax !== null && sale.waitSavesTax > 0
                                                ? ` — waiting saves ~${formatCurrency(sale.waitSavesTax)}`
                                                : ''}
                                        </span>
                                    )}
                                    {sale.washSaleRisk && (
                                        <span className="px-1.5 py-0.5 rounded bg-negative/15 text-negative">
                                            wash-sale risk
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="text-sm font-medium">
                            <td className="py-2 pr-3 text-foreground" colSpan={5}>Total</td>
                            <td className="py-2 pr-3 text-right font-mono text-foreground" style={MONO}>
                                {formatCurrency(plan.totalCostBasis)}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-foreground" style={MONO}>
                                {formatCurrency(plan.totalProceeds)}
                            </td>
                            <td
                                className={`py-2 pr-3 text-right font-mono ${
                                    plan.netGain > 0.005 ? 'text-positive' : plan.netGain < -0.005 ? 'text-negative' : 'text-foreground'
                                }`}
                                style={MONO}
                            >
                                {formatCurrency(plan.netGain)}
                            </td>
                            <td />
                        </tr>
                    </tfoot>
                </table>
            </div>

            {plan.skippedWashSales.length > 0 && (
                <div className="bg-background-tertiary/50 border border-border rounded-md p-3">
                    <p className="text-xs font-medium text-foreground-secondary mb-1.5">
                        Skipped for wash-sale exposure (bought within the last 30 days — the loss would be disallowed):
                    </p>
                    <ul className="space-y-0.5">
                        {plan.skippedWashSales.map(s => (
                            <li key={s.lotGuid} className="text-xs text-foreground-muted font-mono" style={MONO}>
                                {s.ticker} · {s.accountName} · loss {formatCurrency(s.unrealizedLoss)} · last buy {s.lastBuyDate}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
