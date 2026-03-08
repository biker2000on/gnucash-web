'use client';

import { TrialBalanceData } from '@/lib/reports/types';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileCard } from '@/components/ui/MobileCard';

function fmtCurrency(n: number): string {
    if (n === 0) return '';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(n);
}

function fmtCurrencyTotal(n: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(n);
}

interface TrialBalanceTableProps {
    data: TrialBalanceData;
}

export function TrialBalanceTable({ data }: TrialBalanceTableProps) {
    const { entries, totalDebits, totalCredits } = data;
    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;
    const isMobile = useIsMobile();

    if (isMobile) {
        return (
            <div>
                {/* Summary bar */}
                <div className="flex items-center justify-between p-3 border-b border-border text-sm text-foreground-secondary">
                    <span>{entries.length} account{entries.length !== 1 ? 's' : ''}</span>
                    {isBalanced ? (
                        <span className="text-emerald-400 text-xs font-medium">Balanced</span>
                    ) : (
                        <span className="text-rose-400 text-xs font-medium">
                            Imbalance: {fmtCurrencyTotal(Math.abs(totalDebits - totalCredits))}
                        </span>
                    )}
                </div>

                {entries.length === 0 ? (
                    <div className="py-8 px-4 text-center text-foreground-secondary">
                        No accounts with balances found
                    </div>
                ) : (
                    entries.map((entry) => (
                        <MobileCard
                            key={entry.guid}
                            fields={[
                                { label: 'Account', value: entry.accountPath },
                                { label: 'Account Type', value: entry.accountType },
                                ...(entry.debit > 0 ? [{ label: 'Debit', value: <span className="font-mono">{fmtCurrency(entry.debit)}</span> }] : []),
                                ...(entry.credit > 0 ? [{ label: 'Credit', value: <span className="font-mono">{fmtCurrency(entry.credit)}</span> }] : []),
                            ]}
                        />
                    ))
                )}

                {/* Totals */}
                <div className={`border-t-2 p-4 ${isBalanced ? 'border-border-hover bg-background-tertiary/50' : 'border-rose-500/50 bg-rose-500/10'}`}>
                    <div className="text-sm font-semibold text-foreground mb-1">Totals</div>
                    <div className="flex justify-between text-sm font-mono font-semibold">
                        <span className={isBalanced ? 'text-foreground' : 'text-rose-400'}>Debits: {fmtCurrencyTotal(totalDebits)}</span>
                        <span className={isBalanced ? 'text-foreground' : 'text-rose-400'}>Credits: {fmtCurrencyTotal(totalCredits)}</span>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div>
            {/* Summary bar */}
            <div className="flex items-center justify-between p-3 border-b border-border text-sm text-foreground-secondary">
                <span>{entries.length} account{entries.length !== 1 ? 's' : ''}</span>
                {isBalanced ? (
                    <span className="text-emerald-400 text-xs font-medium">Balanced</span>
                ) : (
                    <span className="text-rose-400 text-xs font-medium">
                        Imbalance: {fmtCurrencyTotal(Math.abs(totalDebits - totalCredits))}
                    </span>
                )}
            </div>

            <table className="w-full">
                <thead>
                    <tr className="border-b border-border-hover text-foreground-secondary text-sm uppercase tracking-wider">
                        <th className="py-2 px-4 text-left font-medium">Account</th>
                        <th className="py-2 px-4 text-left font-medium">Account Type</th>
                        <th className="py-2 px-4 text-right font-medium">Debit</th>
                        <th className="py-2 px-4 text-right font-medium">Credit</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                    {entries.length === 0 ? (
                        <tr>
                            <td colSpan={4} className="py-8 px-4 text-center text-foreground-secondary">
                                No accounts with balances found
                            </td>
                        </tr>
                    ) : (
                        entries.map((entry) => (
                            <tr key={entry.guid} className="hover:bg-surface-hover/20 transition-colors">
                                <td className="py-2 px-4 text-sm text-foreground">
                                    {entry.accountPath}
                                </td>
                                <td className="py-2 px-4 text-sm text-foreground-secondary">
                                    {entry.accountType}
                                </td>
                                <td className="py-2 px-4 text-sm text-right font-mono text-foreground">
                                    {fmtCurrency(entry.debit)}
                                </td>
                                <td className="py-2 px-4 text-sm text-right font-mono text-foreground">
                                    {fmtCurrency(entry.credit)}
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
                <tfoot>
                    <tr className={`border-t-2 ${isBalanced ? 'border-border-hover bg-background-tertiary/50' : 'border-rose-500/50 bg-rose-500/10'}`}>
                        <td className="py-3 px-4 font-semibold text-foreground">
                            Totals
                        </td>
                        <td className="py-3 px-4" />
                        <td className={`py-3 px-4 text-right font-mono font-semibold ${isBalanced ? 'text-foreground' : 'text-rose-400'}`}>
                            {fmtCurrencyTotal(totalDebits)}
                        </td>
                        <td className={`py-3 px-4 text-right font-mono font-semibold ${isBalanced ? 'text-foreground' : 'text-rose-400'}`}>
                            {fmtCurrencyTotal(totalCredits)}
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}
