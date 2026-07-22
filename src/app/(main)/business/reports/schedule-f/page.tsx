'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import Link from 'next/link';
import type { ScheduleFReport } from '@/lib/business/schedule-f';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { useToast } from '@/contexts/ToastContext';
import ScheduleFMappingPanel, {
    type ScheduleFMappingAccount,
    type ScheduleFLineOption,
} from './ScheduleFMappingPanel';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface ScheduleFMappingsPayload {
    mappings: Record<string, string>;
    accounts: ScheduleFMappingAccount[];
    lineOptions: ScheduleFLineOption[];
}

interface ScheduleFResponse extends ScheduleFReport {
    scopedToFarmSelection: boolean;
    businessActivity: string;
}

interface NeedsFarmAccountsResponse {
    needsFarmAccounts: true;
    entityType: string;
}

export default function ScheduleFPage() {
    const currentYear = new Date().getUTCFullYear();
    const minYear = currentYear - 5;
    const years = Array.from({ length: 6 }, (_, i) => currentYear - i);

    const toast = useToast();
    const [year, setYear] = useState(currentYear);
    const [report, setReport] = useState<ScheduleFResponse | null>(null);
    const [needsFarmAccounts, setNeedsFarmAccounts] = useState(false);
    const [mappingsData, setMappingsData] = useState<ScheduleFMappingsPayload | null>(null);
    const [savingMappings, setSavingMappings] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    useKeyboardShortcut('schedule-f-prev-year', '[', 'Previous tax year', () =>
        setYear((y) => Math.max(minYear, y - 1)),
        'page',
    );
    useKeyboardShortcut('schedule-f-next-year', ']', 'Next tax year', () =>
        setYear((y) => Math.min(currentYear, y + 1)),
        'page',
    );

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
                const [res, mapsRes] = await Promise.all([
                    fetch(`/api/business/reports/schedule-f?year=${year}`),
                    fetch('/api/business/schedule-f/mappings'),
                ]);
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: ScheduleFResponse | NeedsFarmAccountsResponse = await res.json();
                const maps = mapsRes.ok ? await mapsRes.json() : null;
                if (!cancelled) {
                    if ('needsFarmAccounts' in json && json.needsFarmAccounts) {
                        setNeedsFarmAccounts(true);
                        setReport(null);
                    } else {
                        setNeedsFarmAccounts(false);
                        setReport(json as ScheduleFResponse);
                    }
                    setMappingsData(maps);
                    setExpanded(new Set());
                }
            } catch {
                if (!cancelled) setError('Failed to load the Schedule F report.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [year]);

    const handleSaveMappings = useCallback(
        async (changes: Array<{ accountGuid: string; line: string | null }>) => {
            setSavingMappings(true);
            try {
                const res = await fetch('/api/business/schedule-f/mappings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ changes }),
                });
                if (!res.ok) throw new Error('Save failed');
                const [repRes, mapsRes] = await Promise.all([
                    fetch(`/api/business/reports/schedule-f?year=${year}`),
                    fetch('/api/business/schedule-f/mappings'),
                ]);
                if (repRes.ok) {
                    const json = await repRes.json();
                    if (!('needsFarmAccounts' in json)) setReport(json);
                }
                if (mapsRes.ok) setMappingsData(await mapsRes.json());
                toast.success('Schedule F mapping saved');
            } catch {
                toast.error('Failed to save Schedule F mapping');
            } finally {
                setSavingMappings(false);
            }
        },
        [year, toast],
    );

    const toggleLine = (line: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(line)) next.delete(line);
            else next.add(line);
            return next;
        });
    };

    const otherLine = report?.expenseLines.find((l) => l.line === '32');

    const detailRows = (accounts: Array<{ guid: string; path: string; amount: number }>) =>
        accounts.map((a) => (
            <tr key={a.guid} className="border-b border-border/30 bg-background-tertiary/30">
                <td className="px-4 py-2" />
                <td className="pl-9 pr-4 py-2 text-foreground-secondary">{a.path}</td>
                <td className="px-4 py-2 text-right font-mono text-foreground-secondary" style={TNUM}>
                    {formatCurrency(a.amount)}
                </td>
            </tr>
        ));

    const lineRows = (lines: ScheduleFReport['incomeLines']) =>
        lines.map((line) => {
            const hasDetail = line.accounts.length > 0;
            const isOpen = expanded.has(line.line);
            return (
                <Fragment key={line.line}>
                    <tr
                        className={`border-b border-border/30 ${
                            hasDetail
                                ? 'cursor-pointer hover:bg-background-secondary/20 transition-colors'
                                : ''
                        }`}
                        onClick={() => hasDetail && toggleLine(line.line)}
                    >
                        <td className="px-4 py-2.5 font-mono text-foreground-secondary" style={TNUM}>
                            {line.line}
                        </td>
                        <td className="px-4 py-2.5 text-foreground">
                            {hasDetail && (
                                <span className="mr-2 inline-block w-3 text-foreground-muted">
                                    {isOpen ? '▾' : '▸'}
                                </span>
                            )}
                            {line.label}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                            <span
                                className={`font-mono ${
                                    Math.abs(line.amount) < 0.005
                                        ? 'text-foreground-muted'
                                        : 'text-foreground'
                                }`}
                                style={TNUM}
                            >
                                {formatCurrency(line.amount)}
                            </span>
                        </td>
                    </tr>
                    {isOpen && detailRows(line.accounts)}
                </Fragment>
            );
        });

    return (
        <div className="space-y-6">
            <PageHeader
                title="Schedule F Estimate"
                subtitle="Farm income and expenses for a tax year mapped onto Schedule F lines by account-name keywords. Built for apiaries and small farms."
                actions={
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        Tax year
                        <select
                            value={year}
                            onChange={(e) => setYear(parseInt(e.target.value, 10))}
                            className="rounded-lg border border-border bg-input-bg px-2 py-1.5 text-sm text-foreground focus:border-primary/50 focus:outline-none"
                        >
                            {years.map((y) => (
                                <option key={y} value={y}>
                                    {y}
                                </option>
                            ))}
                        </select>
                    </label>
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

            {!loading && needsFarmAccounts && (
                <div className="border border-warning/30 bg-warning/5 rounded-xl px-4 py-4 text-sm text-foreground-secondary space-y-2">
                    <p>
                        This book isn&apos;t a farm business book, and no farm accounts are selected
                        yet. Pick the income and expense subtrees that represent your farm in the{' '}
                        <Link
                            href="/tools/farm-analyzer"
                            className="text-primary hover:text-primary-hover underline underline-offset-2"
                        >
                            Farm &amp; Apiary Analyzer
                        </Link>{' '}
                        — this report will then scope itself to that selection.
                    </p>
                </div>
            )}

            {!loading && error && (
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && report && (
                <>
                    {report.scopedToFarmSelection && (
                        <div className="border border-border bg-surface/30 rounded-xl px-4 py-3 text-sm text-foreground-secondary">
                            Scoped to the farm accounts selected in the{' '}
                            <Link
                                href="/tools/farm-analyzer"
                                className="text-primary hover:text-primary-hover underline underline-offset-2"
                            >
                                Farm &amp; Apiary Analyzer
                            </Link>{' '}
                            (the rest of this book is ignored).
                        </div>
                    )}

                    <StatGrid cols={3}>
                        <StatCard
                            label="Gross Farm Income (Line 9)"
                            value={formatCurrency(report.grossIncome)}
                            size="compact"
                        />
                        <StatCard
                            label="Total Expenses (Line 33)"
                            value={formatCurrency(report.totalExpenses)}
                            size="compact"
                        />
                        <StatCard
                            label="Net Farm Profit (Line 34)"
                            value={formatCurrency(report.netProfit)}
                            tone={report.netProfit > 0 ? 'positive' : report.netProfit < 0 ? 'negative' : 'default'}
                            size="compact"
                        />
                    </StatGrid>

                    {report.grossIncome === 0 && report.totalExpenses === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No farm income or expense activity in {report.year}. Pick another
                                year ([ and ] step years) or post some transactions first.
                            </p>
                        </div>
                    ) : (
                        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[560px] text-sm">
                                    <thead>
                                        <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                            <th className="w-16 px-4 py-3 text-left">Line</th>
                                            <th className="px-4 py-3 text-left">Description</th>
                                            <th className="px-4 py-3 text-right">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr className="border-b border-border bg-background-secondary/20">
                                            <td colSpan={3} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                                                Part I — Farm income
                                            </td>
                                        </tr>
                                        {lineRows(report.incomeLines)}
                                        <tr className="border-b border-border font-medium bg-background-secondary/20">
                                            <td className="px-4 py-2.5 font-mono text-foreground-secondary" style={TNUM}>9</td>
                                            <td className="px-4 py-2.5 text-foreground">Gross farm income</td>
                                            <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                {formatCurrency(report.grossIncome)}
                                            </td>
                                        </tr>
                                        <tr className="border-b border-border bg-background-secondary/20">
                                            <td colSpan={3} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                                                Part II — Farm expenses
                                            </td>
                                        </tr>
                                        {lineRows(report.expenseLines)}
                                    </tbody>
                                    <tfoot>
                                        <tr className="border-t border-border font-medium bg-background-secondary/20">
                                            <td className="px-4 py-3 font-mono text-foreground-secondary" style={TNUM}>33</td>
                                            <td className="px-4 py-3 text-foreground">Total expenses</td>
                                            <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                                {formatCurrency(report.totalExpenses)}
                                            </td>
                                        </tr>
                                        <tr className="font-semibold bg-background-secondary/20">
                                            <td className="px-4 py-3 font-mono text-foreground-secondary" style={TNUM}>34</td>
                                            <td className="px-4 py-3 text-foreground">Net farm profit or (loss)</td>
                                            <td
                                                className={`px-4 py-3 text-right font-mono ${
                                                    report.netProfit >= 0 ? 'text-positive' : 'text-negative'
                                                }`}
                                                style={TNUM}
                                            >
                                                {formatCurrency(report.netProfit)}
                                            </td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>
                    )}

                    {report.unmappedCount > 0 && otherLine && (
                        <div className="border border-warning/30 bg-warning/5 rounded-xl px-4 py-3 text-sm text-foreground-secondary">
                            <span className="font-medium text-foreground">
                                {report.unmappedCount} expense account
                                {report.unmappedCount === 1 ? '' : 's'}
                            </span>{' '}
                            didn&apos;t match any keyword rule and landed on line 32 &quot;Other
                            expenses&quot; ({formatCurrency(otherLine.amount)}). Expand that line to
                            review — renaming accounts (e.g. &quot;Feed &amp; Syrup&quot;,
                            &quot;Jars &amp; Packaging&quot;) improves the mapping.
                        </div>
                    )}

                    {mappingsData && (
                        <CollapsibleConfigSection
                            title="Account mapping"
                            summary={
                                report.overriddenCount > 0
                                    ? `${report.overriddenCount} account${report.overriddenCount === 1 ? '' : 's'} overridden`
                                    : 'Auto-mapped by keyword — click to override'
                            }
                            configured
                            storageKey="scheduleF.mappingOpen"
                        >
                            <p className="text-xs text-foreground-muted mb-3">
                                Map each expense account to a Schedule F line. A manual line
                                overrides the keyword guess; totals above refresh when you save.
                            </p>
                            <ScheduleFMappingPanel
                                accounts={mappingsData.accounts}
                                mappings={mappingsData.mappings}
                                lineOptions={mappingsData.lineOptions}
                                saving={savingMappings}
                                onSave={handleSaveMappings}
                            />
                        </CollapsibleConfigSection>
                    )}

                    <p className="text-xs text-foreground-muted">
                        This is an ESTIMATE built from account-name keywords and your manual line
                        overrides — not tax filing software and not filing advice. Income lines are
                        classified automatically (honey/wax/bee sales → line 2, ag program payments →
                        4a, pollination → 8). Depreciation and §179 (line 14) only appears when you
                        book it to an expense account. Shortcuts: [ and ] step the tax year, Esc
                        collapses expanded lines. Review every line against IRS Schedule F
                        instructions (Pub 225) before using these numbers.
                    </p>
                </>
            )}
        </div>
    );
}
