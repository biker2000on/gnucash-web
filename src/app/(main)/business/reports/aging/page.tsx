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
                subtitle={`Open ${side === 'ar' ? 'customer invoices' : 'vendor bills'} bucketed by days past due (due date from billing terms, else the post date).`}
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
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && report && (
                <>
                    {report.owners.length === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No open {side === 'ar' ? 'customer invoices' : 'vendor bills'} — everything
                                is paid up (or nothing has been posted yet).
                            </p>
                        </div>
                    ) : (
                        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
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
