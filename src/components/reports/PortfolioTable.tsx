'use client';

import { InvestmentPortfolioData, PortfolioHolding } from '@/lib/reports/types';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileCard } from '@/components/ui/MobileCard';
import {
    CostBasisCoverageMark,
    CoverageCaption,
    CoveredSliceNote,
    gainHeading,
    BASIS_CONSEQUENCE,
} from '@/components/investments/CostBasisCoverageMark';
import { sameCoverageStatement } from '@/lib/holdings-coverage';

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
    if (value > 0) return 'text-positive';
    if (value < 0) return 'text-negative';
    return 'text-foreground';
}

interface PortfolioTableProps {
    data: InvestmentPortfolioData;
    onAccountClick?: (holding: PortfolioHolding) => void;
}

export function PortfolioTable({ data, onAccountClick }: PortfolioTableProps) {
    const { holdings, totals } = data;
    const isMobile = useIsMobile();

    // This report sums split values with no transfer tracing, so every row's
    // basis is equally unverified. One always-visible caption states that for
    // the whole table instead of repeating a marker down N rows — a caption,
    // not a header tooltip: a reader scrolled past the header, or one who never
    // hovers, must still see the caveat next to the numbers.
    //
    // A row states its own whenever its coverage says something DIFFERENT from
    // the caption. Compared by meaning, not by status: two partial rows reading
    // "150 of 200" and "10 of 900" share a tag and describe different
    // positions, so a caption written from the aggregate speaks for neither.
    const columnCoverage = totals.costBasisCoverage;
    const statesItsOwn = (h: PortfolioHolding) =>
        !sameCoverageStatement(h.costBasisCoverage, columnCoverage);
    const everyRowMatchesCaption = holdings.every(h => !statesItsOwn(h));
    const totalsMark = (
        <CostBasisCoverageMark coverage={columnCoverage} consequence={BASIS_CONSEQUENCE} />
    );
    const caption = holdings.length > 0 && (
        everyRowMatchesCaption ? (
            <CoverageCaption
                coverage={columnCoverage}
                consequence={BASIS_CONSEQUENCE}
                scope="All rows"
                className="mb-3 text-left"
            />
        ) : (
            <p className="mb-3 text-left text-xs text-warning">
                Rows whose cost basis does not cover their whole position are marked; their
                gain and gain % cover those shares only.
            </p>
        )
    );

    if (isMobile) {
        // No caption on this path: a mobile card is its own row and already
        // states its coverage inline, so a caption would only repeat it.
        return (
            <div className="p-4">
                {holdings.length === 0 ? (
                    <div className="py-8 text-sm text-foreground-secondary text-center">
                        No investment holdings found
                    </div>
                ) : (
                    <>
                        {holdings.map((h) => (
                            <MobileCard
                                key={h.guid}
                                fields={[
                                    {
                                        label: 'Account',
                                        value: onAccountClick && h.guid ? (
                                            <button
                                                type="button"
                                                onClick={() => onAccountClick(h)}
                                                className="text-primary hover:underline text-left focus:outline-none focus:underline"
                                            >
                                                {h.accountName}
                                            </button>
                                        ) : (
                                            h.accountName
                                        ),
                                    },
                                    { label: 'Symbol', value: <span className="font-mono">{h.symbol}</span> },
                                    { label: 'Shares', value: <span className="font-mono">{fmtShares(h.shares)}</span> },
                                    { label: 'Price', value: <span className="font-mono">{fmtCurrency(h.latestPrice)}</span> },
                                    { label: 'Price Date', value: h.priceDate || '-' },
                                    { label: 'Market Value', value: <span className="font-mono">{fmtCurrency(h.marketValue)}</span> },
                                    {
                                        label: 'Cost Basis',
                                        value: (
                                            <span className="font-mono">
                                                {fmtCurrency(h.costBasis)}
                                                <CostBasisCoverageMark
                                                    coverage={h.costBasisCoverage}
                                                    consequence={BASIS_CONSEQUENCE}
                                                />
                                            </span>
                                        ),
                                    },
                                    {
                                        // A card has no column header to hang the hint on, so
                                        // each one states its own coverage.
                                        label: gainHeading(h.costBasisCoverage),
                                        value: (
                                            <span className={`font-mono ${gainColor(h.gain)}`}>
                                                {fmtCurrency(h.gain)}
                                                <CostBasisCoverageMark
                                                    coverage={h.costBasisCoverage}
                                                    consequence={BASIS_CONSEQUENCE}
                                                />
                                                <CoveredSliceNote coverage={h.costBasisCoverage} />
                                            </span>
                                        ),
                                    },
                                    {
                                        label: 'Gain %',
                                        value: (
                                            <span className={`font-mono ${gainColor(h.gainPercent)}`}>
                                                {fmtPercent(h.gainPercent)}
                                                <CostBasisCoverageMark
                                                    coverage={h.costBasisCoverage}
                                                    consequence={BASIS_CONSEQUENCE}
                                                />
                                            </span>
                                        ),
                                    },
                                ]}
                            />
                        ))}
                        {/* Totals */}
                        <div className="border-t-2 border-border p-4 space-y-1">
                            <div className="text-sm font-bold text-foreground">Totals</div>
                            <div className="flex justify-between text-sm">
                                <span className="text-foreground-muted uppercase text-xs">Market Value</span>
                                <span className="font-mono font-bold">{fmtCurrency(totals.marketValue)}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-foreground-muted uppercase text-xs">Cost Basis</span>
                                <span className="font-mono font-bold">
                                    {fmtCurrency(totals.costBasis)}
                                    {totalsMark}
                                </span>
                            </div>
                            <div className="flex items-start justify-between text-sm">
                                <span className="text-foreground-muted uppercase text-xs">
                                    {gainHeading(columnCoverage)}
                                </span>
                                <span className="text-right">
                                    <span className={`font-mono font-bold ${gainColor(totals.gain)}`}>
                                        {fmtCurrency(totals.gain)}
                                        {totalsMark}
                                    </span>
                                    <CoveredSliceNote coverage={columnCoverage} />
                                </span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-foreground-muted uppercase text-xs">Gain %</span>
                                <span className={`font-mono font-bold ${gainColor(totals.gainPercent)}`}>
                                    {fmtPercent(totals.gainPercent)}
                                    {totalsMark}
                                </span>
                            </div>
                        </div>
                    </>
                )}
            </div>
        );
    }

    return (
        <div className="p-6">
            {caption}
            <table className="w-full border-collapse">
                <thead>
                    <tr className="border-b border-border">
                        <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Account</th>
                        <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Symbol</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Shares</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Price</th>
                        <th className="text-center py-2 px-3 text-sm font-semibold text-foreground-secondary">Price Date</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Market Value</th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">
                            Cost Basis
                        </th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">
                            {gainHeading(columnCoverage)}
                        </th>
                        <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">
                            Gain %
                        </th>
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
                            <td className="py-2 px-3 text-sm text-foreground">
                                {onAccountClick && h.guid ? (
                                    <button
                                        type="button"
                                        onClick={() => onAccountClick(h)}
                                        className="text-primary hover:underline text-left focus:outline-none focus:underline"
                                    >
                                        {h.accountName}
                                    </button>
                                ) : (
                                    h.accountName
                                )}
                            </td>
                            <td className="py-2 px-3 text-sm text-foreground-secondary font-mono">{h.symbol}</td>
                            <td className="py-2 px-3 text-sm text-right font-mono text-foreground">{fmtShares(h.shares)}</td>
                            <td className="py-2 px-3 text-sm text-right font-mono text-foreground">{fmtCurrency(h.latestPrice)}</td>
                            <td className="py-2 px-3 text-sm text-center text-foreground-secondary">{h.priceDate || '-'}</td>
                            <td className="py-2 px-3 text-sm text-right font-mono text-foreground">{fmtCurrency(h.marketValue)}</td>
                            <td className="py-2 px-3 text-sm text-right font-mono text-foreground">
                                {fmtCurrency(h.costBasis)}
                                {statesItsOwn(h) && (
                                    <CostBasisCoverageMark
                                        coverage={h.costBasisCoverage}
                                        consequence={BASIS_CONSEQUENCE}
                                    />
                                )}
                            </td>
                            <td className={`py-2 px-3 text-sm text-right font-mono ${gainColor(h.gain)}`}>
                                {fmtCurrency(h.gain)}
                                {statesItsOwn(h) && (
                                    <>
                                        <CostBasisCoverageMark
                                            coverage={h.costBasisCoverage}
                                            consequence={BASIS_CONSEQUENCE}
                                        />
                                        <CoveredSliceNote coverage={h.costBasisCoverage} />
                                    </>
                                )}
                            </td>
                            <td className={`py-2 px-3 text-sm text-right font-mono ${gainColor(h.gainPercent)}`}>
                                {fmtPercent(h.gainPercent)}
                                {statesItsOwn(h) && (
                                    <CostBasisCoverageMark
                                        coverage={h.costBasisCoverage}
                                        consequence={BASIS_CONSEQUENCE}
                                    />
                                )}
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
                                {totalsMark}
                            </td>
                            <td className={`py-2 px-3 text-sm text-right font-mono font-bold ${gainColor(totals.gain)}`}>
                                {fmtCurrency(totals.gain)}
                                {totalsMark}
                                <CoveredSliceNote coverage={columnCoverage} />
                            </td>
                            <td className={`py-2 px-3 text-sm text-right font-mono font-bold ${gainColor(totals.gainPercent)}`}>
                                {fmtPercent(totals.gainPercent)}
                                {totalsMark}
                            </td>
                        </tr>
                    </tfoot>
                )}
            </table>
        </div>
    );
}
