'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import type { ScheduleCReport } from '@/lib/business/business-reports';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { useToast } from '@/contexts/ToastContext';
import ScheduleCMappingPanel, {
    type ScheduleCMappingAccount,
    type ScheduleCLineOption,
} from './ScheduleCMappingPanel';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface ScheduleCMappingsPayload {
    mappings: Record<string, string>;
    accounts: ScheduleCMappingAccount[];
    lineOptions: ScheduleCLineOption[];
}

export default function ScheduleCPage() {
    const currentYear = new Date().getUTCFullYear();
    const minYear = currentYear - 5;
    const years = Array.from({ length: 6 }, (_, i) => currentYear - i);

    const toast = useToast();
    const [year, setYear] = useState(currentYear);
    const [report, setReport] = useState<ScheduleCReport | null>(null);
    const [entityType, setEntityType] = useState<string | null>(null);
    const [mappingsData, setMappingsData] = useState<ScheduleCMappingsPayload | null>(null);
    const [savingMappings, setSavingMappings] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Expanded line numbers ('1' = gross receipts income detail).
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    // '[' / ']' step the tax year. Single-key global-scope shortcuts are safe
    // here: they are unregistered on unmount, are not chord prefixes, and do
    // not collide with the global 'n'/'e'/'g *' bindings.
    useKeyboardShortcut('schedule-c-prev-year', '[', 'Previous tax year', () =>
        setYear((y) => Math.max(minYear, y - 1)),
        'page',
    );
    useKeyboardShortcut('schedule-c-next-year', ']', 'Next tax year', () =>
        setYear((y) => Math.min(currentYear, y + 1)),
        'page',
    );

    // Escape collapses expanded rows. GlobalShortcuts owns the Escape key and
    // broadcasts 'exit-edit-mode' when nothing modal is open — hooking that
    // event avoids a second, dead Escape registration.
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
                const [res, entityRes, mapsRes] = await Promise.all([
                    fetch(`/api/business/reports/schedule-c?year=${year}`),
                    fetch('/api/entity'),
                    fetch('/api/business/schedule-c/mappings'),
                ]);
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: ScheduleCReport = await res.json();
                const entity = entityRes.ok ? await entityRes.json() : null;
                const maps = mapsRes.ok ? await mapsRes.json() : null;
                if (!cancelled) {
                    setReport(json);
                    setEntityType(entity?.entityType ?? null);
                    setMappingsData(maps);
                    setExpanded(new Set());
                }
            } catch {
                if (!cancelled) setError('Failed to load the Schedule C report.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [year]);

    // Persist mapping overrides, then re-fetch the report + mappings so the
    // line totals above update live.
    const handleSaveMappings = useCallback(
        async (changes: Array<{ accountGuid: string; line: string | null }>) => {
            setSavingMappings(true);
            try {
                const res = await fetch('/api/business/schedule-c/mappings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ changes }),
                });
                if (!res.ok) throw new Error('Save failed');
                const [repRes, mapsRes] = await Promise.all([
                    fetch(`/api/business/reports/schedule-c?year=${year}`),
                    fetch('/api/business/schedule-c/mappings'),
                ]);
                if (repRes.ok) setReport(await repRes.json());
                if (mapsRes.ok) setMappingsData(await mapsRes.json());
                toast.success('Schedule C mapping saved');
            } catch {
                toast.error('Failed to save Schedule C mapping');
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

    const otherLine = report?.lines.find((l) => l.line === '27a');

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

    return (
        <div className="space-y-6">
            <PageHeader
                title="Schedule C Estimate"
                subtitle="The book's income and expenses for a tax year mapped onto Schedule C lines by account-name keywords. For sole-proprietorship / single-member LLC books."
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

            {entityType === 'household' && (
                <div className="border border-warning/30 bg-warning/5 rounded-xl px-4 py-3 text-sm text-foreground-secondary">
                    This book&apos;s entity profile is set to{' '}
                    <span className="font-medium text-foreground">household</span>. Schedule C applies to
                    sole-proprietorship and single-member LLC books — for a household book this report
                    maps ALL income and expenses as if they were business activity.
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
                </div>
            )}

            {!loading && !error && report && (
                <>
                    {/* Compact stat row */}
                    <div className="grid grid-cols-3 gap-4">
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
                            <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">
                                Gross Receipts (Line 1)
                            </div>
                            <div className="text-lg font-bold font-mono text-foreground" style={TNUM}>
                                {formatCurrency(report.grossReceipts)}
                            </div>
                        </div>
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
                            <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">
                                Total Expenses (Line 28)
                            </div>
                            <div className="text-lg font-bold font-mono text-foreground" style={TNUM}>
                                {formatCurrency(report.totalExpenses)}
                            </div>
                        </div>
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
                            <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">
                                Net Profit (Line 31)
                            </div>
                            <div
                                className={`text-lg font-bold font-mono ${
                                    report.netProfit > 0
                                        ? 'text-positive'
                                        : report.netProfit < 0
                                          ? 'text-negative'
                                          : 'text-foreground'
                                }`}
                                style={TNUM}
                            >
                                {formatCurrency(report.netProfit)}
                            </div>
                        </div>
                    </div>

                    {report.grossReceipts === 0 && report.totalExpenses === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No income or expense activity in {report.year}. Pick another year
                                ([ and ] step years) or post some transactions first.
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
                                        {/* Line 1 — gross receipts, expandable income detail */}
                                        <tr
                                            className={`border-b border-border/30 ${
                                                report.incomeAccounts.length > 0
                                                    ? 'cursor-pointer hover:bg-background-secondary/20 transition-colors'
                                                    : ''
                                            }`}
                                            onClick={() => report.incomeAccounts.length > 0 && toggleLine('1')}
                                        >
                                            <td className="px-4 py-2.5 font-mono text-foreground-secondary" style={TNUM}>
                                                1
                                            </td>
                                            <td className="px-4 py-2.5 text-foreground">
                                                {report.incomeAccounts.length > 0 && (
                                                    <span className="mr-2 inline-block w-3 text-foreground-muted">
                                                        {expanded.has('1') ? '▾' : '▸'}
                                                    </span>
                                                )}
                                                Gross receipts or sales
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                {formatCurrency(report.grossReceipts)}
                                            </td>
                                        </tr>
                                        {expanded.has('1') && detailRows(report.incomeAccounts)}

                                        {report.lines.map((line) => {
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
                                                            {line.line === '24b' && line.amount !== 0 && (
                                                                <span className="ml-2 text-xs text-foreground-muted font-mono" style={TNUM}>
                                                                    booked {formatCurrency(line.amount)}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2.5 text-right">
                                                            <span
                                                                className={`font-mono ${
                                                                    Math.abs(line.deductible) < 0.005
                                                                        ? 'text-foreground-muted'
                                                                        : 'text-foreground'
                                                                }`}
                                                                style={TNUM}
                                                            >
                                                                {formatCurrency(line.deductible)}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                    {isOpen && detailRows(line.accounts)}
                                                </Fragment>
                                            );
                                        })}
                                    </tbody>
                                    <tfoot>
                                        <tr className="border-t border-border font-medium bg-background-secondary/20">
                                            <td className="px-4 py-3 font-mono text-foreground-secondary" style={TNUM}>
                                                28
                                            </td>
                                            <td className="px-4 py-3 text-foreground">Total expenses</td>
                                            <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                                {formatCurrency(report.totalExpenses)}
                                            </td>
                                        </tr>
                                        <tr className="font-semibold bg-background-secondary/20">
                                            <td className="px-4 py-3 font-mono text-foreground-secondary" style={TNUM}>
                                                31
                                            </td>
                                            <td className="px-4 py-3 text-foreground">Net profit or (loss)</td>
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
                            didn&apos;t match any keyword rule and landed on line 27a &quot;Other
                            expenses&quot; ({formatCurrency(otherLine.amount)}). Expand that line to review
                            — renaming accounts (e.g. &quot;Supplies&quot;, &quot;Advertising&quot;) improves
                            the mapping.
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
                            storageKey="scheduleC.mappingOpen"
                        >
                            <p className="text-xs text-foreground-muted mb-3">
                                Map each expense account to a Schedule C line. A manual line overrides
                                the keyword guess; totals above refresh when you save.
                            </p>
                            <ScheduleCMappingPanel
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
                        overrides — not tax filing software and not filing advice. Meals (line 24b) are
                        deducted at 50% of the booked amount. Shortcuts: [ and ] step the tax year, Esc
                        collapses expanded lines. Review every line against IRS Schedule C instructions
                        before using these numbers.
                    </p>
                </>
            )}
        </div>
    );
}
