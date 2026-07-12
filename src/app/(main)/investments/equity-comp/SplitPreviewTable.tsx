'use client';

import { formatCurrency } from '@/lib/format';
import type { EquityCompSplitSpec } from '@/lib/equity-comp-core';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

export interface PreviewRowLabels {
    /** role → account display name (falls back to the role label). */
    accountNames: Partial<Record<EquityCompSplitSpec['role'], string>>;
}

const ROLE_FALLBACK: Record<EquityCompSplitSpec['role'], string> = {
    stock: 'Stock account',
    income: 'Compensation income',
    tax: 'Tax withholding',
    cash: 'Cash account',
};

/**
 * Debits/credits preview of the splits a vest/ESPP posting will generate.
 * Quantities show for the stock leg only; currency legs mirror their value.
 */
export function SplitPreviewTable({
    specs,
    labels,
}: {
    specs: EquityCompSplitSpec[];
    labels: PreviewRowLabels;
}) {
    const totalDebit = specs.reduce((acc, s) => acc + Math.max(0, s.valueNum / s.valueDenom), 0);
    const totalCredit = specs.reduce((acc, s) => acc + Math.max(0, -s.valueNum / s.valueDenom), 0);

    return (
        <div className="border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-background-tertiary text-xs text-foreground-muted uppercase tracking-wider">
                            <th className="text-left font-semibold px-3 py-2">Account</th>
                            <th className="text-right font-semibold px-3 py-2">Shares</th>
                            <th className="text-right font-semibold px-3 py-2">Debit</th>
                            <th className="text-right font-semibold px-3 py-2">Credit</th>
                        </tr>
                    </thead>
                    <tbody>
                        {specs.map((spec, i) => {
                            const value = spec.valueNum / spec.valueDenom;
                            const isStock = spec.role === 'stock';
                            const shares = spec.quantityNum / spec.quantityDenom;
                            return (
                                <tr key={i} className="border-t border-border">
                                    <td className="px-3 py-2">
                                        <div className="text-foreground truncate max-w-[16rem]">
                                            {labels.accountNames[spec.role] || ROLE_FALLBACK[spec.role]}
                                        </div>
                                        <div className="text-xs text-foreground-muted truncate max-w-[16rem]">
                                            {spec.memo}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono text-foreground-secondary" style={MONO}>
                                        {isStock ? shares.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—'}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono text-foreground" style={MONO}>
                                        {value > 0 ? formatCurrency(value) : ''}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono text-foreground" style={MONO}>
                                        {value < 0 ? formatCurrency(-value) : ''}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot>
                        <tr className="border-t border-border bg-background-tertiary/50">
                            <td className="px-3 py-2 text-xs text-foreground-muted uppercase tracking-wider">Totals</td>
                            <td />
                            <td className="px-3 py-2 text-right font-mono font-medium text-foreground" style={MONO}>
                                {formatCurrency(totalDebit)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-medium text-foreground" style={MONO}>
                                {formatCurrency(totalCredit)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
            <div className="px-3 py-2 border-t border-border text-xs text-foreground-muted">
                Balanced double-entry preview. Share quantities shown at 1/10000 precision; the
                actual posting uses the security&apos;s own fraction, and trading-account splits are
                added automatically when the book carries them.
            </div>
        </div>
    );
}
