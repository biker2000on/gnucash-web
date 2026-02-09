'use client';

import Link from 'next/link';

interface Budget {
    guid: string;
    name: string;
    description: string | null;
    num_periods: number;
    _count?: {
        amounts: number;
    };
}

interface BudgetListProps {
    budgets: Budget[];
    onEdit?: (budget: Budget) => void;
    onDelete?: (budget: Budget) => void;
}

export function BudgetList({ budgets, onEdit, onDelete }: BudgetListProps) {
    if (budgets.length === 0) {
        return (
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 text-center">
                <svg className="w-16 h-16 mx-auto text-foreground-muted mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <h3 className="text-lg font-medium text-foreground-secondary mb-2">No Budgets Yet</h3>
                <p className="text-foreground-muted mb-6">
                    Create your first budget to start tracking your financial goals.
                </p>
            </div>
        );
    }

    const getPeriodLabel = (num: number) => {
        if (num === 1) return 'Yearly';
        if (num === 4) return 'Quarterly';
        if (num === 12) return 'Monthly';
        return `${num} Periods`;
    };

    return (
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl overflow-hidden">
            <table className="w-full">
                <thead>
                    <tr className="bg-surface/50 text-foreground-secondary text-xs uppercase tracking-widest">
                        <th className="px-6 py-4 text-left font-semibold">Name</th>
                        <th className="px-6 py-4 text-left font-semibold">Period Type</th>
                        <th className="px-6 py-4 text-left font-semibold">Accounts</th>
                        <th className="px-6 py-4 text-left font-semibold">Description</th>
                        <th className="px-6 py-4 text-right font-semibold">Actions</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {budgets.map(budget => (
                        <tr
                            key={budget.guid}
                            className="hover:bg-white/[0.02] transition-colors group"
                        >
                            <td className="px-6 py-4">
                                <Link
                                    href={`/budgets/${budget.guid}`}
                                    className="text-foreground font-medium hover:text-cyan-400 transition-colors"
                                >
                                    {budget.name}
                                </Link>
                            </td>
                            <td className="px-6 py-4">
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                                    {getPeriodLabel(budget.num_periods)}
                                </span>
                            </td>
                            <td className="px-6 py-4 text-sm text-foreground-secondary">
                                {budget._count?.amounts || 0} allocations
                            </td>
                            <td className="px-6 py-4 text-sm text-foreground-muted max-w-xs truncate">
                                {budget.description || '—'}
                            </td>
                            <td className="px-6 py-4">
                                <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <Link
                                        href={`/budgets/${budget.guid}`}
                                        className="p-2 rounded-lg hover:bg-cyan-500/20 text-foreground-muted hover:text-cyan-400 transition-colors"
                                        title="View Budget"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                        </svg>
                                    </Link>
                                    {onEdit && (
                                        <button
                                            onClick={() => onEdit(budget)}
                                            className="p-2 rounded-lg hover:bg-cyan-500/20 text-foreground-muted hover:text-cyan-400 transition-colors"
                                            title="Edit Budget"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                            </svg>
                                        </button>
                                    )}
                                    {onDelete && (
                                        <button
                                            onClick={() => onDelete(budget)}
                                            className="p-2 rounded-lg hover:bg-rose-500/20 text-foreground-muted hover:text-rose-400 transition-colors"
                                            title="Delete Budget"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                            </svg>
                                        </button>
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
