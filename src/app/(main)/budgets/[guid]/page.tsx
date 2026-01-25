'use client';

import { useState, useEffect, useMemo, use } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';

interface BudgetAmount {
    id: number;
    budget_guid: string;
    account_guid: string;
    period_num: number;
    amount_num: string;
    amount_denom: string;
    amount_decimal: string;
    account_name: string;
    commodity_mnemonic: string;
    account: {
        guid: string;
        name: string;
        account_type: string;
    };
}

interface Budget {
    guid: string;
    name: string;
    description: string | null;
    num_periods: number;
    amounts: BudgetAmount[];
}

interface BudgetDetailPageProps {
    params: Promise<{ guid: string }>;
}

export default function BudgetDetailPage({ params }: BudgetDetailPageProps) {
    const { guid } = use(params);
    const [budget, setBudget] = useState<Budget | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchBudget() {
            try {
                const res = await fetch(`/api/budgets/${guid}`);
                if (!res.ok) {
                    if (res.status === 404) {
                        throw new Error('Budget not found');
                    }
                    throw new Error('Failed to fetch budget');
                }
                const data = await res.json();
                setBudget(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
                setLoading(false);
            }
        }
        fetchBudget();
    }, [guid]);

    // Organize amounts by account
    const accountData = useMemo(() => {
        if (!budget) return [];

        const accountMap = new Map<string, {
            guid: string;
            name: string;
            type: string;
            mnemonic: string;
            periods: Map<number, number>;
            total: number;
        }>();

        for (const amount of budget.amounts) {
            const existing = accountMap.get(amount.account_guid);
            const value = parseFloat(amount.amount_decimal) || 0;

            if (existing) {
                existing.periods.set(amount.period_num, value);
                existing.total += value;
            } else {
                const periods = new Map<number, number>();
                periods.set(amount.period_num, value);
                accountMap.set(amount.account_guid, {
                    guid: amount.account_guid,
                    name: amount.account_name,
                    type: amount.account.account_type,
                    mnemonic: amount.commodity_mnemonic,
                    periods,
                    total: value,
                });
            }
        }

        return Array.from(accountMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [budget]);

    // Calculate period totals
    const periodTotals = useMemo(() => {
        if (!budget) return [];

        const totals = new Array(budget.num_periods).fill(0);
        for (const account of accountData) {
            for (const [period, value] of account.periods) {
                if (period >= 1 && period <= budget.num_periods) {
                    totals[period - 1] += value;
                }
            }
        }
        return totals;
    }, [budget, accountData]);

    const grandTotal = periodTotals.reduce((sum, val) => sum + val, 0);

    const getPeriodLabel = (num: number, index: number) => {
        if (num === 12) {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            return months[index];
        }
        if (num === 4) {
            return `Q${index + 1}`;
        }
        return `P${index + 1}`;
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <div className="flex items-center gap-4">
                    <Link
                        href="/budgets"
                        className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <div className="h-8 w-48 bg-neutral-800 rounded animate-pulse" />
                </div>
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                        <span className="text-neutral-400">Loading budget...</span>
                    </div>
                </div>
            </div>
        );
    }

    if (error || !budget) {
        return (
            <div className="space-y-6">
                <div className="flex items-center gap-4">
                    <Link
                        href="/budgets"
                        className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <h1 className="text-3xl font-bold text-neutral-100">Budget Not Found</h1>
                </div>
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 text-center">
                    <div className="text-rose-400">{error || 'Budget not found'}</div>
                    <Link
                        href="/budgets"
                        className="inline-block mt-4 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg transition-colors"
                    >
                        Back to Budgets
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-4">
                    <Link
                        href="/budgets"
                        className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold text-neutral-100">{budget.name}</h1>
                        {budget.description && (
                            <p className="text-neutral-500">{budget.description}</p>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                        {budget.num_periods === 12 ? 'Monthly' : budget.num_periods === 4 ? 'Quarterly' : `${budget.num_periods} Periods`}
                    </span>
                    <span className="text-neutral-500 text-sm">
                        {accountData.length} accounts
                    </span>
                </div>
            </header>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-6">
                    <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Total Budget</div>
                    <div className="text-2xl font-bold text-emerald-400">
                        {formatCurrency(grandTotal.toString(), 'USD')}
                    </div>
                </div>
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-6">
                    <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Average per Period</div>
                    <div className="text-2xl font-bold text-cyan-400">
                        {formatCurrency((grandTotal / budget.num_periods).toString(), 'USD')}
                    </div>
                </div>
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-6">
                    <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Budgeted Accounts</div>
                    <div className="text-2xl font-bold text-neutral-200">{accountData.length}</div>
                </div>
            </div>

            {/* Budget Table */}
            {accountData.length === 0 ? (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-12 text-center">
                    <svg className="w-16 h-16 mx-auto text-neutral-700 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                    <h3 className="text-lg font-medium text-neutral-300 mb-2">No Budget Allocations</h3>
                    <p className="text-neutral-500">
                        This budget has no account allocations yet.
                    </p>
                </div>
            ) : (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-neutral-900/50 text-neutral-400 text-xs uppercase tracking-widest">
                                    <th className="px-4 py-3 text-left font-semibold sticky left-0 bg-neutral-900/90 backdrop-blur-sm">Account</th>
                                    {Array.from({ length: budget.num_periods }, (_, i) => (
                                        <th key={i} className="px-3 py-3 text-right font-semibold min-w-[80px]">
                                            {getPeriodLabel(budget.num_periods, i)}
                                        </th>
                                    ))}
                                    <th className="px-4 py-3 text-right font-semibold bg-neutral-800/50">Total</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-800/50">
                                {accountData.map(account => (
                                    <tr key={account.guid} className="hover:bg-white/[0.02] transition-colors">
                                        <td className="px-4 py-3 font-medium text-neutral-200 sticky left-0 bg-neutral-950/90 backdrop-blur-sm">
                                            <Link
                                                href={`/accounts/${account.guid}`}
                                                className="hover:text-cyan-400 transition-colors"
                                            >
                                                {account.name}
                                            </Link>
                                            <div className="text-xs text-neutral-500">{account.type}</div>
                                        </td>
                                        {Array.from({ length: budget.num_periods }, (_, i) => {
                                            const value = account.periods.get(i + 1) || 0;
                                            return (
                                                <td key={i} className="px-3 py-3 text-right font-mono text-neutral-300">
                                                    {value !== 0 ? formatCurrency(value.toString(), account.mnemonic) : '—'}
                                                </td>
                                            );
                                        })}
                                        <td className="px-4 py-3 text-right font-mono font-semibold text-emerald-400 bg-neutral-800/30">
                                            {formatCurrency(account.total.toString(), account.mnemonic)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="bg-neutral-800/50 font-semibold">
                                    <td className="px-4 py-3 text-neutral-200 sticky left-0 bg-neutral-800/90 backdrop-blur-sm">
                                        Total
                                    </td>
                                    {periodTotals.map((total, i) => (
                                        <td key={i} className="px-3 py-3 text-right font-mono text-cyan-400">
                                            {formatCurrency(total.toString(), 'USD')}
                                        </td>
                                    ))}
                                    <td className="px-4 py-3 text-right font-mono text-emerald-400 bg-emerald-500/10">
                                        {formatCurrency(grandTotal.toString(), 'USD')}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
