import type { Metadata } from 'next';
import {
    getPortalView,
    recordPortalView,
    resolvePortalToken,
    type PortalView,
} from '@/lib/business/vendor-portal.service';
import { product } from '@/lib/product';

/**
 * Contractor portal: /share/vendor/<token>
 *
 * Server component outside the (main) route group — no sidebar, no session
 * (the middleware matcher excludes /share). The token resolves to ONE vendor
 * in ONE book; every failure renders the same neutral "unavailable" page.
 * Shows payer-side facts only: what was paid, when, how (Bank/Card/Cash —
 * never which account), against which of the contractor's invoices, open
 * bills, and 1099 totals.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: `Payment history — ${product.brand}`,
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
};

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

function money(n: number, currency: string): string {
    try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
    } catch {
        return `${n.toFixed(2)} ${currency}`;
    }
}

function UnavailablePage() {
    return (
        <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center p-8 text-center">
            <h1 className="text-xl font-semibold text-foreground">This page is no longer available</h1>
            <p className="mt-2 text-sm text-foreground-muted">
                The link you followed is invalid, has expired, or was revoked.
                Please contact the sender for a new link.
            </p>
        </main>
    );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'positive' | 'warning' | 'neutral' | 'error' }) {
    const cls =
        tone === 'positive' ? 'border-positive/30 bg-positive/10 text-positive'
        : tone === 'warning' ? 'border-warning/30 bg-warning/10 text-warning'
        : tone === 'error' ? 'border-error/30 bg-error/10 text-error'
        : 'border-border bg-surface-hover text-foreground-secondary';
    return <span className={`rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

function W9Notice({ view }: { view: PortalView }) {
    if (view.w9 === 'received' || view.w9 === 'not_needed') return null;
    return (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-foreground">
            <p className="font-medium">{view.payerName} needs a Form W-9 from you.</p>
            <p className="mt-1 text-foreground-secondary">
                Payments to you may be reportable on Form 1099-NEC, which requires your taxpayer identification number.
                {view.w9 === 'requested' ? ' A W-9 has been requested.' : ''} Send a completed W-9 directly to{' '}
                {view.payerName} (never through an unencrypted email).
            </p>
        </div>
    );
}

export default async function VendorPortalPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const resolved = await resolvePortalToken(token);
    if (!resolved) return <UnavailablePage />;
    const [view] = await Promise.all([getPortalView(resolved), recordPortalView(resolved)]);
    const c = view.currency;
    const paidThisYear = view.payments
        .filter((p) => p.date?.startsWith(String(new Date().getFullYear())))
        .reduce((s, p) => s + p.amount, 0);
    const outstanding = view.openBills.reduce((s, b) => s + b.amountDue, 0);

    return (
        <main className="mx-auto max-w-4xl space-y-6 p-6 sm:p-10">
            <header className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-widest text-foreground-muted">
                    Payment history · read-only
                </p>
                <h1 className="text-2xl font-bold text-foreground">
                    {view.payerName} → {view.vendorName}
                </h1>
                <p className="text-sm text-foreground-muted">
                    Payments {view.payerName} has made to you, and invoices still open. This link expires{' '}
                    {view.expiresAt.slice(0, 10)}.
                </p>
            </header>

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-surface p-4">
                    <div className="text-xs uppercase tracking-wider text-foreground-muted">Paid this year</div>
                    <div className="mt-1 font-mono text-xl text-foreground" style={TNUM}>{money(paidThisYear, c)}</div>
                </div>
                <div className="rounded-lg border border-border bg-surface p-4">
                    <div className="text-xs uppercase tracking-wider text-foreground-muted">Open invoices</div>
                    <div className="mt-1 font-mono text-xl text-foreground" style={TNUM}>{money(outstanding, c)}</div>
                </div>
                <div className="rounded-lg border border-border bg-surface p-4">
                    <div className="text-xs uppercase tracking-wider text-foreground-muted">1099-NEC {view.tax1099[0]?.year ?? new Date().getFullYear()}</div>
                    <div className="mt-1 font-mono text-xl text-foreground" style={TNUM}>
                        {money(view.tax1099.find((t) => t.year === new Date().getFullYear())?.totalPaid ?? 0, c)}
                    </div>
                </div>
            </section>

            <W9Notice view={view} />

            <section className="space-y-2">
                <h2 className="text-lg font-semibold text-foreground">Payments</h2>
                {view.payments.length === 0 ? (
                    <p className="text-sm text-foreground-muted">No payments recorded yet.</p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="bg-background-tertiary text-xs uppercase tracking-wider text-foreground-secondary">
                                <tr>
                                    <th className="px-3 py-2 text-left">Date</th>
                                    <th className="px-3 py-2 text-right">Amount</th>
                                    <th className="px-3 py-2 text-left">Method</th>
                                    <th className="px-3 py-2 text-left">Reference</th>
                                    <th className="px-3 py-2 text-left">Your invoices</th>
                                    <th className="px-3 py-2 text-left">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {view.payments.map((p) => (
                                    <tr key={p.transactionGuid}>
                                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs" style={TNUM}>{p.date ?? '—'}</td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono" style={TNUM}>{money(p.amount, c)}</td>
                                        <td className="px-3 py-2 text-foreground-secondary">{p.method}</td>
                                        <td className="px-3 py-2 font-mono text-xs">{p.reference ?? '—'}</td>
                                        <td className="px-3 py-2 text-xs">
                                            {p.bills.map((b) => (
                                                <div key={`${b.billId}-${b.amount}`}>
                                                    {b.yourInvoiceNumber ? `#${b.yourInvoiceNumber}` : `Bill ${b.billId}`}
                                                    {b.job ? ` · ${b.job}` : ''}
                                                    <span className="font-mono text-foreground-muted" style={TNUM}> {money(b.amount, c)}</span>
                                                </div>
                                            ))}
                                            {p.documents.map((d) => (
                                                <a
                                                    key={d.id}
                                                    className="block text-primary hover:underline"
                                                    href={`/api/public/vendor-portal/${token}/documents/${d.id}`}
                                                    rel="noreferrer"
                                                >
                                                    {d.name}
                                                </a>
                                            ))}
                                        </td>
                                        <td className="px-3 py-2">
                                            <Badge tone={p.status === 'Cleared' ? 'positive' : 'neutral'}>{p.status}</Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <section className="space-y-2">
                <h2 className="text-lg font-semibold text-foreground">Open invoices</h2>
                {view.openBills.length === 0 ? (
                    <p className="text-sm text-foreground-muted">Nothing outstanding.</p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="bg-background-tertiary text-xs uppercase tracking-wider text-foreground-secondary">
                                <tr>
                                    <th className="px-3 py-2 text-left">Your invoice</th>
                                    <th className="px-3 py-2 text-left">Received</th>
                                    <th className="px-3 py-2 text-left">Due</th>
                                    <th className="px-3 py-2 text-right">Total</th>
                                    <th className="px-3 py-2 text-right">Still due</th>
                                    <th className="px-3 py-2 text-left">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {view.openBills.map((b) => (
                                    <tr key={b.billId}>
                                        <td className="px-3 py-2">
                                            {b.yourInvoiceNumber ? `#${b.yourInvoiceNumber}` : `Bill ${b.billId}`}
                                            {b.job && <span className="text-xs text-foreground-muted"> · {b.job}</span>}
                                        </td>
                                        <td className="px-3 py-2 font-mono text-xs" style={TNUM}>{b.datePosted ?? '—'}</td>
                                        <td className="px-3 py-2 font-mono text-xs" style={TNUM}>{b.dueDate ?? '—'}</td>
                                        <td className="px-3 py-2 text-right font-mono" style={TNUM}>{money(b.total, c)}</td>
                                        <td className="px-3 py-2 text-right font-mono" style={TNUM}>{money(b.amountDue, c)}</td>
                                        <td className="px-3 py-2">
                                            <Badge tone={b.status === 'Overdue' ? 'error' : b.status === 'Partially paid' ? 'warning' : 'neutral'}>
                                                {b.status}
                                            </Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            {view.tax1099.length > 0 && (
                <section className="space-y-2">
                    <h2 className="text-lg font-semibold text-foreground">1099-NEC totals</h2>
                    <ul className="space-y-1 text-sm">
                        {view.tax1099.map((t) => (
                            <li key={t.year} className="flex justify-between rounded-md border border-border px-3 py-2">
                                <span>
                                    {t.year}
                                    {!t.reportable && <span className="text-xs text-foreground-muted"> · not reportable</span>}
                                </span>
                                <span className="font-mono" style={TNUM}>{money(t.totalPaid, c)}</span>
                            </li>
                        ))}
                    </ul>
                    <p className="text-xs text-foreground-muted">
                        Cash paid against your bills during the year, as {view.payerName} will report it. Card payments are
                        reported by the card processor on Form 1099-K instead.
                    </p>
                </section>
            )}

            <footer className="border-t border-border pt-4 text-xs text-foreground-muted">
                Shared by {view.payerName} with {product.brand}. This page shows only payments to you and grants no access
                to {view.payerName}&apos;s books.
            </footer>
        </main>
    );
}
