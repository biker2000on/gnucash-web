'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import { escapeCSVField, downloadCSV } from '@/lib/reports/csv-export';
import { formatMinutesAsHours, projectKeyOf, type TimeProject } from '@/lib/timesheet';
import { ProjectSelect } from './ProjectSelect';
import type { TimeEntryDTO } from '@/lib/business/time-tracking.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'bg-input-bg border border-border rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary/50 transition-colors duration-150';

function toIso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function firstOfMonthIso(): string {
    const now = new Date();
    return toIso(new Date(now.getFullYear(), now.getMonth(), 1));
}

interface TimeEntryListProps {
    projects: TimeProject[];
    canWrite: boolean;
    /** Rates/amounts are hidden from timekeepers. */
    canSeeRates: boolean;
    /** The user filter is only offered to edit/admin. */
    canFilterUsers: boolean;
    refreshKey: number;
    onEditEntry: (entry: TimeEntryDTO) => void;
}

/**
 * Flat entry table with filters (project, billable, invoiced, date range,
 * user), a totals bar, CSV export, and click-to-edit.
 */
export function TimeEntryList({ projects, canWrite, canSeeRates, canFilterUsers, refreshKey, onEditEntry }: TimeEntryListProps) {
    const { error } = useToast();

    const [startDate, setStartDate] = useState(firstOfMonthIso());
    const [endDate, setEndDate] = useState(toIso(new Date()));
    const [projectKey, setProjectKey] = useState('');
    const [billableFilter, setBillableFilter] = useState<'all' | 'yes' | 'no'>('all');
    const [invoicedFilter, setInvoicedFilter] = useState<'all' | 'invoiced' | 'uninvoiced'>('all');
    const [userFilter, setUserFilter] = useState('');
    const [entries, setEntries] = useState<TimeEntryDTO[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchEntries = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (startDate) params.set('startDate', startDate);
            if (endDate) params.set('endDate', endDate);
            const res = await fetch(`/api/business/time?${params}`);
            if (!res.ok) throw new Error('Failed to load time entries');
            const data: { entries: TimeEntryDTO[] } = await res.json();
            setEntries(data.entries);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load time entries');
        } finally {
            setLoading(false);
        }
    }, [startDate, endDate, error]);

    useEffect(() => { void fetchEntries(); }, [fetchEntries, refreshKey]);

    const userOptions = useMemo(() => {
        const map = new Map<number, string>();
        for (const e of entries) {
            if (e.userId != null) map.set(e.userId, e.username ?? `User ${e.userId}`);
        }
        return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
    }, [entries]);

    const filtered = useMemo(() => {
        return entries.filter((e) => {
            if (projectKey && projectKeyOf(e) !== projectKey) return false;
            if (billableFilter !== 'all' && e.billable !== (billableFilter === 'yes')) return false;
            if (invoicedFilter === 'invoiced' && !e.invoicedInvoiceGuid) return false;
            if (invoicedFilter === 'uninvoiced' && e.invoicedInvoiceGuid) return false;
            if (userFilter && String(e.userId ?? '') !== userFilter) return false;
            return true;
        });
    }, [entries, projectKey, billableFilter, invoicedFilter, userFilter]);

    const totalMinutes = filtered.reduce((s, e) => s + e.minutes, 0);
    const totalAmount = filtered.reduce((s, e) => s + (e.amount ?? 0), 0);

    const exportCsv = () => {
        const header = [
            'Date', 'Project', 'Job', 'Notes',
            ...(canFilterUsers ? ['User'] : []),
            'Hours',
            ...(canSeeRates ? ['Rate', 'Amount'] : []),
            'Billable', 'Invoiced',
        ];
        const rows = filtered.map((e) => [
            e.entryDate,
            e.customerName ?? '',
            e.jobName ?? '',
            e.description,
            ...(canFilterUsers ? [e.username ?? ''] : []),
            formatMinutesAsHours(e.minutes),
            ...(canSeeRates ? [e.rate != null ? String(e.rate) : '', e.amount != null ? e.amount.toFixed(2) : ''] : []),
            e.billable ? 'yes' : 'no',
            e.invoicedInvoiceGuid ? 'yes' : 'no',
        ]);
        const csv = [header, ...rows]
            .map((cols) => cols.map(escapeCSVField).join(','))
            .join('\n');
        downloadCSV(csv, `time-entries-${startDate}-to-${endDate}.csv`);
    };

    return (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
            {/* Filters */}
            <div className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-2.5">
                <div className="w-56">
                    <label className="block text-[10px] font-medium uppercase tracking-wider text-foreground-muted mb-0.5">Project</label>
                    <ProjectSelect
                        projects={projects}
                        value={projectKey}
                        onChange={(key) => setProjectKey(key)}
                        placeholder="All projects"
                        compact
                    />
                </div>
                <div>
                    <label className="block text-[10px] font-medium uppercase tracking-wider text-foreground-muted mb-0.5">From</label>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`${inputClass} font-mono`} style={TNUM} />
                </div>
                <div>
                    <label className="block text-[10px] font-medium uppercase tracking-wider text-foreground-muted mb-0.5">To</label>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={`${inputClass} font-mono`} style={TNUM} />
                </div>
                <div>
                    <label className="block text-[10px] font-medium uppercase tracking-wider text-foreground-muted mb-0.5">Billable</label>
                    <select value={billableFilter} onChange={(e) => setBillableFilter(e.target.value as typeof billableFilter)} className={inputClass}>
                        <option value="all">All</option>
                        <option value="yes">Billable</option>
                        <option value="no">Non-billable</option>
                    </select>
                </div>
                <div>
                    <label className="block text-[10px] font-medium uppercase tracking-wider text-foreground-muted mb-0.5">Invoiced</label>
                    <select value={invoicedFilter} onChange={(e) => setInvoicedFilter(e.target.value as typeof invoicedFilter)} className={inputClass}>
                        <option value="all">All</option>
                        <option value="uninvoiced">Not invoiced</option>
                        <option value="invoiced">Invoiced</option>
                    </select>
                </div>
                {canFilterUsers && userOptions.length > 0 && (
                    <div>
                        <label className="block text-[10px] font-medium uppercase tracking-wider text-foreground-muted mb-0.5">User</label>
                        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} className={inputClass}>
                            <option value="">All users</option>
                            {userOptions.map(([id, name]) => (
                                <option key={id} value={String(id)}>{name}</option>
                            ))}
                        </select>
                    </div>
                )}
                <button
                    type="button"
                    onClick={exportCsv}
                    disabled={filtered.length === 0}
                    className="ml-auto px-3 py-1.5 text-xs rounded-md border border-border text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors duration-150 disabled:opacity-50"
                >
                    Export CSV
                </button>
            </div>

            {/* Totals bar */}
            <div className="flex items-center gap-4 border-b border-border bg-background-secondary/40 px-4 py-1.5 text-xs text-foreground-secondary">
                <span><span className="font-mono text-foreground" style={TNUM}>{filtered.length}</span> entr{filtered.length === 1 ? 'y' : 'ies'}</span>
                <span><span className="font-mono text-foreground" style={TNUM}>{formatMinutesAsHours(totalMinutes)}</span> hours</span>
                {canSeeRates && (
                    <span><span className="font-mono text-foreground" style={TNUM}>{formatCurrency(totalAmount)}</span> billable value</span>
                )}
            </div>

            {loading ? (
                <div className="p-12 flex items-center justify-center gap-3">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading entries…</span>
                </div>
            ) : filtered.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-foreground-muted">No entries match the filters.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] border-collapse text-sm">
                        <thead>
                            <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                                <th className="px-3 py-2 text-left">Date</th>
                                <th className="px-3 py-2 text-left">Project</th>
                                <th className="px-3 py-2 text-left">Notes</th>
                                {canFilterUsers && <th className="px-3 py-2 text-left">User</th>}
                                <th className="px-3 py-2 text-right">Hours</th>
                                {canSeeRates && <th className="px-3 py-2 text-right">Rate</th>}
                                {canSeeRates && <th className="px-3 py-2 text-right">Amount</th>}
                                <th className="px-3 py-2 text-left">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {filtered.map((e) => (
                                <tr
                                    key={e.id}
                                    onClick={() => onEditEntry(e)}
                                    className="cursor-pointer hover:bg-surface-hover transition-colors duration-150"
                                    title={e.invoicedInvoiceGuid ? 'Invoiced — read only' : canWrite ? 'Click to edit' : undefined}
                                >
                                    <td className="px-3 py-1.5 font-mono text-foreground-secondary" style={TNUM}>{e.entryDate}</td>
                                    <td className="px-3 py-1.5 text-foreground">
                                        <span className="block max-w-[260px] truncate">
                                            {e.customerName ?? <span className="text-foreground-muted">No project</span>}
                                            {e.jobName && <span className="text-foreground-muted"> — {e.jobName}</span>}
                                        </span>
                                    </td>
                                    <td className="px-3 py-1.5 text-foreground-secondary">
                                        <span className="block max-w-[280px] truncate">{e.description}</span>
                                    </td>
                                    {canFilterUsers && (
                                        <td className="px-3 py-1.5 text-foreground-muted">{e.username ?? '—'}</td>
                                    )}
                                    <td className="px-3 py-1.5 text-right font-mono text-foreground" style={TNUM}>
                                        {e.running ? '● live' : formatMinutesAsHours(e.minutes)}
                                    </td>
                                    {canSeeRates && (
                                        <td className="px-3 py-1.5 text-right font-mono text-foreground-secondary" style={TNUM}>
                                            {e.rate != null ? formatCurrency(e.rate) : '—'}
                                        </td>
                                    )}
                                    {canSeeRates && (
                                        <td className="px-3 py-1.5 text-right font-mono text-foreground" style={TNUM}>
                                            {e.amount != null ? formatCurrency(e.amount) : '—'}
                                        </td>
                                    )}
                                    <td className="px-3 py-1.5">
                                        <span className="flex items-center gap-1">
                                            {!e.billable && <span className="rounded bg-surface-hover px-1 text-[10px] text-foreground-muted">non-billable</span>}
                                            {e.invoicedInvoiceGuid && <span className="rounded bg-positive/10 px-1 text-[10px] text-positive">invoiced</span>}
                                            {e.running && <span className="rounded bg-primary-light px-1 text-[10px] text-primary">running</span>}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
