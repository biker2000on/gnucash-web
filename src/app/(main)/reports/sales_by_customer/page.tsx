'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import type { SalesByCustomerData, CustomerSalesRow } from '@/lib/reports/sales-by-customer';
import { escapeCSVField, downloadCSV } from '@/lib/reports/csv-export';
import { formatCurrency } from '@/lib/format';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function generateSalesByCustomerCSV(data: SalesByCustomerData): string {
    const rows: string[] = ['Customer,Invoices,Subtotal,Tax,Total,Payments,Balance'];
    const line = (name: string, row: Omit<CustomerSalesRow, 'customerGuid' | 'customerName'>) => [
        escapeCSVField(name),
        row.invoiceCount,
        row.subtotal.toFixed(2),
        row.tax.toFixed(2),
        row.total.toFixed(2),
        row.payments.toFixed(2),
        row.balance.toFixed(2),
    ].join(',');

    for (const customer of data.customers) {
        rows.push(line(customer.customerName, customer));
    }
    rows.push('');
    rows.push(line('TOTALS', data.totals));
    return rows.join('\n');
}

function AmountCell({ value, currency }: { value: number; currency: string }) {
    return (
        <td className={`py-2 px-4 text-sm text-right font-mono ${value < 0 ? 'text-rose-400' : 'text-foreground'}`}>
            {formatCurrency(value, currency)}
        </td>
    );
}

export default function SalesByCustomerPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<SalesByCustomerData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/sales-by-customer?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data: SalesByCustomerData = await res.json();
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

    const handleExportCSV = () => {
        if (reportData) {
            const csv = generateSalesByCustomerCSV(reportData);
            downloadCSV(csv, 'Sales_by_Customer.csv');
        }
    };

    const currency = reportData?.currency ?? 'USD';

    return (
        <ReportViewer
            title="Sales by Customer"
            description="Posted customer invoice totals per customer with tax, payments, and balance"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={false}
            reportData={reportData ?? undefined}
        >
            {reportData && (
                <>
                    {/* Summary bar */}
                    <div className="flex items-center justify-between p-3 border-b border-border text-sm text-foreground-secondary">
                        <span>
                            {reportData.customers.length} customer{reportData.customers.length !== 1 ? 's' : ''}
                            {' '}· {reportData.totals.invoiceCount} invoice{reportData.totals.invoiceCount !== 1 ? 's' : ''}
                        </span>
                        <span className="text-xs">
                            Posted {reportData.startDate} – {reportData.endDate}
                        </span>
                    </div>

                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-border-hover text-foreground-secondary text-sm uppercase tracking-wider">
                                <th className="py-2 px-4 text-left font-medium">Customer</th>
                                <th className="py-2 px-4 text-right font-medium">Invoices</th>
                                <th className="py-2 px-4 text-right font-medium">Subtotal</th>
                                <th className="py-2 px-4 text-right font-medium">Tax</th>
                                <th className="py-2 px-4 text-right font-medium">Total</th>
                                <th className="py-2 px-4 text-right font-medium">Payments</th>
                                <th className="py-2 px-4 text-right font-medium">Balance</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                            {reportData.customers.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="py-8 px-4 text-center text-foreground-secondary">
                                        No posted customer invoices found in this date range
                                    </td>
                                </tr>
                            ) : (
                                reportData.customers.map(customer => (
                                    <tr key={customer.customerGuid} className="hover:bg-surface-hover/20 transition-colors">
                                        <td className="py-2 px-4 text-sm text-foreground">{customer.customerName}</td>
                                        <td className="py-2 px-4 text-sm text-right font-mono text-foreground-secondary">
                                            {customer.invoiceCount}
                                        </td>
                                        <AmountCell value={customer.subtotal} currency={currency} />
                                        <AmountCell value={customer.tax} currency={currency} />
                                        <AmountCell value={customer.total} currency={currency} />
                                        <AmountCell value={customer.payments} currency={currency} />
                                        <AmountCell value={customer.balance} currency={currency} />
                                    </tr>
                                ))
                            )}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-border-hover bg-background-tertiary/50">
                                <td className="py-3 px-4 font-semibold text-foreground">Totals</td>
                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                    {reportData.totals.invoiceCount}
                                </td>
                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                    {formatCurrency(reportData.totals.subtotal, currency)}
                                </td>
                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                    {formatCurrency(reportData.totals.tax, currency)}
                                </td>
                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                    {formatCurrency(reportData.totals.total, currency)}
                                </td>
                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                    {formatCurrency(reportData.totals.payments, currency)}
                                </td>
                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                    {formatCurrency(reportData.totals.balance, currency)}
                                </td>
                            </tr>
                        </tfoot>
                    </table>

                    {/* Custom CSV export button */}
                    <div className="border-t border-border p-4 flex justify-end no-print">
                        <button
                            onClick={handleExportCSV}
                            className="flex items-center gap-2 px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            Export Sales by Customer CSV
                        </button>
                    </div>
                </>
            )}
        </ReportViewer>
    );
}
