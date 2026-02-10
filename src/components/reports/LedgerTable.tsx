'use client';

import { useState } from 'react';
import { GeneralLedgerData, LedgerAccount } from '@/lib/reports/types';

function fmtCurrency(n: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(n);
}

function AccountSection({ account }: { account: LedgerAccount }) {
    const [expanded, setExpanded] = useState(true);

    const sectionDebits = account.entries.reduce((sum, e) => sum + e.debit, 0);
    const sectionCredits = account.entries.reduce((sum, e) => sum + e.credit, 0);

    return (
        <div className="border-b border-border last:border-b-0">
            {/* Account Header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface-hover/30 transition-colors"
            >
                <svg
                    className={`w-4 h-4 text-foreground-secondary transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span className="font-semibold text-foreground">{account.accountPath}</span>
                <span className="text-xs text-foreground-muted ml-2 uppercase">{account.accountType}</span>
                {!expanded && (
                    <span className="ml-auto text-sm font-mono text-foreground-secondary">
                        Closing: {fmtCurrency(account.closingBalance)}
                    </span>
                )}
            </button>

            {/* Expanded Content */}
            {expanded && (
                <div className="px-4 pb-4">
                    {/* Opening Balance */}
                    <div className="flex justify-between px-3 py-2 bg-background-tertiary/50 rounded-t-lg border border-border">
                        <span className="text-sm font-medium text-foreground-secondary">Opening Balance</span>
                        <span className="text-sm font-mono font-medium text-foreground">
                            {fmtCurrency(account.openingBalance)}
                        </span>
                    </div>

                    {/* Transaction Table */}
                    <table className="w-full border-collapse">
                        <thead>
                            <tr className="border-b border-border bg-background-tertiary/30">
                                <th className="text-left py-2 px-3 text-xs font-semibold text-foreground-secondary uppercase tracking-wider w-28">
                                    Date
                                </th>
                                <th className="text-left py-2 px-3 text-xs font-semibold text-foreground-secondary uppercase tracking-wider">
                                    Description
                                </th>
                                <th className="text-right py-2 px-3 text-xs font-semibold text-foreground-secondary uppercase tracking-wider w-28">
                                    Debit
                                </th>
                                <th className="text-right py-2 px-3 text-xs font-semibold text-foreground-secondary uppercase tracking-wider w-28">
                                    Credit
                                </th>
                                <th className="text-right py-2 px-3 text-xs font-semibold text-foreground-secondary uppercase tracking-wider w-32">
                                    Balance
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {account.entries.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="py-4 px-3 text-sm text-foreground-secondary text-center">
                                        No transactions in this period
                                    </td>
                                </tr>
                            ) : (
                                account.entries.map((entry, i) => (
                                    <tr key={i} className="border-b border-border/30 hover:bg-surface-hover/20 transition-colors">
                                        <td className="py-1.5 px-3 text-sm text-foreground">{entry.date}</td>
                                        <td className="py-1.5 px-3 text-sm text-foreground">
                                            {entry.description}
                                            {entry.memo && (
                                                <span className="ml-2 text-xs text-foreground-muted">({entry.memo})</span>
                                            )}
                                        </td>
                                        <td className="py-1.5 px-3 text-sm text-right font-mono text-foreground">
                                            {entry.debit > 0 ? fmtCurrency(entry.debit) : ''}
                                        </td>
                                        <td className="py-1.5 px-3 text-sm text-right font-mono text-foreground">
                                            {entry.credit > 0 ? fmtCurrency(entry.credit) : ''}
                                        </td>
                                        <td className="py-1.5 px-3 text-sm text-right font-mono font-medium text-foreground">
                                            {fmtCurrency(entry.runningBalance)}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                        {account.entries.length > 0 && (
                            <tfoot>
                                <tr className="border-t border-border">
                                    <td className="py-1.5 px-3 text-xs text-foreground-muted" colSpan={2}>
                                        {account.entries.length} transaction{account.entries.length !== 1 ? 's' : ''}
                                    </td>
                                    <td className="py-1.5 px-3 text-xs text-right font-mono text-foreground-secondary">
                                        {sectionDebits > 0 ? fmtCurrency(sectionDebits) : ''}
                                    </td>
                                    <td className="py-1.5 px-3 text-xs text-right font-mono text-foreground-secondary">
                                        {sectionCredits > 0 ? fmtCurrency(sectionCredits) : ''}
                                    </td>
                                    <td className="py-1.5 px-3"></td>
                                </tr>
                            </tfoot>
                        )}
                    </table>

                    {/* Closing Balance */}
                    <div className="flex justify-between px-3 py-2 bg-background-tertiary/50 rounded-b-lg border border-border border-t-0">
                        <span className="text-sm font-medium text-foreground-secondary">Closing Balance</span>
                        <span className="text-sm font-mono font-bold text-foreground">
                            {fmtCurrency(account.closingBalance)}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}

interface LedgerTableProps {
    data: GeneralLedgerData;
}

export function LedgerTable({ data }: LedgerTableProps) {
    return (
        <div>
            {/* Account Sections */}
            {data.accounts.length === 0 ? (
                <div className="p-8 text-center text-foreground-secondary">
                    No accounts with activity found for this period.
                </div>
            ) : (
                <>
                    <div className="divide-y divide-border">
                        {data.accounts.map((account) => (
                            <AccountSection key={account.guid} account={account} />
                        ))}
                    </div>

                    {/* Grand Totals Footer */}
                    <div className="border-t-2 border-border bg-background-tertiary/50 px-4 py-3">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-bold text-foreground uppercase tracking-wider">
                                Grand Totals ({data.accounts.length} account{data.accounts.length !== 1 ? 's' : ''})
                            </span>
                            <div className="flex gap-8">
                                <div className="text-right">
                                    <div className="text-xs text-foreground-muted uppercase">Total Debits</div>
                                    <div className="text-sm font-mono font-bold text-foreground">
                                        {fmtCurrency(data.totalDebits)}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-xs text-foreground-muted uppercase">Total Credits</div>
                                    <div className="text-sm font-mono font-bold text-foreground">
                                        {fmtCurrency(data.totalCredits)}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
