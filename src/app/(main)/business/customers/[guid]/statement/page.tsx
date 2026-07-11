'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { CustomerStatement, StatementAging } from '@/lib/business/customer-statement';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const AGING_COLUMNS: Array<{ key: keyof StatementAging; label: string }> = [
    { key: 'current', label: 'Current' },
    { key: 'b1_30', label: '1–30' },
    { key: 'b31_60', label: '31–60' },
    { key: 'b61_90', label: '61–90' },
    { key: 'b90plus', label: '90+' },
    { key: 'total', label: 'Total due' },
];

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function firstOfYearIso(): string {
    return `${new Date().getFullYear()}-01-01`;
}

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

export default function CustomerStatementPage() {
    const params = useParams<{ guid: string }>();
    const { error } = useToast();

    const [startDate, setStartDate] = useState<string | null>(firstOfYearIso());
    const [endDate, setEndDate] = useState<string | null>(todayIso());
    const [statement, setStatement] = useState<CustomerStatement | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    const fetchStatement = useCallback(async () => {
        setLoading(true);
        try {
            const query = new URLSearchParams();
            if (startDate) query.set('startDate', startDate);
            query.set('endDate', endDate ?? todayIso());
            const res = await fetch(`/api/business/customers/${params.guid}/statement?${query}`);
            const data = await res.json().catch(() => null);
            if (res.status === 404) {
                setNotFound(true);
                return;
            }
            if (!res.ok) throw new Error(data?.error || 'Failed to load the statement');
            setStatement(data);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load the statement');
        } finally {
            setLoading(false);
        }
    }, [params.guid, startDate, endDate, error]);

    useEffect(() => { fetchStatement(); }, [fetchStatement]);

    const handlePrint = () => {
        if (!statement) return;
        const currency = statement.customer.currency;
        const addr = statement.customer.address;
        const addressLines = [addr.name, addr.addr1, addr.addr2, addr.addr3, addr.addr4]
            .filter((l): l is string => Boolean(l && l.trim()))
            .map((l) => escapeHtml(l))
            .join('<br>');

        const rows = statement.activity.map((line) => `
            <tr>
                <td>${escapeHtml(line.date)}</td>
                <td>${line.type === 'invoice' ? 'Invoice' : 'Payment'}</td>
                <td>${escapeHtml(line.ref)}</td>
                <td class="num">${formatCurrency(line.amount, currency)}</td>
                <td class="num">${formatCurrency(line.balance, currency)}</td>
            </tr>`).join('');

        const agingCells = AGING_COLUMNS.map((c) => `
            <td class="num${c.key === 'total' ? ' grand' : ''}">${formatCurrency(statement.aging[c.key], currency)}</td>`).join('');
        const agingHead = AGING_COLUMNS.map((c) => `<th class="num">${c.label}</th>`).join('');

        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) return;
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title></title>
                <style>
                    * { box-sizing: border-box; color: #000; }
                    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; margin: 0; padding: 1cm; }
                    h1 { font-size: 22px; letter-spacing: 0.15em; margin: 0; }
                    .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
                    .meta { text-align: right; font-size: 12px; }
                    .meta div { margin-bottom: 2px; }
                    .party { margin-bottom: 24px; }
                    .party .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 4px; }
                    .party .name { font-weight: 700; font-size: 14px; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
                    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1.5px solid #333; padding: 6px 8px; }
                    td { padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
                    .num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
                    .balance-row td { font-weight: 700; border-bottom: none; }
                    .grand { font-weight: 700; }
                    .aging { margin-top: 24px; }
                    .aging-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 4px; }
                    @media print {
                        @page { margin: 0; size: auto; }
                        body { margin: 0; padding: 1cm; }
                    }
                </style>
            </head>
            <body>
                <div class="head">
                    <h1>STATEMENT</h1>
                    <div class="meta">
                        <div>${statement.period.startDate ? `Period: ${escapeHtml(statement.period.startDate)} — ${escapeHtml(statement.period.endDate)}` : `Through: ${escapeHtml(statement.period.endDate)}`}</div>
                        <div>Customer #: ${escapeHtml(statement.customer.id)}</div>
                    </div>
                </div>
                <div class="party">
                    <div class="label">Statement for</div>
                    <div class="name">${escapeHtml(statement.customer.name)}</div>
                    ${addressLines ? `<div>${addressLines}</div>` : ''}
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Type</th>
                            <th>Ref</th>
                            <th class="num">Amount</th>
                            <th class="num">Balance</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr class="balance-row">
                            <td>${escapeHtml(statement.period.startDate ?? '')}</td>
                            <td colspan="3">Opening balance</td>
                            <td class="num">${formatCurrency(statement.openingBalance, currency)}</td>
                        </tr>
                        ${rows}
                        <tr class="balance-row">
                            <td>${escapeHtml(statement.period.endDate)}</td>
                            <td colspan="3">Closing balance</td>
                            <td class="num">${formatCurrency(statement.closingBalance, currency)}</td>
                        </tr>
                    </tbody>
                </table>
                <div class="aging">
                    <div class="aging-title">Aging of open balance (as of ${escapeHtml(statement.period.endDate)})</div>
                    <table>
                        <thead><tr>${agingHead}</tr></thead>
                        <tbody><tr>${agingCells}</tr></tbody>
                    </table>
                </div>
            </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    };

    if (notFound) {
        return (
            <div className="p-12 text-center text-foreground-muted">
                Customer not found.{' '}
                <Link href="/business/customers" className="text-primary hover:text-primary-hover">Back to customers</Link>
            </div>
        );
    }

    const currency = statement?.customer.currency ?? 'USD';
    const addr = statement?.customer.address;
    const addressLines = addr
        ? [addr.name, addr.addr1, addr.addr2, addr.addr3, addr.addr4].filter((l): l is string => Boolean(l && l.trim()))
        : [];

    return (
        <div className="space-y-4">
            <PageHeader
                title={statement ? `Statement — ${statement.customer.name}` : 'Customer Statement'}
                subtitle="Invoices and payments over a period with running balance."
                actions={
                    <div className="flex items-center gap-2">
                        <DateRangePicker
                            startDate={startDate}
                            endDate={endDate}
                            onChange={(range) => {
                                setStartDate(range.startDate);
                                setEndDate(range.endDate ?? todayIso());
                            }}
                        />
                        <button
                            type="button"
                            onClick={handlePrint}
                            disabled={!statement}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                        >
                            Print
                        </button>
                    </div>
                }
            />

            <div className="flex items-center gap-3 text-sm">
                <Link
                    href="/business/customers"
                    className="text-foreground-muted hover:text-foreground transition-colors"
                >
                    ← All customers
                </Link>
                {statement && (
                    <span className="text-xs text-foreground-muted font-mono tabular-nums" style={TNUM}>
                        Customer #{statement.customer.id}
                    </span>
                )}
            </div>

            {loading ? (
                <div className="p-12 flex items-center justify-center gap-3">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading statement...</span>
                </div>
            ) : statement && (
                <>
                    {/* Address block */}
                    {addressLines.length > 0 && (
                        <div className="bg-surface border border-border rounded-lg p-4 text-sm">
                            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-1">Statement for</div>
                            <div className="font-semibold text-foreground">{statement.customer.name}</div>
                            {addressLines.map((line, i) => (
                                <div key={i} className="text-foreground-secondary">{line}</div>
                            ))}
                        </div>
                    )}

                    {/* Activity */}
                    <div className="bg-surface border border-border rounded-lg overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-[13px]">
                                <thead>
                                    <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                        <th className="px-4 py-2 font-semibold">Date</th>
                                        <th className="px-4 py-2 font-semibold">Type</th>
                                        <th className="px-4 py-2 font-semibold">Ref</th>
                                        <th className="px-4 py-2 font-semibold text-right">Amount</th>
                                        <th className="px-4 py-2 font-semibold text-right">Balance</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    <tr className="bg-background-secondary/30">
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>
                                            {statement.period.startDate ?? '—'}
                                        </td>
                                        <td className="px-4 py-2 text-foreground font-semibold" colSpan={3}>Opening balance</td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-right font-semibold text-foreground" style={TNUM}>
                                            {formatCurrency(statement.openingBalance, currency)}
                                        </td>
                                    </tr>
                                    {statement.activity.length === 0 ? (
                                        <tr>
                                            <td colSpan={5} className="px-4 py-6 text-center text-foreground-muted">
                                                No activity in this period.
                                            </td>
                                        </tr>
                                    ) : statement.activity.map((line, i) => (
                                        <tr key={i} className="hover:bg-surface-hover/50 transition-colors">
                                            <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{line.date}</td>
                                            <td className="px-4 py-2">
                                                <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${
                                                    line.type === 'invoice'
                                                        ? 'bg-secondary-light text-secondary'
                                                        : 'bg-positive/10 text-positive'
                                                }`}>
                                                    {line.type === 'invoice' ? 'Invoice' : 'Payment'}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{line.ref}</td>
                                            <td className={`px-4 py-2 font-mono tabular-nums text-right ${line.amount < 0 ? 'text-positive' : 'text-foreground'}`} style={TNUM}>
                                                {formatCurrency(line.amount, currency)}
                                            </td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                                {formatCurrency(line.balance, currency)}
                                            </td>
                                        </tr>
                                    ))}
                                    <tr className="bg-background-secondary/30">
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>
                                            {statement.period.endDate}
                                        </td>
                                        <td className="px-4 py-2 text-foreground font-semibold" colSpan={3}>Closing balance</td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-right font-semibold text-foreground" style={TNUM}>
                                            {formatCurrency(statement.closingBalance, currency)}
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        {/* Aging footer */}
                        <div className="border-t border-border px-4 py-3">
                            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-2">
                                Aging of open balance (as of {statement.period.endDate})
                            </div>
                            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                                {AGING_COLUMNS.map((c) => (
                                    <span key={c.key} className="flex items-baseline gap-1.5">
                                        <span className={`text-xs ${c.key === 'total' ? 'text-foreground font-semibold' : 'text-foreground-secondary'}`}>
                                            {c.label}
                                        </span>
                                        <span
                                            className={`font-mono tabular-nums ${
                                                c.key === 'total'
                                                    ? 'font-semibold text-foreground'
                                                    : statement.aging[c.key] !== 0 && c.key !== 'current'
                                                        ? 'text-negative'
                                                        : 'text-foreground-secondary'
                                            }`}
                                            style={TNUM}
                                        >
                                            {formatCurrency(statement.aging[c.key], currency)}
                                        </span>
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
