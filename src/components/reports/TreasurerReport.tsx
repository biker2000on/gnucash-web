'use client';

import { TreasurerReportData } from '@/lib/reports/types';

function fmtCurrency(n: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(n);
}

interface TreasurerReportProps {
    data: TreasurerReportData;
}

export function TreasurerReport({ data }: TreasurerReportProps) {
    const { header, openingBalance, incomeSummary, expenseSummary, closingBalance } = data;

    const expectedClosing = Math.round(
        (openingBalance.total + incomeSummary.total - expenseSummary.total) * 100
    ) / 100;
    const balancesMatch = Math.abs(expectedClosing - closingBalance.total) < 0.01;

    return (
        <div className="p-6 space-y-8">
            {/* Report Header */}
            <div className="text-center space-y-1">
                {header.organization && (
                    <h2 className="text-2xl font-bold text-foreground">
                        Treasurer&apos;s Report for {header.organization}
                    </h2>
                )}
                {!header.organization && (
                    <h2 className="text-2xl font-bold text-foreground">
                        Treasurer&apos;s Report
                    </h2>
                )}
                {header.personName && (
                    <p className="text-foreground-secondary">
                        Prepared by {header.personName}
                        {header.roleName ? `, ${header.roleName}` : ''}
                    </p>
                )}
                <p className="text-foreground-secondary">
                    Period: {header.periodStart} to {header.periodEnd}
                </p>
                <p className="text-sm text-foreground-secondary">
                    Report Date: {header.reportDate}
                </p>
            </div>

            {/* Opening Balance */}
            <section>
                <h3 className="text-lg font-semibold text-foreground mb-3 border-b border-border pb-2">
                    Opening Balance
                </h3>
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="border-b border-border">
                            <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">
                                Account Name
                            </th>
                            <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">
                                Balance
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {openingBalance.accounts.map((account, i) => (
                            <tr key={i} className="border-b border-border/50">
                                <td className="py-2 px-3 text-sm text-foreground">{account.name}</td>
                                <td className="py-2 px-3 text-sm text-right font-mono text-foreground">
                                    {fmtCurrency(account.balance)}
                                </td>
                            </tr>
                        ))}
                        {openingBalance.accounts.length === 0 && (
                            <tr>
                                <td colSpan={2} className="py-4 px-3 text-sm text-foreground-secondary text-center">
                                    No asset accounts found
                                </td>
                            </tr>
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-border">
                            <td className="py-2 px-3 text-sm font-bold text-foreground">Total Opening Balance</td>
                            <td className="py-2 px-3 text-sm text-right font-mono font-bold text-foreground">
                                {fmtCurrency(openingBalance.total)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </section>

            {/* Income Summary */}
            <section>
                <h3 className="text-lg font-semibold text-emerald-400 mb-3 border-b border-border pb-2">
                    Income Summary
                </h3>
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="border-b border-border">
                            <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Date</th>
                            <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Description</th>
                            <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Category</th>
                            <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Amount</th>
                        </tr>
                    </thead>
                    <tbody>
                        {incomeSummary.transactions.map((tx, i) => (
                            <tr key={i} className="border-b border-border/50">
                                <td className="py-2 px-3 text-sm text-foreground">{tx.date}</td>
                                <td className="py-2 px-3 text-sm text-foreground">{tx.description}</td>
                                <td className="py-2 px-3 text-sm text-foreground-secondary">{tx.category}</td>
                                <td className="py-2 px-3 text-sm text-right font-mono text-emerald-400">
                                    {fmtCurrency(tx.amount)}
                                </td>
                            </tr>
                        ))}
                        {incomeSummary.transactions.length === 0 && (
                            <tr>
                                <td colSpan={4} className="py-4 px-3 text-sm text-foreground-secondary text-center">
                                    No income transactions in this period
                                </td>
                            </tr>
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-border">
                            <td colSpan={3} className="py-2 px-3 text-sm font-bold text-foreground">Total Income</td>
                            <td className="py-2 px-3 text-sm text-right font-mono font-bold text-emerald-400">
                                {fmtCurrency(incomeSummary.total)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </section>

            {/* Expense Summary */}
            <section>
                <h3 className="text-lg font-semibold text-rose-400 mb-3 border-b border-border pb-2">
                    Expense Summary
                </h3>
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="border-b border-border">
                            <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Date</th>
                            <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Description</th>
                            <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">Category</th>
                            <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">Amount</th>
                        </tr>
                    </thead>
                    <tbody>
                        {expenseSummary.transactions.map((tx, i) => (
                            <tr key={i} className="border-b border-border/50">
                                <td className="py-2 px-3 text-sm text-foreground">{tx.date}</td>
                                <td className="py-2 px-3 text-sm text-foreground">{tx.description}</td>
                                <td className="py-2 px-3 text-sm text-foreground-secondary">{tx.category}</td>
                                <td className="py-2 px-3 text-sm text-right font-mono text-rose-400">
                                    {fmtCurrency(tx.amount)}
                                </td>
                            </tr>
                        ))}
                        {expenseSummary.transactions.length === 0 && (
                            <tr>
                                <td colSpan={4} className="py-4 px-3 text-sm text-foreground-secondary text-center">
                                    No expense transactions in this period
                                </td>
                            </tr>
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-border">
                            <td colSpan={3} className="py-2 px-3 text-sm font-bold text-foreground">Total Expenses</td>
                            <td className="py-2 px-3 text-sm text-right font-mono font-bold text-rose-400">
                                {fmtCurrency(expenseSummary.total)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </section>

            {/* Closing Balance */}
            <section>
                <h3 className="text-lg font-semibold text-foreground mb-3 border-b border-border pb-2">
                    Closing Balance
                </h3>
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="border-b border-border">
                            <th className="text-left py-2 px-3 text-sm font-semibold text-foreground-secondary">
                                Account Name
                            </th>
                            <th className="text-right py-2 px-3 text-sm font-semibold text-foreground-secondary">
                                Balance
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {closingBalance.accounts.map((account, i) => (
                            <tr key={i} className="border-b border-border/50">
                                <td className="py-2 px-3 text-sm text-foreground">{account.name}</td>
                                <td className="py-2 px-3 text-sm text-right font-mono text-foreground">
                                    {fmtCurrency(account.balance)}
                                </td>
                            </tr>
                        ))}
                        {closingBalance.accounts.length === 0 && (
                            <tr>
                                <td colSpan={2} className="py-4 px-3 text-sm text-foreground-secondary text-center">
                                    No asset accounts found
                                </td>
                            </tr>
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-border">
                            <td className="py-2 px-3 text-sm font-bold text-foreground">Total Closing Balance</td>
                            <td className="py-2 px-3 text-sm text-right font-mono font-bold text-foreground">
                                {fmtCurrency(closingBalance.total)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </section>

            {/* Verification Line */}
            <section className="bg-background-tertiary/50 rounded-xl p-4 border border-border">
                <h3 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider mb-3">
                    Balance Verification
                </h3>
                <div className="space-y-1 font-mono text-sm">
                    <div className="flex justify-between">
                        <span className="text-foreground-secondary">Opening Balance</span>
                        <span className="text-foreground">{fmtCurrency(openingBalance.total)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-foreground-secondary">+ Total Income</span>
                        <span className="text-emerald-400">{fmtCurrency(incomeSummary.total)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-foreground-secondary">- Total Expenses</span>
                        <span className="text-rose-400">{fmtCurrency(expenseSummary.total)}</span>
                    </div>
                    <div className="flex justify-between border-t border-border pt-1 mt-1">
                        <span className="text-foreground font-semibold">= Expected Closing Balance</span>
                        <span className="text-foreground font-bold">{fmtCurrency(expectedClosing)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-foreground-secondary">Actual Closing Balance</span>
                        <span className="text-foreground">{fmtCurrency(closingBalance.total)}</span>
                    </div>
                    {!balancesMatch && (
                        <div className="flex justify-between text-amber-400 mt-1">
                            <span>Difference</span>
                            <span>{fmtCurrency(closingBalance.total - expectedClosing)}</span>
                        </div>
                    )}
                    <div className="mt-2 text-xs">
                        {balancesMatch ? (
                            <span className="text-emerald-400">Balances match - report verified</span>
                        ) : (
                            <span className="text-amber-400">
                                Note: Difference may be due to transfers between asset accounts or currency conversions
                            </span>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
