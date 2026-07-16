import type { Metadata } from 'next';
import {
    resolveShareToken,
    type PublicInvoiceView,
    type PublicEstimateView,
    type PublicLineView,
} from '@/lib/business/invoice-shares.service';
import { PrintButton } from './PrintButton';

/**
 * Public customer-facing invoice/estimate page: /share/invoice/<token>
 *
 * Server component OUTSIDE the (main) route group — no sidebar, no session.
 * The token is resolved server-side (invoice-shares.service); invalid,
 * revoked, and expired tokens all get the same neutral "unavailable" page.
 * Print-optimized: "Download PDF" is window.print() with print CSS (the
 * ReportViewer approach — no PDF dependencies).
 *
 * NOTE: relies on the middleware matcher exclusion for /share (middleware.ts).
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Invoice — GnuCash Web',
    robots: { index: false, follow: false },
};

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

function fmtAmount(n: number, currency: string): string {
    try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
    } catch {
        return `${n.toFixed(2)} ${currency}`;
    }
}

function fmtQty(n: number): string {
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000);
}

function UnavailablePage() {
    return (
        <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center p-8 text-center">
            <h1 className="text-xl font-semibold text-foreground">This document is no longer available</h1>
            <p className="mt-2 text-sm text-foreground-muted">
                The link you followed is invalid, has expired, or was revoked.
                Please contact the sender for a new link.
            </p>
        </main>
    );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function StatusBadge({ label, tone }: { label: string; tone: 'positive' | 'negative' | 'neutral' | 'info' }) {
    const cls =
        tone === 'positive' ? 'bg-positive/10 text-positive border-positive/30'
        : tone === 'negative' ? 'bg-negative/10 text-negative border-negative/30'
        : tone === 'info' ? 'bg-secondary-light text-secondary border-secondary/30'
        : 'bg-surface-hover text-foreground-secondary border-border';
    return (
        <span className={`inline-block rounded-md border px-2.5 py-1 text-xs font-semibold uppercase tracking-widest ${cls}`}>
            {label}
        </span>
    );
}

function LinesTable({ lines, currency }: { lines: PublicLineView[]; currency: string }) {
    const showDiscount = lines.some((l) => l.discount !== 0);
    const showTax = lines.some((l) => l.tax !== 0);
    return (
        <table className="w-full border-collapse text-sm">
            <thead>
                <tr className="border-b-2 border-border text-left text-xs uppercase tracking-widest text-foreground-muted">
                    <th className="py-2 pr-3 font-semibold">Description</th>
                    <th className="py-2 pr-3 text-right font-semibold">Qty</th>
                    <th className="py-2 pr-3 text-right font-semibold">Unit price</th>
                    {showDiscount && <th className="py-2 pr-3 text-right font-semibold">Discount</th>}
                    {showTax && <th className="py-2 pr-3 text-right font-semibold">Tax</th>}
                    <th className="py-2 text-right font-semibold">Amount</th>
                </tr>
            </thead>
            <tbody>
                {lines.map((l, i) => (
                    <tr key={i} className="border-b border-border last:border-b-2 last:border-border">
                        <td className="py-2 pr-3 text-foreground">{l.description || '—'}</td>
                        <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>{fmtQty(l.quantity)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>{fmtAmount(l.price, currency)}</td>
                        {showDiscount && (
                            <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>
                                {l.discount !== 0 ? `−${fmtAmount(l.discount, currency)}` : ''}
                            </td>
                        )}
                        {showTax && (
                            <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>
                                {l.tax !== 0 ? fmtAmount(l.tax, currency) : ''}
                            </td>
                        )}
                        <td className="py-2 text-right font-mono text-foreground" style={TNUM}>{fmtAmount(l.amount, currency)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function BillToBlock({ billTo }: { billTo: { name: string; lines: string[]; email: string | null } | null }) {
    if (!billTo) return null;
    return (
        <div>
            <div className="text-xs font-medium uppercase tracking-widest text-foreground-muted">Bill to</div>
            <div className="mt-1 text-sm font-semibold text-foreground">{billTo.name}</div>
            {billTo.lines.map((line, i) => (
                <div key={i} className="text-sm text-foreground-secondary">{line}</div>
            ))}
            {billTo.email && <div className="text-sm text-foreground-secondary">{billTo.email}</div>}
        </div>
    );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
    return (
        <div className={`flex justify-between py-1 ${strong ? 'border-t border-border pt-2 text-base font-bold text-foreground' : 'text-sm text-foreground-secondary'}`}>
            <span>{label}</span>
            <span className="font-mono" style={TNUM}>{value}</span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Invoice / estimate documents
// ---------------------------------------------------------------------------

function InvoiceDocument({ inv }: { inv: PublicInvoiceView }) {
    const paid = inv.status === 'paid';
    const badge = paid
        ? { label: 'Paid', tone: 'positive' as const }
        : inv.status === 'overdue'
            ? { label: 'Overdue', tone: 'negative' as const }
            : inv.status === 'draft'
                ? { label: 'Draft', tone: 'neutral' as const }
                : { label: 'Due', tone: 'info' as const };

    return (
        <article>
            <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
                <div>
                    {inv.companyName && (
                        <div className="text-lg font-bold text-foreground">{inv.companyName}</div>
                    )}
                    <h1 className="mt-1 text-2xl font-bold tracking-widest text-foreground">INVOICE</h1>
                    <div className="mt-2"><StatusBadge label={badge.label} tone={badge.tone} /></div>
                </div>
                <div className="text-right text-sm text-foreground-secondary">
                    <div className="font-mono text-base font-bold text-foreground" style={TNUM}># {inv.id}</div>
                    {inv.dateOpened && <div className="mt-1 font-mono" style={TNUM}>Issued: {inv.dateOpened}</div>}
                    {inv.datePosted && <div className="font-mono" style={TNUM}>Posted: {inv.datePosted}</div>}
                    {inv.dueDate && (
                        <div className={`font-mono ${inv.status === 'overdue' ? 'font-semibold text-negative' : ''}`} style={TNUM}>
                            Due: {inv.dueDate}
                        </div>
                    )}
                    {inv.billingId && <div>Ref: {inv.billingId}</div>}
                </div>
            </header>

            <div className="mt-6">
                <BillToBlock billTo={inv.billTo} />
            </div>

            <div className="mt-6">
                <LinesTable lines={inv.lines} currency={inv.currency} />
            </div>

            <div className="mt-4 ml-auto w-full max-w-xs">
                <TotalRow label="Subtotal" value={fmtAmount(inv.subtotal, inv.currency)} />
                {inv.discountTotal !== 0 && (
                    <TotalRow label="Discount" value={`−${fmtAmount(inv.discountTotal, inv.currency)}`} />
                )}
                {inv.taxTotal !== 0 && <TotalRow label="Tax" value={fmtAmount(inv.taxTotal, inv.currency)} />}
                <TotalRow label="Total" value={fmtAmount(inv.total, inv.currency)} strong />
                {inv.amountPaid > 0 && (
                    <TotalRow label="Paid" value={`−${fmtAmount(inv.amountPaid, inv.currency)}`} />
                )}
                <TotalRow
                    label={paid ? 'Balance' : 'Amount due'}
                    value={fmtAmount(inv.amountDue, inv.currency)}
                    strong
                />
            </div>

            {inv.notes && (
                <div className="mt-8 whitespace-pre-wrap border-t border-border pt-4 text-sm text-foreground-secondary">
                    {inv.notes}
                </div>
            )}
        </article>
    );
}

function EstimateDocument({ est }: { est: PublicEstimateView }) {
    const badge =
        est.status === 'accepted' ? { label: 'Accepted', tone: 'positive' as const }
        : est.status === 'declined' ? { label: 'Declined', tone: 'negative' as const }
        : est.status === 'converted' ? { label: 'Invoiced', tone: 'info' as const }
        : { label: 'Estimate', tone: 'neutral' as const };

    return (
        <article>
            <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
                <div>
                    {est.companyName && (
                        <div className="text-lg font-bold text-foreground">{est.companyName}</div>
                    )}
                    <h1 className="mt-1 text-2xl font-bold tracking-widest text-foreground">ESTIMATE</h1>
                    <div className="mt-2"><StatusBadge label={badge.label} tone={badge.tone} /></div>
                </div>
                <div className="text-right text-sm text-foreground-secondary">
                    <div className="font-mono text-base font-bold text-foreground" style={TNUM}># {est.estimateNo}</div>
                    {est.dateCreated && <div className="mt-1 font-mono" style={TNUM}>Date: {est.dateCreated}</div>}
                    {est.expires && <div className="font-mono" style={TNUM}>Valid until: {est.expires}</div>}
                </div>
            </header>

            <div className="mt-6">
                <BillToBlock billTo={est.billTo} />
            </div>

            <div className="mt-6">
                <LinesTable lines={est.lines} currency={est.currency} />
            </div>

            <div className="mt-4 ml-auto w-full max-w-xs">
                <TotalRow label="Estimated total" value={fmtAmount(est.total, est.currency)} strong />
            </div>

            {est.terms && (
                <div className="mt-8 border-t border-border pt-4 text-sm text-foreground-secondary">
                    <div className="text-xs font-medium uppercase tracking-widest text-foreground-muted">Terms</div>
                    <div className="mt-1 whitespace-pre-wrap">{est.terms}</div>
                </div>
            )}
            {est.notes && (
                <div className="mt-4 whitespace-pre-wrap text-sm text-foreground-secondary">{est.notes}</div>
            )}
        </article>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PublicInvoicePage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const view = await resolveShareToken(token);
    if (!view) return <UnavailablePage />;

    const docLabel = view.type === 'invoice' ? 'invoice' : 'estimate';

    return (
        <main className="mx-auto max-w-3xl p-6 sm:p-10 print:max-w-none print:p-0">
            {/* Print: white page, black-on-white document, no chrome —
                force light-theme tokens even when the viewer uses dark mode. */}
            <style>{`
                @media print {
                    @page { margin: 1.5cm; }
                    html, html.dark {
                        --background: #ffffff;
                        --surface: #ffffff;
                        --surface-hover: #ffffff;
                        --border: #d4d4d8;
                        --foreground: #111111;
                        --foreground-secondary: #333333;
                        --foreground-muted: #555555;
                        --positive: #166534;
                        --negative: #b91c1c;
                        --secondary: #1d4ed8;
                        --secondary-light: #eff6ff;
                    }
                    html, body { background: #fff !important; }
                }
            `}</style>

            <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
                <p className="text-xs font-medium uppercase tracking-widest text-foreground-muted">
                    Shared {docLabel} · read-only
                </p>
                <PrintButton />
            </div>

            <div className="rounded-lg border border-border bg-surface p-6 sm:p-10 print:rounded-none print:border-0 print:bg-white print:p-0 print:text-black">
                {view.type === 'invoice'
                    ? <InvoiceDocument inv={view} />
                    : <EstimateDocument est={view} />}
            </div>

            <footer className="mt-6 text-xs text-foreground-muted print:hidden">
                This is a read-only snapshot. It grants no access to the underlying books.
                If you were not expecting this document, you can ignore it.
            </footer>
        </main>
    );
}
