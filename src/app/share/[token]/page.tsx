import type { Metadata } from 'next';
import {
    resolveShareToken,
    recordShareView,
    shareBookInfo,
    shareSectionLabel,
    type ShareSection,
} from '@/lib/share-links';
import { generateScheduledReport, type GeneratedScheduledReport } from '@/lib/report-scheduler';
import type { LineItem, ReportData, ChartReportData, ReportFilters } from '@/lib/reports/types';

/**
 * Public accountant share page: /share/<secret>
 *
 * Server component OUTSIDE the (main) route group — no sidebar, no session.
 * Resolves the token and renders the selected report sections server-side by
 * calling the existing report libs (via generateScheduledReport). Invalid,
 * expired, and revoked tokens all get the same neutral "link expired" page.
 *
 * NOTE: requires a middleware matcher exclusion for /share (see middleware.ts
 * config) — this page performs its own token-based authorization.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Shared Report — GnuCash Web',
    robots: { index: false, follow: false },
};

const AMOUNT_FMT = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

function fmtAmount(n: number): string {
    const rounded = Math.round(n * 100) / 100;
    return AMOUNT_FMT.format(rounded === 0 ? 0 : rounded);
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

// ---------------------------------------------------------------------------
// Section → report-lib mapping (reuses the scheduler's exported generator map)
// ---------------------------------------------------------------------------

async function generateShareSection(
    section: ShareSection,
    bookAccountGuids: string[],
    today: string,
): Promise<GeneratedScheduledReport> {
    const base: ReportFilters = { startDate: null, endDate: today, bookAccountGuids };
    switch (section) {
        case 'balance_sheet':
            return generateScheduledReport('balance_sheet', {}, base);
        case 'income_statement_ytd':
            return generateScheduledReport('income_statement', {}, {
                ...base,
                startDate: `${today.slice(0, 4)}-01-01`,
            });
        case 'net_worth':
            // Renders as a 12-month-end table via the scheduler's chart mapping.
            return generateScheduledReport('net_worth_chart', {}, base);
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function flattenItems(items: LineItem[], depth = 0): Array<{ name: string; amount: number; depth: number }> {
    const out: Array<{ name: string; amount: number; depth: number }> = [];
    for (const item of items) {
        out.push({ name: item.name, amount: item.amount, depth: item.depth ?? depth });
        if (item.children && item.children.length > 0) {
            out.push(...flattenItems(item.children, (item.depth ?? depth) + 1));
        }
    }
    return out;
}

function SectionsTable({ data }: { data: ReportData }) {
    return (
        <table className="w-full border-collapse text-sm">
            <tbody>
                {data.sections.map(section => (
                    <FragmentRows key={section.title} title={section.title} items={section.items} total={section.total} />
                ))}
                {data.grandTotal !== undefined && (
                    <tr>
                        <td className="py-2 pr-3 text-sm font-bold text-foreground">Net</td>
                        <td className="py-2 text-right font-mono text-sm font-bold text-foreground" style={TNUM}>
                            {fmtAmount(data.grandTotal)}
                        </td>
                    </tr>
                )}
            </tbody>
        </table>
    );
}

function FragmentRows({ title, items, total }: { title: string; items: LineItem[]; total: number }) {
    return (
        <>
            <tr>
                <td colSpan={2} className="pt-4 pb-1 text-xs font-medium uppercase tracking-wider text-foreground-muted">
                    {title}
                </td>
            </tr>
            {flattenItems(items).map((item, i) => (
                <tr key={`${item.name}-${i}`} className="border-b border-border last:border-0">
                    <td
                        className="py-1.5 pr-3 text-foreground-secondary"
                        style={{ paddingLeft: `${item.depth * 16}px` }}
                    >
                        {item.name}
                    </td>
                    <td className="py-1.5 text-right font-mono text-foreground" style={TNUM}>
                        {fmtAmount(item.amount)}
                    </td>
                </tr>
            ))}
            <tr>
                <td className="py-1.5 pr-3 font-semibold text-foreground">Total {title}</td>
                <td className="border-t border-border py-1.5 text-right font-mono font-semibold text-foreground" style={TNUM}>
                    {fmtAmount(total)}
                </td>
            </tr>
        </>
    );
}

function seriesLabel(key: string): string {
    return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

function ChartTable({ data }: { data: ChartReportData }) {
    return (
        <table className="w-full border-collapse text-sm">
            <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-foreground-muted">
                    <th className="py-2 pr-3 font-medium">Date</th>
                    {data.series.map(s => (
                        <th key={s} className="py-2 text-right font-medium">{seriesLabel(s)}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {data.dataPoints.map(point => (
                    <tr key={String(point.date)} className="border-b border-border last:border-0">
                        <td className="py-1.5 pr-3 font-mono text-foreground-secondary" style={TNUM}>
                            {String(point.date)}
                        </td>
                        {data.series.map(s => (
                            <td key={s} className="py-1.5 text-right font-mono text-foreground" style={TNUM}>
                                {typeof point[s] === 'number' ? fmtAmount(point[s] as number) : String(point[s] ?? '')}
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ExpiredPage() {
    return (
        <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center p-8 text-center">
            <h1 className="text-xl font-semibold text-foreground">This link is no longer available</h1>
            <p className="mt-2 text-sm text-foreground-muted">
                The share link you followed is invalid, has expired, or was revoked.
                Please ask the person who shared it for a new link.
            </p>
        </main>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;

    const link = await resolveShareToken(token);
    if (!link) return <ExpiredPage />;

    const book = await shareBookInfo(link.bookGuid);
    if (!book) return <ExpiredPage />;

    await recordShareView(link.id);

    const today = isoDate(new Date());
    const sections: Array<{ key: ShareSection; generated: GeneratedScheduledReport | null }> = [];
    for (const key of link.sections) {
        try {
            sections.push({ key, generated: await generateShareSection(key, book.accountGuids, today) });
        } catch (err) {
            console.error(`Share link ${link.id}: failed to render section ${key}:`, err);
            sections.push({ key, generated: null });
        }
    }

    return (
        <main className="mx-auto max-w-3xl p-6 sm:p-10 print:p-0">
            <header className="border-b border-border pb-4">
                <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted">
                    GnuCash Web · shared read-only report
                </p>
                <h1 className="mt-1 text-2xl font-bold text-foreground">{book.name}</h1>
                <p className="mt-1 text-sm text-foreground-secondary">{link.label}</p>
                <p className="mt-2 font-mono text-xs text-foreground-muted" style={TNUM}>
                    As of {today} · link expires {isoDate(link.expiresAt)}
                </p>
            </header>

            {sections.map(({ key, generated }) => (
                <section key={key} className="mt-8 break-inside-avoid">
                    <h2 className="text-base font-semibold text-foreground">{shareSectionLabel(key)}</h2>
                    <div className="mt-2 rounded-lg border border-border bg-surface p-4 print:border-0 print:p-0">
                        {generated === null && (
                            <p className="text-sm text-foreground-muted">This section could not be generated.</p>
                        )}
                        {generated?.kind === 'sections' && <SectionsTable data={generated.data} />}
                        {generated?.kind === 'chart' && <ChartTable data={generated.data} />}
                        {generated?.kind === 'trial_balance' && (
                            <p className="text-sm text-foreground-muted">Unsupported section format.</p>
                        )}
                    </div>
                </section>
            ))}

            <footer className="mt-10 border-t border-border pt-4 text-xs text-foreground-muted">
                This is a read-only snapshot generated on {today}. It grants no access to the underlying
                books. If you were not expecting this document, you can ignore it.
            </footer>
        </main>
    );
}
