'use client';

import { useState, useEffect, Suspense, Fragment } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type {
    AgingReport,
    AgingSide,
    AgingBucketKey,
} from '@/lib/business/business-reports';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const BUCKET_ORDER: AgingBucketKey[] = ['current', 'b1_30', 'b31_60', 'b61_90', 'b90plus'];
const BUCKET_LABELS: Record<AgingBucketKey, string> = {
    current: 'Current',
    b1_30: '1–30',
    b31_60: '31–60',
    b61_90: '61–90',
    b90plus: '90+',
};

function Amount({ value, muted, negative }: { value: number; muted?: boolean; negative?: boolean }) {
    if (Math.abs(value) < 0.005) {
        return (
            <span className="font-mono text-foreground-muted" style={TNUM}>—</span>
        );
    }
    const color = negative ? 'text-negative' : muted ? 'text-foreground-secondary' : 'text-foreground';
    return (
        <span className={`font-mono ${color}`} style={TNUM}>
            {formatCurrency(value)}
        </span>
    );
}

function AgingPageInner() {
    const searchParams = useSearchParams();
    const initialSide: AgingSide = searchParams.get('side') === 'ap' ? 'ap' : 'ar';

    const [side, setSide] = useState<AgingSide>(initialSide);
    const [report, setReport] = useState<AgingReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const hasInferredDueDates = report?.owners.some((owner) =>
        owner.invoices.some((invoice) => invoice.dueDateInferred),
    ) ?? false;

    // Escape collapses expanded owner rows. GlobalShortcuts owns the Escape
    // key registration and broadcasts 'exit-edit-mode' when nothing modal is
    // open — hooking that event avoids a second, dead Escape registration.
    useEffect(() => {
        const collapse = () => setExpanded(new Set());
        window.addEventListener('exit-edit-mode', collapse);
        return () => window.removeEventListener('exit-edit-mode', collapse);
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(`/api/business/reports/aging?side=${side}`);
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: AgingReport = await res.json();
                if (!cancelled) {
                    setReport(json);
                    setExpanded(new Set());
                }
            } catch {
                if (!cancelled) setError('Failed to load the aging report.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [side]);

    const toggleOwner = (guid: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(guid)) next.delete(guid);
            else next.add(guid);
            return next;
        });
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title={side === 'ar' ? 'Receivables Aging' : 'Payables Aging'}
                subtitle={`Open ${side === 'ar' ? 'customer invoices' : 'vendor bills'} bucketed by days past their stored transaction due date.`}
                actions={
                    <div className="flex rounded-lg border border-border p-0.5">
                        {(['ar', 'ap'] as const).map((s) => (
                            <button
                                key={s}
                                type="button"
                                onClick={() => setSide(s)}
                                className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                                    side === s
                                        ? 'bg-primary text-primary-foreground'
                                        : 'text-foreground-secondary hover:text-foreground'
                                }`}
                            >
                                {s === 'ar' ? 'AR' : 'AP'}
                            </button>
                        ))}
                    </div>
                }
            />

            {loading && (
                <div className="flex items-center justify-center py-12">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading...</span>
                    </div>
                </div>
            )}

            {!loading && error && (
                <div className="border border-error/30 bg-surface/30 rounded-lg p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && report && (
                <>
                    {report.owners.length === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-lg p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No open {side === 'ar' ? 'customer invoices' : 'vendor bills'} — everything
                                is paid up (or nothing has been posted yet).
                            </p>
                        </div>
                    ) : (
                        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-lg overflow-hidden">
                            {hasInferredDueDates && (
                                <p id="inferred-due-date-note" className="border-b border-border px-4 py-2 text-xs text-foreground-secondary">
                                    † Due date inferred from the posting date because this transaction has no stored due date.
                                </p>
                            )}
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[720px] text-sm">
                                    <thead>
                                        <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                            <th className="px-4 py-3 text-left">
                                                {side === 'ar' ? 'Customer' : 'Vendor'}
                                            </th>
                                            {BUCKET_ORDER.map((b) => (
                                                <th key={b} className="px-4 py-3 text-right">
                                                    {BUCKET_LABELS[b]}
                                                </th>
                                            ))}
                                            <th className="px-4 py-3 text-right">Total</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {report.owners.map((owner) => {
                                            const isOpen = expanded.has(owner.ownerGuid);
                                            return (
                                                <Fragment key={owner.ownerGuid}>
                                                    <tr
                                                        className="border-b border-border/30 cursor-pointer hover:bg-background-secondary/20 transition-colors"
                                                        onClick={() => toggleOwner(owner.ownerGuid)}
                                                    >
                                                        <td className="px-4 py-2.5 text-foreground">
                                                            <span className="mr-2 inline-block w-3 text-foreground-muted">
                                                                {isOpen ? '▾' : '▸'}
                                                            </span>
                                                            {owner.ownerName}
                                                            <span className="ml-2 text-xs text-foreground-muted font-mono" style={TNUM}>
                                                                {owner.invoices.length}
                                                            </span>
                                                        </td>
                                                        {BUCKET_ORDER.map((b) => (
                                                            <td key={b} className="px-4 py-2.5 text-right">
                                                                <Amount
                                                                    value={owner.buckets[b]}
                                                                    muted
                                                                    negative={b === 'b90plus' && owner.buckets[b] > 0}
                                                                />
                                                            </td>
                                                        ))}
                                                        <td className="px-4 py-2.5 text-right font-medium">
                                                            <Amount value={owner.total} />
                                                        </td>
                                                    </tr>
                                                    {isOpen &&
                                                        owner.invoices.map((invoice) => (
                                                            <tr
                                                                key={invoice.guid}
                                                                className="border-b border-border/30 bg-background-tertiary/30"
                                                            >
                                                                <td className="pl-9 pr-4 py-2 whitespace-nowrap">
                                                                    <Link
                                                                        href={`/business/invoices/${invoice.guid}`}
                                                                        className="font-mono text-primary hover:text-primary-hover transition-colors"
                                                                        style={TNUM}
                                                                    >
                                                                        {invoice.id}
                                                                    </Link>
                                                                    <span className="ml-3 font-mono text-xs text-foreground-muted" style={TNUM}>
                                                                        posted {invoice.datePosted ?? '—'} · due {invoice.dueDate ?? '—'}
                                                                        {invoice.dueDateInferred && (
                                                                            <span>
                                                                                {' '}†
                                                                                <span className="sr-only"> (due date inferred from the posting date)</span>
                                                                            </span>
                                                                        )}
                                                                        {invoice.daysPastDue > 0 && (
                                                                            <span className="text-negative">
                                                                                {' '}· {invoice.daysPastDue}d overdue
                                                                            </span>
                                                                        )}
                                                                    </span>
                                                                </td>
                                                                {BUCKET_ORDER.map((b) => (
                                                                    <td key={b} className="px-4 py-2 text-right">
                                                                        {b === invoice.bucket ? (
                                                                            <Amount value={invoice.amountDue} muted />
                                                                        ) : null}
                                                                    </td>
                                                                ))}
                                                                <td className="px-4 py-2 text-right">
                                                                    <Amount value={invoice.amountDue} muted />
                                                                </td>
                                                            </tr>
                                                        ))}
                                                </Fragment>
                                            );
                                        })}
                                    </tbody>
                                    <tfoot>
                                        <tr className="border-t border-border font-medium bg-background-secondary/20">
                                            <td className="px-4 py-3 text-foreground">
                                                Total
                                                <span className="ml-2 text-xs font-normal text-foreground-muted font-mono" style={TNUM}>
                                                    {report.invoiceCount} open
                                                </span>
                                            </td>
                                            {BUCKET_ORDER.map((b) => (
                                                <td key={b} className="px-4 py-3 text-right">
                                                    <Amount
                                                        value={report.totals[b]}
                                                        negative={b === 'b90plus' && report.totals[b] > 0}
                                                    />
                                                </td>
                                            ))}
                                            <td className="px-4 py-3 text-right">
                                                <Amount value={report.grandTotal} />
                                            </td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>
                    )}
                    <section className="border border-border rounded-lg overflow-hidden" aria-labelledby="aging-reconciliation-heading">
                        <div className="border-b border-border bg-background-secondary/30 px-4 py-3">
                            <h2 id="aging-reconciliation-heading" className="text-sm font-medium text-foreground">
                                Control-account reconciliation
                            </h2>
                            <p className="mt-1 text-xs text-foreground-secondary">
                                Compares the balance-sheet control account with the open invoice lots above.
                            </p>
                        </div>
                        {report.reconciliation.valuationGaps.length > 0 && (
                            <div className="border-b border-warning/30 bg-warning/10 px-4 py-3 text-sm text-foreground-secondary">
                                <p className="font-medium text-warning">Some control-account balances cannot be valued.</p>
                                <ul className="mt-1 list-disc pl-4 text-xs">
                                    {report.reconciliation.valuationGaps.map((gap) => (
                                        <li key={`${gap.commodityGuid}-${gap.reason}`}>{gap.message}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[620px] text-sm">
                                <thead>
                                    <tr className="border-b border-border text-xs uppercase tracking-wider text-foreground-muted">
                                        <th className="px-4 py-2.5 text-left">Control account</th>
                                        <th className="px-4 py-2.5 text-right">Balance sheet</th>
                                        <th className="px-4 py-2.5 text-right">Aged invoice lots</th>
                                        <th className="px-4 py-2.5 text-right">Unreconciled difference</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.reconciliation.controlAccounts.map((account) => (
                                        <tr key={account.guid} className="border-b border-border/30">
                                            <td className="px-4 py-2.5 text-foreground">{account.name}</td>
                                            <td className="px-4 py-2.5 text-right"><Amount value={account.controlBalance} muted /></td>
                                            <td className="px-4 py-2.5 text-right"><Amount value={account.agedTotal} muted /></td>
                                            <td className="px-4 py-2.5 text-right">
                                                <Amount value={account.unreconciledDifference} negative={account.unreconciledDifference < 0} />
                                            </td>
                                        </tr>
                                    ))}
                                    {report.reconciliation.controlAccounts.length === 0 && (
                                        <tr>
                                            <td colSpan={4} className="px-4 py-3 text-foreground-secondary">
                                                No {side === 'ar' ? 'receivable' : 'payable'} control account is in this book.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                                <tfoot>
                                    <tr className="bg-background-secondary/20 font-medium">
                                        <td className="px-4 py-3 text-foreground">Total</td>
                                        <td className="px-4 py-3 text-right"><Amount value={report.reconciliation.controlBalance} /></td>
                                        <td className="px-4 py-3 text-right"><Amount value={report.reconciliation.agedTotal} /></td>
                                        <td className="px-4 py-3 text-right">
                                            <Amount
                                                value={report.reconciliation.unreconciledDifference}
                                                negative={report.reconciliation.unreconciledDifference < 0}
                                            />
                                        </td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                        <p className="border-t border-border px-4 py-2 text-xs text-foreground-muted">
                            The difference is direct or otherwise non-invoice-lot activity. Payments matched to an invoice reduce that invoice lot and are not counted again here.
                        </p>
                    </section>
                    <p className="text-xs text-foreground-muted">
                        Amounts due come from each invoice&apos;s posting-lot balance; credit notes appear
                        as negative amounts. Esc collapses expanded rows. As of{' '}
                        {new Date(report.asOf).toLocaleString()}.
                    </p>
                </>
            )}
        </div>
    );
}

export default function AgingPage() {
    return (
        <Suspense
            fallback={
                <div className="flex items-center justify-center py-12">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                </div>
            }
        >
            <AgingPageInner />
        </Suspense>
    );
}
