'use client';

import { InvestmentPortfolioData } from '@/lib/reports/types';

function fmtCurrency(n: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(n);
}

function fmtShares(n: number): string {
    // Use up to 4 decimal places, trimming trailing zeros
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
    }).format(n);
}

function fmtPercent(n: number): string {
    return n.toFixed(2) + '%';
}

function gainColor(value: number): string {
    if (value > 0) return 'text-emerald-400';
    if (value < 0) return 'text-rose-400';
    return 'text-foreground';
}

interface PortfolioTableProps {
    data: InvestmentPortfolioData;
}

export function PortfolioTable({ data }: PortfolioTableProps) {
    const { holdings, totals } = data;

    return (
        <div className="p-6">
            <table className="w-full border-collapse">
                <thead>
                    <tr className="border-b border-border">
                        <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Account</th>
                        <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Symbol</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Shares</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Price</th>
                        <th className="text-center py-2 px-3 text-sm font-semibold text-foreground-secondary">Price Date</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Market Value</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Cost Basis</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Gain/Loss</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Gain %</th>
                    </tr>
                </thead>
                <tbody>
                    {holdings.length === 0 && (
                        <tr>
                            <td colSpan={9} className="py-8 px-3 text-sm text-foreground-secondary text-center">
                                No investment holdings found
                            </td>
                        </tr>
                    )}
                    {holdings.map((h) => (
                        <tr key={h.guid} className="border-b border-border/50 hover:bg-surface-hover/30 transition-colors">
                            <td className="py-2 px-3 text-sm text-foreground">{h.accountName}</td>
                            <td className="py-2 px-3 text-sm text-foreground-secondary font-mono">{h.symbol}</td>
                            <td className="py-2 px-3 text-sm text-right font-mono text-foreground">{fmtShares(h.shares)}</td>
                            <td className="py-2 px-3 text-sm text-right font-mono text-foreground">{fmtCurrency(h.latestPrice)}</td>
                            <td className="py-2 px-3 text-sm text-center text-foreground-secondary">{h.priceDate || '-'}</td>
                            <td className="py-2 px-3 text-sm text-right font-mono text-foreground">{fmtCurrency(h.marketValue)}</td>
                            <td className="py-2 px-3 text-sm text-right font-mono text-foreground">{fmtCurrency(h.costBasis)}</td>
                            <td className={`py-2 px-3 text-sm text-right font-mono ${gainColor(h.gain)}`}>
                                {fmtCurrency(h.gain)}
                            </td>
                            <td className={`py-2 px-3 text-sm text-right font-mono ${gainColor(h.gainPercent)}`}>
                                {fmtPercent(h.gainPercent)}
                            </td>
                        </tr>
                    ))}
                </tbody>
                {holdings.length > 0 && (
                    <tfoot>
                        <tr className="border-t-2 border-border">
                            <td colSpan={5} className="py-2 px-3 text-sm font-bold text-foreground">
                                Totals
                            </td>
                            <td className="py-2 px-3 text-sm text-right font-mono font-bold text-foreground">
                                {fmtCurrency(totals.marketValue)}
                            </td>
                            <td className="py-2 px-3 text-sm text-right font-mono font-bold text-foreground">
                                {fmtCurrency(totals.costBasis)}
                            </td>
                            <td className={`py-2 px-3 text-sm text-right font-mono font-bold ${gainColor(totals.gain)}`}>
                                {fmtCurrency(totals.gain)}
                            </td>
                            <td className={`py-2 px-3 text-sm text-right font-mono font-bold ${gainColor(totals.gainPercent)}`}>
                                {fmtPercent(totals.gainPercent)}
                            </td>
                        </tr>
                    </tfoot>
                )}
            </table>
        </div>
    );
}
