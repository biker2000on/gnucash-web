'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import type {
    ScheduleEPropertyReport,
    ScheduleEProperty,
    ScheduleEReport,
} from '@/lib/reports/schedule-e';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { useToast } from '@/contexts/ToastContext';
import ScheduleEPropertyPanel, {
    type ScheduleEPanelAccount,
    type ScheduleELineOption,
} from './ScheduleEPropertyPanel';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface ScheduleEPropertiesPayload {
    properties: ScheduleEProperty[];
    accounts: ScheduleEPanelAccount[];
    lineOptions: ScheduleELineOption[];
}

export default function ScheduleEPage() {
    const currentYear = new Date().getUTCFullYear();
    const minYear = currentYear - 5;
    const years = Array.from({ length: 6 }, (_, i) => currentYear - i);

    const toast = useToast();
    const [year, setYear] = useState(currentYear);
    const [report, setReport] = useState<ScheduleEReport | null>(null);
    const [propertiesData, setPropertiesData] = useState<ScheduleEPropertiesPayload | null>(null);
    const [savingProperties, setSavingProperties] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Expanded rows, keyed `${propertyId}:${line}`.
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    // '[' / ']' step the tax year — same single-key page-scope shortcuts as
    // the Schedule C report.
    useKeyboardShortcut('schedule-e-prev-year', '[', 'Previous tax year', () =>
        setYear((y) => Math.max(minYear, y - 1)),
        'page',
    );
    useKeyboardShortcut('schedule-e-next-year', ']', 'Next tax year', () =>
        setYear((y) => Math.min(currentYear, y + 1)),
        'page',
    );

    // Escape collapses expanded rows via the GlobalShortcuts broadcast.
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
                const [res, propsRes] = await Promise.all([
                    fetch(`/api/business/reports/schedule-e?year=${year}`),
                    fetch('/api/business/schedule-e/properties'),
                ]);
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: ScheduleEReport = await res.json();
                const props = propsRes.ok ? await propsRes.json() : null;
                if (!cancelled) {
                    setReport(json);
                    setPropertiesData(props);
                    setExpanded(new Set());
                }
            } catch {
                if (!cancelled) setError('Failed to load the Schedule E report.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [year]);

    // Persist property definitions, then re-fetch the report + properties so
    // the line totals above update live.
    const handleSaveProperties = useCallback(
        async (properties: ScheduleEProperty[]) => {
            setSavingProperties(true);
            try {
                const res = await fetch('/api/business/schedule-e/properties', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ properties }),
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    throw new Error(body?.error ?? 'Save failed');
                }
                const [repRes, propsRes] = await Promise.all([
                    fetch(`/api/business/reports/schedule-e?year=${year}`),
                    fetch('/api/business/schedule-e/properties'),
                ]);
                if (repRes.ok) setReport(await repRes.json());
                if (propsRes.ok) setPropertiesData(await propsRes.json());
                toast.success('Rental properties saved');
            } catch (err) {
                toast.error(
                    err instanceof Error && err.message !== 'Save failed'
                        ? err.message
                        : 'Failed to save rental properties',
                );
            } finally {
                setSavingProperties(false);
            }
        },
        [year, toast],
    );

    const toggleRow = (key: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const propertyCount = propertiesData?.properties.length ?? report?.properties.length ?? 0;

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

    const assetDetailRows = (prop: ScheduleEPropertyReport) =>
        prop.assets.map((a) => (
            <tr key={a.id} className="border-b border-border/30 bg-background-tertiary/30">
                <td className="px-4 py-2" />
                <td className="pl-9 pr-4 py-2 text-foreground-secondary">
                    {a.description}
                    <span className="ml-2 text-xs text-foreground-muted">
                        {a.method === 'residential' ? '27.5 yr' : '39 yr'} · in service{' '}
                        {a.inServiceDate}
                    </span>
                </td>
                <td className="px-4 py-2 text-right font-mono text-foreground-secondary" style={TNUM}>
                    {formatCurrency(a.depreciation)}
                </td>
            </tr>
        ));

    const propertyTable = (prop: ScheduleEPropertyReport) => {
        const rentsKey = `${prop.id}:3`;
        return (
            <div
                key={prop.id}
                className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden"
            >
                <div className="px-4 py-3 border-b border-border flex items-baseline justify-between gap-3">
                    <h2 className="text-sm font-semibold text-foreground truncate">{prop.name}</h2>
                    <span
                        className={`text-sm font-mono ${
                            prop.netIncome >= 0 ? 'text-positive' : 'text-negative'
                        }`}
                        style={TNUM}
                    >
                        {formatCurrency(prop.netIncome)}
                    </span>
                </div>
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
                            {/* Line 3 — rents received, expandable income detail */}
                            <tr
                                className={`border-b border-border/30 ${
                                    prop.incomeAccounts.length > 0
                                        ? 'cursor-pointer hover:bg-background-secondary/20 transition-colors'
                                        : ''
                                }`}
                                onClick={() => prop.incomeAccounts.length > 0 && toggleRow(rentsKey)}
                            >
                                <td className="px-4 py-2.5 font-mono text-foreground-secondary" style={TNUM}>
                                    3
                                </td>
                                <td className="px-4 py-2.5 text-foreground">
                                    {prop.incomeAccounts.length > 0 && (
                                        <span className="mr-2 inline-block w-3 text-foreground-muted">
                                            {expanded.has(rentsKey) ? '▾' : '▸'}
                                        </span>
                                    )}
                                    Rents received
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                    {formatCurrency(prop.rentsReceived)}
                                </td>
                            </tr>
                            {expanded.has(rentsKey) && detailRows(prop.incomeAccounts)}

                            {prop.lines.map((line) => {
                                const isDepreciation = line.line === '18';
                                const hasDetail =
                                    line.accounts.length > 0 ||
                                    (isDepreciation && prop.assets.length > 0);
                                const key = `${prop.id}:${line.line}`;
                                const isOpen = expanded.has(key);
                                return (
                                    <Fragment key={line.line}>
                                        <tr
                                            className={`border-b border-border/30 ${
                                                hasDetail
                                                    ? 'cursor-pointer hover:bg-background-secondary/20 transition-colors'
                                                    : ''
                                            }`}
                                            onClick={() => hasDetail && toggleRow(key)}
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
                                        {isOpen && isDepreciation && assetDetailRows(prop)}
                                        {isOpen && detailRows(line.accounts)}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                        <tfoot>
                            <tr className="border-t border-border font-medium bg-background-secondary/20">
                                <td className="px-4 py-3 font-mono text-foreground-secondary" style={TNUM}>
                                    20
                                </td>
                                <td className="px-4 py-3 text-foreground">Total expenses</td>
                                <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                    {formatCurrency(prop.totalExpenses)}
                                </td>
                            </tr>
                            <tr className="font-semibold bg-background-secondary/20">
                                <td className="px-4 py-3 font-mono text-foreground-secondary" style={TNUM}>
                                    21
                                </td>
                                <td className="px-4 py-3 text-foreground">Income or (loss)</td>
                                <td
                                    className={`px-4 py-3 text-right font-mono ${
                                        prop.netIncome >= 0 ? 'text-positive' : 'text-negative'
                                    }`}
                                    style={TNUM}
                                >
                                    {formatCurrency(prop.netIncome)}
                                </td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>
        );
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Schedule E Estimate"
                subtitle="Rental income and expenses per property, mapped onto Schedule E Part I lines by account-name keywords, with straight-line mid-month depreciation. Works for any book — household or business."
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

            {!loading && error && (
                <div className="border border-error/30 bg-surface/30 rounded-xl p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && report && (
                <>
                    {propertyCount === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No rental properties defined yet. Create one below — give it a
                                name and pick the income and expense account subtrees that belong
                                to it (e.g. &quot;Income:Rental:123 Main St&quot;).
                            </p>
                        </div>
                    ) : (
                        <>
                            {/* Combined summary stat row */}
                            <StatGrid cols={4}>
                                <StatCard
                                    label="Rents Received (Line 3)"
                                    value={formatCurrency(report.totals.rentsReceived)}
                                    size="compact"
                                />
                                <StatCard
                                    label="Total Expenses (Line 20)"
                                    value={formatCurrency(report.totals.totalExpenses)}
                                    size="compact"
                                />
                                <StatCard
                                    label="Depreciation (Line 18)"
                                    value={formatCurrency(report.totals.depreciation)}
                                    size="compact"
                                />
                                <StatCard
                                    label="Net Income or (Loss)"
                                    value={formatCurrency(report.totals.netIncome)}
                                    tone={
                                        report.totals.netIncome > 0
                                            ? 'positive'
                                            : report.totals.netIncome < 0
                                              ? 'negative'
                                              : 'default'
                                    }
                                    size="compact"
                                />
                            </StatGrid>

                            {report.properties.map((prop) => propertyTable(prop))}

                            {/* Combined per-property summary */}
                            {report.properties.length > 1 && (
                                <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                                    <div className="px-4 py-3 border-b border-border">
                                        <h2 className="text-sm font-semibold text-foreground">
                                            All properties
                                        </h2>
                                    </div>
                                    <div className="overflow-x-auto">
                                        <table className="w-full min-w-[560px] text-sm">
                                            <thead>
                                                <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                                    <th className="px-4 py-3 text-left">Property</th>
                                                    <th className="px-4 py-3 text-right">Rents</th>
                                                    <th className="px-4 py-3 text-right">Expenses</th>
                                                    <th className="px-4 py-3 text-right">Net</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {report.properties.map((prop) => (
                                                    <tr key={prop.id} className="border-b border-border/30">
                                                        <td className="px-4 py-2.5 text-foreground">
                                                            {prop.name}
                                                        </td>
                                                        <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                            {formatCurrency(prop.rentsReceived)}
                                                        </td>
                                                        <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                            {formatCurrency(prop.totalExpenses)}
                                                        </td>
                                                        <td
                                                            className={`px-4 py-2.5 text-right font-mono ${
                                                                prop.netIncome >= 0
                                                                    ? 'text-positive'
                                                                    : 'text-negative'
                                                            }`}
                                                            style={TNUM}
                                                        >
                                                            {formatCurrency(prop.netIncome)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                            <tfoot>
                                                <tr className="border-t border-border font-semibold bg-background-secondary/20">
                                                    <td className="px-4 py-3 text-foreground">Total</td>
                                                    <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                                        {formatCurrency(report.totals.rentsReceived)}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-mono text-foreground" style={TNUM}>
                                                        {formatCurrency(report.totals.totalExpenses)}
                                                    </td>
                                                    <td
                                                        className={`px-4 py-3 text-right font-mono ${
                                                            report.totals.netIncome >= 0
                                                                ? 'text-positive'
                                                                : 'text-negative'
                                                        }`}
                                                        style={TNUM}
                                                    >
                                                        {formatCurrency(report.totals.netIncome)}
                                                    </td>
                                                </tr>
                                            </tfoot>
                                        </table>
                                    </div>
                                </div>
                            )}

                            {report.unmappedCount > 0 && (
                                <div className="border border-warning/30 bg-warning/5 rounded-xl px-4 py-3 text-sm text-foreground-secondary">
                                    <span className="font-medium text-foreground">
                                        {report.unmappedCount} expense account
                                        {report.unmappedCount === 1 ? '' : 's'}
                                    </span>{' '}
                                    didn&apos;t match any keyword rule and landed on line 19
                                    &quot;Other&quot;. Expand that line to review — set a manual
                                    line in the property manager below or rename accounts (e.g.
                                    &quot;Repairs&quot;, &quot;Insurance&quot;) to improve the
                                    mapping.
                                </div>
                            )}
                        </>
                    )}

                    {propertiesData && (
                        <CollapsibleConfigSection
                            title="Rental properties"
                            summary={
                                propertyCount > 0
                                    ? `${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'} defined`
                                    : 'Define your first property'
                            }
                            configured={propertyCount > 0}
                            storageKey="scheduleE.propertiesOpen"
                        >
                            <p className="text-xs text-foreground-muted mb-3">
                                A property groups account subtrees (income and expenses),
                                per-account line overrides, and depreciable assets. Totals above
                                refresh when you save.
                            </p>
                            <ScheduleEPropertyPanel
                                properties={propertiesData.properties}
                                accounts={propertiesData.accounts}
                                lineOptions={propertiesData.lineOptions}
                                saving={savingProperties}
                                onSave={handleSaveProperties}
                            />
                        </CollapsibleConfigSection>
                    )}

                    <p className="text-xs text-foreground-muted">
                        This is an ESTIMATE built from account-name keywords, your manual line
                        overrides, and straight-line mid-month depreciation — not tax filing
                        software and not filing advice. An account claimed by two properties
                        counts only for the first. Shortcuts: [ and ] step the tax year, Esc
                        collapses expanded lines. Review every line against IRS Schedule E
                        instructions before using these numbers.
                    </p>
                </>
            )}
        </div>
    );
}
