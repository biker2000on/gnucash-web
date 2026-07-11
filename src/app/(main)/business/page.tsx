'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type {
    BusinessDashboard,
    AgingBucketKey,
} from '@/lib/business/business-reports';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard, StatGrid } from '@/components/ui/StatCard';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const BUCKET_ORDER: AgingBucketKey[] = ['current', 'b1_30', 'b31_60', 'b61_90', 'b90plus'];
const BUCKET_LABELS: Record<AgingBucketKey, string> = {
    current: 'Current',
    b1_30: '1–30',
    b31_60: '31–60',
    b61_90: '61–90',
    b90plus: '90+',
};
/** Solid meaning-colors per bucket: current is fine, aging deepens toward --negative. */
const BUCKET_COLORS: Record<AgingBucketKey, string> = {
    current: 'var(--positive)',
    b1_30: 'var(--warning)',
    b31_60: 'color-mix(in srgb, var(--negative) 55%, var(--warning) 45%)',
    b61_90: 'color-mix(in srgb, var(--negative) 80%, transparent)',
    b90plus: 'var(--negative)',
};

function MiniAgingBar({ title, buckets, total, href }: {
    title: string;
    buckets: Record<AgingBucketKey, number>;
    total: number;
    href: string;
}) {
    const positiveTotal = BUCKET_ORDER.reduce((s, b) => s + Math.max(0, buckets[b]), 0);
    return (
        <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
            <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{title}</h3>
                <Link href={href} className="text-xs text-primary hover:text-primary-hover transition-colors">
                    Full aging →
                </Link>
            </div>
            {positiveTotal <= 0 ? (
                <p className="mt-3 text-sm text-foreground-muted">Nothing outstanding.</p>
            ) : (
                <>
                    <div className="mt-3 flex h-2 w-full overflow-hidden rounded-sm">
                        {BUCKET_ORDER.map((b) => {
                            const amt = Math.max(0, buckets[b]);
                            if (amt <= 0) return null;
                            return (
                                <div
                                    key={b}
                                    title={`${BUCKET_LABELS[b]}: ${formatCurrency(amt)}`}
                                    style={{
                                        width: `${(amt / positiveTotal) * 100}%`,
                                        backgroundColor: BUCKET_COLORS[b],
                                    }}
                                />
                            );
                        })}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {BUCKET_ORDER.map((b) =>
                            buckets[b] !== 0 ? (
                                <span key={b} className="flex items-center gap-1.5 text-xs text-foreground-secondary">
                                    <span
                                        className="inline-block h-2 w-2 rounded-sm"
                                        style={{ backgroundColor: BUCKET_COLORS[b] }}
                                    />
                                    {BUCKET_LABELS[b]}
                                    <span className="font-mono" style={TNUM}>{formatCurrency(buckets[b])}</span>
                                </span>
                            ) : null,
                        )}
                    </div>
                    <p className="mt-2 text-xs text-foreground-muted">
                        Total <span className="font-mono" style={TNUM}>{formatCurrency(total)}</span>
                    </p>
                </>
            )}
        </div>
    );
}

export default function BusinessDashboardPage() {
    const [data, setData] = useState<BusinessDashboard | null>(null);
    const [entityType, setEntityType] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    const reload = useCallback(() => setReloadKey((k) => k + 1), []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const [dashRes, entityRes] = await Promise.all([
                    fetch('/api/business/reports/dashboard'),
                    fetch('/api/entity'),
                ]);
                if (!dashRes.ok) throw new Error(`Request failed (${dashRes.status})`);
                const dash: BusinessDashboard = await dashRes.json();
                const entity = entityRes.ok ? await entityRes.json() : null;
                if (!cancelled) {
                    setData(dash);
                    setEntityType(entity?.entityType ?? null);
                }
            } catch {
                if (!cancelled) setError('Failed to load the business dashboard.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadKey]);

    const hasBusinessData =
        !!data &&
        (data.recentInvoices.length > 0 || data.ar.count > 0 || data.ap.count > 0 || data.topCustomers.length > 0);

    const reportLink =
        'px-3 py-1.5 rounded-lg border border-border text-sm text-foreground-secondary hover:border-border-hover hover:text-foreground transition-colors';

    return (
        <div className="space-y-6">
            <PageHeader
                title="Business"
                subtitle="Revenue, receivables, payables, and invoicing activity for the active book."
                actions={
                    <>
                        <Link href="/business/reports/aging" className={reportLink}>Aging</Link>
                        <Link href="/business/reports/sales-tax" className={reportLink}>Sales Tax</Link>
                        <Link href="/business/reports/schedule-c" className={reportLink}>Schedule C</Link>
                    </>
                }
            />

            {entityType === 'household' && (
                <div className="border border-warning/30 bg-warning/5 rounded-xl px-4 py-3 text-sm text-foreground-secondary">
                    This book&apos;s entity profile is set to <span className="font-medium text-foreground">household</span>.
                    Business reports work best on a sole-proprietorship or LLC book — the entity type can be
                    changed in Settings.
                </div>
            )}

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
                    <button
                        type="button"
                        onClick={reload}
                        className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary-hover transition-colors"
                    >
                        Retry
                    </button>
                </div>
            )}

            {!loading && !error && data && (
                <>
                    <StatGrid cols={4}>
                        <StatCard
                            label="Revenue YTD"
                            value={formatCurrency(data.revenue.ytd)}
                            sub={`Mo ${formatCurrency(data.revenue.month)} · Qtr ${formatCurrency(data.revenue.quarter)}`}
                            tone={data.revenue.ytd > 0 ? 'positive' : 'default'}
                            size="compact"
                        />
                        <StatCard
                            label="Outstanding AR"
                            value={formatCurrency(data.ar.total)}
                            sub={`${data.ar.count} open invoice${data.ar.count === 1 ? '' : 's'}`}
                            size="compact"
                        />
                        <StatCard
                            label="AP due in 30 days"
                            value={formatCurrency(data.ap.dueWithin30)}
                            sub={`${formatCurrency(data.ap.dueWithin7)} within 7 days`}
                            tone={data.ap.dueWithin30 > 0 ? 'warning' : 'default'}
                            size="compact"
                        />
                        <StatCard
                            label="Avg days to pay"
                            value={data.avgDaysToPay === null ? '—' : `${data.avgDaysToPay}d`}
                            sub={
                                data.paidInvoiceCount > 0
                                    ? `${data.paidInvoiceCount} paid invoice${data.paidInvoiceCount === 1 ? '' : 's'}`
                                    : 'no paid invoices yet'
                            }
                            size="compact"
                        />
                    </StatGrid>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <MiniAgingBar
                            title="Accounts Receivable"
                            buckets={data.ar.buckets}
                            total={data.ar.total}
                            href="/business/reports/aging?side=ar"
                        />
                        <MiniAgingBar
                            title="Accounts Payable"
                            buckets={data.ap.buckets}
                            total={data.ap.total}
                            href="/business/reports/aging?side=ap"
                        />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                        {/* Top customers */}
                        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                            <div className="p-4 border-b border-border">
                                <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                                    Top Customers (YTD)
                                </h3>
                            </div>
                            {data.topCustomers.length === 0 ? (
                                <div className="p-8 text-center text-foreground-muted text-sm">
                                    No posted customer invoices this year.
                                </div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                                <th className="px-4 py-3 text-left">Customer</th>
                                                <th className="px-4 py-3 text-right">Invoices</th>
                                                <th className="px-4 py-3 text-right">Revenue</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {data.topCustomers.map((c) => (
                                                <tr key={c.guid} className="border-b border-border/30 last:border-b-0 hover:bg-background-secondary/20 transition-colors">
                                                    <td className="px-4 py-2.5 text-foreground">{c.name}</td>
                                                    <td className="px-4 py-2.5 text-right font-mono text-foreground-secondary" style={TNUM}>
                                                        {c.invoiceCount}
                                                    </td>
                                                    <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                        {formatCurrency(c.revenue)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        {/* Recent invoices */}
                        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                            <div className="p-4 border-b border-border">
                                <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                                    Recent Invoices &amp; Bills
                                </h3>
                            </div>
                            {data.recentInvoices.length === 0 ? (
                                <div className="p-8 text-center text-foreground-muted text-sm">
                                    No posted invoices or bills yet.
                                </div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                                <th className="px-4 py-3 text-left">No.</th>
                                                <th className="px-4 py-3 text-left">Party</th>
                                                <th className="px-4 py-3 text-left">Posted</th>
                                                <th className="px-4 py-3 text-right">Total</th>
                                                <th className="px-4 py-3 text-right">Due</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {data.recentInvoices.map((r) => (
                                                <tr key={r.guid} className="border-b border-border/30 last:border-b-0 hover:bg-background-secondary/20 transition-colors">
                                                    <td className="px-4 py-2.5 whitespace-nowrap">
                                                        <Link
                                                            href={`/business/invoices/${r.guid}`}
                                                            className="font-mono text-primary hover:text-primary-hover transition-colors"
                                                            style={TNUM}
                                                        >
                                                            {r.id}
                                                        </Link>
                                                        {r.type === 'bill' && (
                                                            <span className="ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-secondary-light text-secondary uppercase">
                                                                Bill
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-2.5 text-foreground">{r.ownerName}</td>
                                                    <td className="px-4 py-2.5 font-mono text-foreground-secondary" style={TNUM}>
                                                        {r.datePosted ?? '—'}
                                                    </td>
                                                    <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                        {formatCurrency(r.total, r.currency)}
                                                    </td>
                                                    <td
                                                        className={`px-4 py-2.5 text-right font-mono ${Math.abs(r.amountDue) > 0.004 ? 'text-warning' : 'text-foreground-muted'}`}
                                                        style={TNUM}
                                                    >
                                                        {formatCurrency(r.amountDue, r.currency)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </div>

                    {!hasBusinessData && (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No business activity yet. Once customers, vendors, and posted invoices exist
                                in this book, revenue, aging, and payment metrics will appear here.
                            </p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
