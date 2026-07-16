'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { OwnerSelector } from '@/components/business/OwnerSelector';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import type { TimeEntryDTO, UnbilledCustomerGroup } from '@/lib/business/time-tracking.service';
import type { JobExDTO } from '@/lib/business/jobs.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const smallInputClass = 'w-full bg-input-bg border border-border rounded-md px-2 py-1 text-xs text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ------------------------------------------------------------------ */
/* Date helpers (all string-based: entryDate is a plain YYYY-MM-DD)    */
/* ------------------------------------------------------------------ */

function toIso(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Monday of the week containing the given local date. */
function startOfWeek(d: Date): Date {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (copy.getDay() + 6) % 7; // Mon=0 ... Sun=6
    copy.setDate(copy.getDate() - dow);
    return copy;
}

function addDays(d: Date, n: number): Date {
    const copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
}

function formatHours(minutes: number): string {
    return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
}

function formatElapsed(startedAtIso: string, now: number): string {
    const seconds = Math.max(0, Math.floor((now - new Date(startedAtIso).getTime()) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/* ------------------------------------------------------------------ */
/* Job picker (jobs for one customer, includes the job's default rate) */
/* ------------------------------------------------------------------ */

function JobSelect({
    customerGuid,
    value,
    onChange,
    compact,
}: {
    customerGuid: string;
    value: string;
    onChange: (jobGuid: string, job: JobExDTO | null) => void;
    compact?: boolean;
}) {
    // Rows tagged with the customer they were fetched for: deriving the list
    // at render time (instead of clearing state inside the effect) avoids a
    // synchronous setState-in-effect and never shows another customer's jobs.
    const [fetched, setFetched] = useState<{ owner: string; rows: JobExDTO[] }>({ owner: '', rows: [] });
    const jobs = customerGuid && fetched.owner === customerGuid ? fetched.rows : [];

    useEffect(() => {
        if (!customerGuid) return;
        let cancelled = false;
        fetch(`/api/business/jobs?owner=${customerGuid}&active=active`)
            .then((res) => (res.ok ? res.json() : []))
            .then((rows: JobExDTO[]) => {
                if (!cancelled) setFetched({ owner: customerGuid, rows: Array.isArray(rows) ? rows : [] });
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [customerGuid]);

    return (
        <select
            value={value}
            onChange={(e) => {
                const guid = e.target.value;
                onChange(guid, jobs.find((j) => j.guid === guid) ?? null);
            }}
            disabled={!customerGuid}
            className={compact ? smallInputClass : inputClass}
        >
            <option value="">No job</option>
            {jobs.map((j) => (
                <option key={j.guid} value={j.guid}>
                    {j.name}{j.rate != null ? ` (${formatCurrency(j.rate)}/h)` : ''}
                </option>
            ))}
        </select>
    );
}

/* ------------------------------------------------------------------ */
/* Inline entry editor (used for both edit and per-day add)            */
/* ------------------------------------------------------------------ */

interface EditorState {
    /** null = creating a new entry for `date`. */
    entryId: number | null;
    date: string;
    customerGuid: string;
    jobGuid: string;
    hours: string;
    rate: string;
    description: string;
    billable: boolean;
}

function editorFromEntry(entry: TimeEntryDTO): EditorState {
    return {
        entryId: entry.id,
        date: entry.entryDate,
        customerGuid: entry.customerGuid ?? '',
        jobGuid: entry.jobGuid ?? '',
        hours: formatHours(entry.minutes),
        rate: entry.rate != null ? String(entry.rate) : '',
        description: entry.description,
        billable: entry.billable,
    };
}

function emptyEditor(date: string): EditorState {
    return { entryId: null, date, customerGuid: '', jobGuid: '', hours: '', rate: '', description: '', billable: true };
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function TimeTrackingPage() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
    const [entries, setEntries] = useState<TimeEntryDTO[]>([]);
    const [runningTimer, setRunningTimer] = useState<TimeEntryDTO | null>(null);
    const [unbilled, setUnbilled] = useState<UnbilledCustomerGroup[]>([]);
    const [loading, setLoading] = useState(true);

    // Timer start form
    const [timerCustomer, setTimerCustomer] = useState('');
    const [timerJob, setTimerJob] = useState('');
    const [timerDescription, setTimerDescription] = useState('');
    const [timerBusy, setTimerBusy] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    // Inline editor
    const [editor, setEditor] = useState<EditorState | null>(null);
    const [editorBusy, setEditorBusy] = useState(false);

    // Unbilled invoicing state (per customer)
    const [selectedEntries, setSelectedEntries] = useState<Set<number>>(new Set());
    const [incomeAccount, setIncomeAccount] = useState('');
    const [invoicingCustomer, setInvoicingCustomer] = useState<string | null>(null);
    const [invoiceBusy, setInvoiceBusy] = useState(false);
    const [lastInvoice, setLastInvoice] = useState<{ guid: string; id: string } | null>(null);

    const weekDays = useMemo(
        () => Array.from({ length: 7 }, (_, i) => toIso(addDays(weekStart, i))),
        [weekStart],
    );
    const todayIso = toIso(new Date());

    // Live elapsed tick while a timer runs.
    useEffect(() => {
        if (!runningTimer) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [runningTimer]);

    const fetchWeek = useCallback(async () => {
        try {
            const params = new URLSearchParams({ startDate: weekDays[0], endDate: weekDays[6] });
            const res = await fetch(`/api/business/time?${params}`);
            if (!res.ok) throw new Error('Failed to load time entries');
            const data: { entries: TimeEntryDTO[]; runningTimer: TimeEntryDTO | null } = await res.json();
            setEntries(data.entries);
            setRunningTimer(data.runningTimer);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load time entries');
        } finally {
            setLoading(false);
        }
    }, [weekDays, error]);

    const fetchUnbilled = useCallback(async () => {
        try {
            const res = await fetch('/api/business/time?view=unbilled');
            if (!res.ok) return;
            const data: { unbilled: UnbilledCustomerGroup[] } = await res.json();
            setUnbilled(data.unbilled);
        } catch {
            // non-fatal — the panel just stays stale
        }
    }, []);

    useEffect(() => { fetchWeek(); }, [fetchWeek]);
    useEffect(() => { fetchUnbilled(); }, [fetchUnbilled]);

    const refreshAll = useCallback(async () => {
        await Promise.all([fetchWeek(), fetchUnbilled()]);
    }, [fetchWeek, fetchUnbilled]);

    /* ---------------- Timer actions ---------------- */

    const handleStartTimer = async () => {
        setTimerBusy(true);
        try {
            const res = await fetch('/api/business/time/timer/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerGuid: timerCustomer || null,
                    jobGuid: timerJob || null,
                    description: timerDescription,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to start the timer');
            }
            setTimerDescription('');
            setNow(Date.now());
            await refreshAll();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to start the timer');
        } finally {
            setTimerBusy(false);
        }
    };

    const handleStopTimer = async () => {
        setTimerBusy(true);
        try {
            const res = await fetch('/api/business/time/timer/stop', { method: 'POST' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to stop the timer');
            }
            const entry: TimeEntryDTO = await res.json();
            success(`Logged ${formatHours(entry.minutes)}h`);
            await refreshAll();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to stop the timer');
        } finally {
            setTimerBusy(false);
        }
    };

    /* ---------------- Entry save / delete ---------------- */

    const handleSaveEditor = async () => {
        if (!editor) return;
        const hours = parseFloat(editor.hours);
        if (!isFinite(hours) || hours < 0) {
            error('Enter the hours worked (e.g. 1.5)');
            return;
        }
        setEditorBusy(true);
        try {
            const payload = {
                customerGuid: editor.customerGuid || null,
                jobGuid: editor.jobGuid || null,
                entryDate: editor.date,
                minutes: Math.round(hours * 60),
                rate: editor.rate.trim() === '' ? null : parseFloat(editor.rate) || 0,
                description: editor.description,
                billable: editor.billable,
            };
            const res = await fetch(
                editor.entryId === null ? '/api/business/time' : `/api/business/time/${editor.entryId}`,
                {
                    method: editor.entryId === null ? 'POST' : 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save the entry');
            }
            success(editor.entryId === null ? 'Entry added' : 'Entry updated');
            setEditor(null);
            await refreshAll();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save the entry');
        } finally {
            setEditorBusy(false);
        }
    };

    const handleDeleteEntry = async (id: number) => {
        setEditorBusy(true);
        try {
            const res = await fetch(`/api/business/time/${id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete the entry');
            }
            success('Entry deleted');
            setEditor(null);
            await refreshAll();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete the entry');
        } finally {
            setEditorBusy(false);
        }
    };

    /* ---------------- Invoicing ---------------- */

    const toggleSelected = (id: number) => {
        setSelectedEntries((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const openInvoicePanel = (group: UnbilledCustomerGroup) => {
        setInvoicingCustomer(group.customerGuid);
        // Preselect every invoiceable (rated) entry for the customer.
        setSelectedEntries(new Set(group.entries.filter((e) => e.rate != null).map((e) => e.id)));
    };

    const handleCreateInvoice = async (group: UnbilledCustomerGroup) => {
        const ids = group.entries.map((e) => e.id).filter((id) => selectedEntries.has(id));
        if (ids.length === 0) {
            error('Select at least one entry');
            return;
        }
        if (!incomeAccount) {
            error('Choose the income account for the invoice lines');
            return;
        }
        setInvoiceBusy(true);
        try {
            const res = await fetch('/api/business/time/invoice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerGuid: group.customerGuid,
                    entryIds: ids,
                    incomeAccountGuid: incomeAccount,
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to create the invoice');
            }
            success(`Draft invoice ${data.invoice.id} created (${ids.length} entries)`);
            setLastInvoice({ guid: data.invoice.guid, id: data.invoice.id });
            setInvoicingCustomer(null);
            setSelectedEntries(new Set());
            await refreshAll();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to create the invoice');
        } finally {
            setInvoiceBusy(false);
        }
    };

    /* ---------------- Render helpers ---------------- */

    const weekTotalMinutes = entries.reduce((s, e) => s + e.minutes, 0);

    const renderEditor = (state: EditorState) => (
        <div className="mt-1 space-y-2 rounded-md border border-primary/40 bg-surface-elevated p-2">
            <div>
                <label className={labelClass}>Customer</label>
                <OwnerSelector
                    kind="customer"
                    value={state.customerGuid}
                    onChange={(guid) => setEditor((p) => (p ? { ...p, customerGuid: guid, jobGuid: '' } : p))}
                    compact
                />
            </div>
            <div>
                <label className={labelClass}>Job</label>
                <JobSelect
                    customerGuid={state.customerGuid}
                    value={state.jobGuid}
                    onChange={(guid, job) =>
                        setEditor((p) => {
                            if (!p) return p;
                            // Adopt the job's default rate when the field is still empty.
                            const rate = p.rate.trim() === '' && job?.rate != null ? String(job.rate) : p.rate;
                            return { ...p, jobGuid: guid, rate };
                        })
                    }
                    compact
                />
            </div>
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <label className={labelClass}>Hours</label>
                    <input
                        type="number" min="0" step="0.25" value={state.hours}
                        onChange={(e) => setEditor((p) => (p ? { ...p, hours: e.target.value } : p))}
                        className={`${smallInputClass} font-mono`} placeholder="1.5" autoFocus
                    />
                </div>
                <div>
                    <label className={labelClass}>Rate/h</label>
                    <input
                        type="number" min="0" step="0.01" value={state.rate}
                        onChange={(e) => setEditor((p) => (p ? { ...p, rate: e.target.value } : p))}
                        className={`${smallInputClass} font-mono`} placeholder="—"
                    />
                </div>
            </div>
            <div>
                <label className={labelClass}>Description</label>
                <input
                    type="text" value={state.description}
                    onChange={(e) => setEditor((p) => (p ? { ...p, description: e.target.value } : p))}
                    className={smallInputClass} placeholder="What was done?"
                />
            </div>
            <label className="flex items-center gap-2 text-xs text-foreground-secondary">
                <input
                    type="checkbox" checked={state.billable}
                    onChange={(e) => setEditor((p) => (p ? { ...p, billable: e.target.checked } : p))}
                    className="accent-primary"
                />
                Billable
            </label>
            <div className="flex items-center justify-between pt-1">
                {state.entryId !== null ? (
                    <button
                        type="button"
                        onClick={() => handleDeleteEntry(state.entryId!)}
                        disabled={editorBusy}
                        className="px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                    >
                        Delete
                    </button>
                ) : <span />}
                <div className="flex gap-1">
                    <button
                        type="button"
                        onClick={() => setEditor(null)}
                        className="px-2 py-1 text-xs rounded-md text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSaveEditor}
                        disabled={editorBusy}
                        className="px-2 py-1 text-xs rounded-md bg-primary hover:bg-primary-hover text-primary-foreground transition-colors disabled:opacity-50"
                    >
                        {editorBusy ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );

    return (
        <div className="space-y-4">
            <PageHeader
                title="Time Tracking"
                subtitle="Timers and timesheets per customer and job — unbilled time flows onto draft invoices."
            />

            <HouseholdBookBanner />

            {/* Running timer bar */}
            <div className="bg-surface border border-border rounded-lg p-4">
                {runningTimer ? (
                    <div className="flex flex-wrap items-center gap-4">
                        <span className="relative flex h-2.5 w-2.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm text-foreground truncate">
                                {runningTimer.customerName ?? 'No customer'}
                                {runningTimer.jobName && <span className="text-foreground-secondary"> · {runningTimer.jobName}</span>}
                                {runningTimer.description && <span className="text-foreground-muted"> — {runningTimer.description}</span>}
                            </p>
                            <p className="text-xs text-foreground-muted">
                                Started {new Date(runningTimer.timerStartedAt!).toLocaleTimeString()}
                                {runningTimer.rate != null && <> · {formatCurrency(runningTimer.rate)}/h</>}
                            </p>
                        </div>
                        <span className="font-mono text-2xl text-foreground" style={TNUM}>
                            {formatElapsed(runningTimer.timerStartedAt!, now)}
                        </span>
                        <button
                            type="button"
                            onClick={handleStopTimer}
                            disabled={timerBusy || isReadonly}
                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                            className="px-4 py-2 text-sm bg-negative/90 hover:bg-negative text-white rounded-lg transition-colors disabled:opacity-50"
                        >
                            Stop
                        </button>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1.5fr_auto] md:items-end">
                        <div>
                            <label className={labelClass}>Customer</label>
                            <OwnerSelector
                                kind="customer"
                                value={timerCustomer}
                                onChange={(guid) => { setTimerCustomer(guid); setTimerJob(''); }}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Job</label>
                            <JobSelect customerGuid={timerCustomer} value={timerJob} onChange={(guid) => setTimerJob(guid)} />
                        </div>
                        <div>
                            <label className={labelClass}>Description</label>
                            <input
                                type="text"
                                value={timerDescription}
                                onChange={(e) => setTimerDescription(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !timerBusy && !isReadonly) handleStartTimer(); }}
                                className={inputClass}
                                placeholder="What are you working on?"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={handleStartTimer}
                            disabled={timerBusy || isReadonly}
                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                        >
                            ▶ Start Timer
                        </button>
                    </div>
                )}
            </div>

            {/* Week timesheet grid */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-4 py-2">
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => setWeekStart((d) => addDays(d, -7))}
                            className="px-2 py-1 text-sm rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
                            aria-label="Previous week"
                        >
                            ◀
                        </button>
                        <button
                            type="button"
                            onClick={() => setWeekStart(startOfWeek(new Date()))}
                            className="px-2 py-1 text-xs rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
                        >
                            This week
                        </button>
                        <button
                            type="button"
                            onClick={() => setWeekStart((d) => addDays(d, 7))}
                            className="px-2 py-1 text-sm rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
                            aria-label="Next week"
                        >
                            ▶
                        </button>
                        <span className="ml-2 font-mono text-sm text-foreground" style={TNUM}>
                            {weekDays[0]} → {weekDays[6]}
                        </span>
                    </div>
                    <span className="font-mono text-sm text-foreground-secondary" style={TNUM}>
                        Week total: <span className="text-foreground">{formatHours(weekTotalMinutes)}h</span>
                    </span>
                </div>

                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading timesheet...</span>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <div className="grid min-w-[980px] grid-cols-7 divide-x divide-border">
                            {weekDays.map((iso, i) => {
                                const dayEntries = entries.filter((e) => e.entryDate === iso);
                                const dayMinutes = dayEntries.reduce((s, e) => s + e.minutes, 0);
                                const isToday = iso === todayIso;
                                return (
                                    <div key={iso} className={`flex min-h-[180px] flex-col ${isToday ? 'bg-primary-light/40' : ''}`}>
                                        <div className={`flex items-baseline justify-between border-b border-border/50 px-2 py-1.5 ${isToday ? 'text-primary' : 'text-foreground-secondary'}`}>
                                            <span className="text-xs font-semibold uppercase tracking-wider">
                                                {DAY_LABELS[i]} <span className="font-mono font-normal" style={TNUM}>{iso.slice(8)}</span>
                                            </span>
                                            {dayMinutes > 0 && (
                                                <span className="font-mono text-xs" style={TNUM}>{formatHours(dayMinutes)}h</span>
                                            )}
                                        </div>
                                        <div className="flex-1 space-y-1 p-1.5">
                                            {dayEntries.map((e) =>
                                                editor && editor.entryId === e.id ? (
                                                    <div key={e.id}>{renderEditor(editor)}</div>
                                                ) : (
                                                    <button
                                                        key={e.id}
                                                        type="button"
                                                        onClick={() => {
                                                            if (e.running) return;
                                                            if (e.invoicedInvoiceGuid) return;
                                                            if (isReadonly) return;
                                                            setEditor(editorFromEntry(e));
                                                        }}
                                                        title={
                                                            e.running ? 'Timer running'
                                                            : e.invoicedInvoiceGuid ? 'Invoiced — no longer editable'
                                                            : isReadonly ? READONLY_TOOLTIP : 'Edit entry'
                                                        }
                                                        className={`block w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                                                            e.invoicedInvoiceGuid
                                                                ? 'border-border/50 bg-background-tertiary/50 text-foreground-muted'
                                                                : 'border-border bg-background-secondary/60 text-foreground hover:border-border-hover hover:bg-surface-hover'
                                                        }`}
                                                    >
                                                        <span className="flex items-baseline justify-between gap-2">
                                                            <span className="truncate font-medium">
                                                                {e.customerName ?? 'No customer'}
                                                            </span>
                                                            <span className="font-mono shrink-0" style={TNUM}>
                                                                {e.running ? '● live' : `${formatHours(e.minutes)}h`}
                                                            </span>
                                                        </span>
                                                        {(e.jobName || e.description) && (
                                                            <span className="mt-0.5 block truncate text-foreground-muted">
                                                                {[e.jobName, e.description].filter(Boolean).join(' — ')}
                                                            </span>
                                                        )}
                                                        <span className="mt-0.5 flex items-center gap-1.5">
                                                            {!e.billable && (
                                                                <span className="rounded bg-surface-hover px-1 text-[10px] text-foreground-muted">non-billable</span>
                                                            )}
                                                            {e.invoicedInvoiceGuid && (
                                                                <span className="rounded bg-positive/10 px-1 text-[10px] text-positive">invoiced</span>
                                                            )}
                                                        </span>
                                                    </button>
                                                ),
                                            )}
                                            {editor && editor.entryId === null && editor.date === iso && renderEditor(editor)}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => !isReadonly && setEditor(emptyEditor(iso))}
                                            disabled={isReadonly}
                                            title={isReadonly ? READONLY_TOOLTIP : 'Add entry'}
                                            className="border-t border-border/50 px-2 py-1 text-xs text-foreground-muted hover:bg-surface-hover hover:text-foreground transition-colors disabled:cursor-not-allowed"
                                        >
                                            + Add
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Unbilled time per customer */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                    <h2 className="text-sm font-semibold text-foreground">Unbilled time</h2>
                    {lastInvoice && (
                        <Link
                            href={`/business/invoices/${lastInvoice.guid}`}
                            className="text-xs text-primary hover:text-primary-hover transition-colors"
                        >
                            Draft invoice {lastInvoice.id} created — open →
                        </Link>
                    )}
                </div>
                {unbilled.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-foreground-muted">
                        No unbilled time. Billable entries with a customer appear here until they are invoiced.
                    </p>
                ) : (
                    <div className="divide-y divide-border">
                        {unbilled.map((group) => {
                            const isOpen = invoicingCustomer === group.customerGuid;
                            const selectedForGroup = group.entries.filter((e) => selectedEntries.has(e.id));
                            const selectedAmount = selectedForGroup.reduce((s, e) => {
                                if (e.rate == null) return s;
                                return Math.round((s + (Math.round((e.minutes / 60) * 100) / 100) * e.rate) * 100) / 100;
                            }, 0);
                            return (
                                <div key={group.customerGuid} className="px-4 py-3">
                                    <div className="flex flex-wrap items-center gap-3">
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-medium text-foreground">{group.customerName}</p>
                                            <p className="text-xs text-foreground-muted">
                                                {group.entries.length} entr{group.entries.length === 1 ? 'y' : 'ies'} ·{' '}
                                                <span className="font-mono" style={TNUM}>{group.hours.toFixed(2)}h</span>
                                                {group.jobs.filter((j) => j.jobGuid).length > 0 && (
                                                    <> · {group.jobs.filter((j) => j.jobGuid).map((j) => `${j.jobName}: ${j.hours.toFixed(2)}h`).join(', ')}</>
                                                )}
                                                {group.missingRateCount > 0 && (
                                                    <span className="text-warning"> · {group.missingRateCount} without a rate</span>
                                                )}
                                            </p>
                                        </div>
                                        <span className="font-mono text-sm text-foreground" style={TNUM}>
                                            {formatCurrency(group.amount)}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => (isOpen ? setInvoicingCustomer(null) : openInvoicePanel(group))}
                                            disabled={isReadonly}
                                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                                            className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-md transition-colors"
                                        >
                                            {isOpen ? 'Close' : 'Create invoice'}
                                        </button>
                                    </div>

                                    {isOpen && (
                                        <div className="mt-3 space-y-3 rounded-lg border border-border bg-background-secondary/40 p-3">
                                            <div className="space-y-1">
                                                {group.entries.map((e) => {
                                                    const amount = e.rate != null
                                                        ? (Math.round((e.minutes / 60) * 100) / 100) * e.rate
                                                        : null;
                                                    return (
                                                        <label key={e.id} className="flex items-center gap-2 text-xs text-foreground-secondary">
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedEntries.has(e.id)}
                                                                disabled={e.rate == null}
                                                                onChange={() => toggleSelected(e.id)}
                                                                className="accent-primary"
                                                            />
                                                            <span className="font-mono" style={TNUM}>{e.entryDate}</span>
                                                            <span className="min-w-0 flex-1 truncate">
                                                                {[e.jobName, e.description || 'Time'].filter(Boolean).join(' — ')}
                                                            </span>
                                                            <span className="font-mono" style={TNUM}>
                                                                {(Math.round((e.minutes / 60) * 100) / 100).toFixed(2)}h
                                                            </span>
                                                            <span className="w-20 text-right font-mono" style={TNUM}>
                                                                {amount != null ? formatCurrency(amount) : <span className="text-warning">no rate</span>}
                                                            </span>
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                                                <div>
                                                    <label className={labelClass}>Income account for the invoice lines</label>
                                                    <AccountSelector
                                                        value={incomeAccount}
                                                        onChange={(guid) => setIncomeAccount(guid)}
                                                        accountTypes={['INCOME']}
                                                        placeholder="Select income account..."
                                                    />
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => handleCreateInvoice(group)}
                                                    disabled={invoiceBusy || selectedForGroup.length === 0}
                                                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                                                >
                                                    {invoiceBusy
                                                        ? 'Creating...'
                                                        : `Draft invoice (${selectedForGroup.length} · ${formatCurrency(selectedAmount)})`}
                                                </button>
                                            </div>
                                            <p className="text-[11px] text-foreground-muted">
                                                Creates a draft invoice — review and post it from the invoice page. Entries are marked invoiced immediately.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
