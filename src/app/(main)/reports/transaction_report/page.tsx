'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import { TransactionReportData, TransactionReportItem } from '@/lib/reports/transaction-report';
import { formatCurrency } from '@/lib/format';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
        startDate: startOfMonth.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function ReconcileIcon({ state }: { state: string }) {
    switch (state) {
        case 'y':
            return <span className="text-emerald-400" title="Reconciled">R</span>;
        case 'c':
            return <span className="text-yellow-400" title="Cleared">C</span>;
        default:
            return <span className="text-neutral-600" title="Not reconciled">-</span>;
    }
}

export default function TransactionReportPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<TransactionReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (filters.accountTypes?.length) params.set('accountTypes', filters.accountTypes.join(','));

            const res = await fetch(`/api/reports/transaction-report?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    return (
        <ReportViewer
            title="Transaction Report"
            description="Detailed list of transactions with filters"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={false}
        >
            {reportData && (
                <>
                    {/* Summary */}
                    <div className="grid grid-cols-3 gap-4 p-4 border-b border-neutral-800">
                        <div className="text-center">
                            <div className="text-sm text-neutral-400">Total Debits</div>
                            <div className="text-lg font-mono text-emerald-400">
                                {formatCurrency(reportData.totalDebits, 'USD')}
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="text-sm text-neutral-400">Total Credits</div>
                            <div className="text-lg font-mono text-rose-400">
                                {formatCurrency(reportData.totalCredits, 'USD')}
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="text-sm text-neutral-400">Net Amount</div>
                            <div className={`text-lg font-mono ${reportData.netAmount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {formatCurrency(reportData.netAmount, 'USD')}
                            </div>
                        </div>
                    </div>

                    {/* Transactions Table */}
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-neutral-700 text-neutral-400 text-sm uppercase tracking-wider">
                                    <th className="py-3 px-4 text-left font-medium">Date</th>
                                    <th className="py-3 px-4 text-left font-medium">Description</th>
                                    <th className="py-3 px-4 text-left font-medium">Account</th>
                                    <th className="py-3 px-4 text-right font-medium">Amount</th>
                                    <th className="py-3 px-4 text-center font-medium w-12">R</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-800/50">
                                {reportData.transactions.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="py-8 text-center text-neutral-400">
                                            No transactions found for this period.
                                        </td>
                                    </tr>
                                ) : (
                                    reportData.transactions.map((tx) => (
                                        <tr key={tx.guid} className="hover:bg-neutral-800/20 transition-colors">
                                            <td className="py-2 px-4 text-neutral-300 font-mono text-sm">
                                                {tx.date}
                                            </td>
                                            <td className="py-2 px-4 text-neutral-200">
                                                <div>{tx.description}</div>
                                                {tx.memo && (
                                                    <div className="text-xs text-neutral-500">{tx.memo}</div>
                                                )}
                                            </td>
                                            <td className="py-2 px-4 text-neutral-400 text-sm">
                                                {tx.account}
                                            </td>
                                            <td className="py-2 px-4 text-right font-mono">
                                                <span className={tx.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                                    {formatCurrency(tx.amount, 'USD')}
                                                </span>
                                            </td>
                                            <td className="py-2 px-4 text-center font-mono">
                                                <ReconcileIcon state={tx.reconciled} />
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Transaction Count */}
                    <div className="p-4 border-t border-neutral-800 text-sm text-neutral-400 text-right">
                        {reportData.transactions.length} transaction{reportData.transactions.length !== 1 ? 's' : ''} found
                    </div>
                </>
            )}
        </ReportViewer>
    );
}
