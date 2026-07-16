'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import { ProjectSelect } from '@/components/business/time/ProjectSelect';
import { TimeEntryModal, type EntryModalSeed } from '@/components/business/time/TimeEntryModal';
import { WeekGrid } from '@/components/business/time/WeekGrid';
import { MonthCalendar } from '@/components/business/time/MonthCalendar';
import { TimeEntryList } from '@/components/business/time/TimeEntryList';
import { useToast } from '@/contexts/ToastContext';
import { useBooks } from '@/contexts/BookContext';
import { formatCurrency } from '@/lib/format';
import { formatMinutesAsHours, type TimeProject } from '@/lib/timesheet';
import type { TimeEntryDTO, UnbilledCustomerGroup } from '@/lib/business/time-tracking.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-colors duration-150';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

type ViewMode = 'week' | 'calendar' | 'list';
const VIEW_MODE_KEY = 'time-view-mode';

function toIso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export default function TimeTrackingPage() {
    const { success, error } = useToast();
    const { books, activeBookGuid } = useBooks();

    // Role for the active book drives what this page shows. Server-side
    // checks remain the security boundary — this is presentation only.
    const role = books.find((b) => b.guid === activeBookGuid)?.role;
    const isTimekeeper = role === 'timekeeper';
    const canWrite = role === 'timekeeper' || role === 'edit' || role === 'admin';
    const canInvoice = role === 'edit' || role === 'admin';
    const canSeeFinancials = role === 'readonly' || role === 'edit' || role === 'admin';

    // View mode (persisted)
    const [view, setView] = useState<ViewMode>('week');
    useEffect(() => {
        try {
            const stored = localStorage.getItem(VIEW_MODE_KEY);
            if (stored === 'week' || stored === 'calendar' || stored === 'list') setView(stored);
        } catch { /* ignore */ }
    }, []);
    const changeView = (mode: ViewMode) => {
        setView(mode);
        try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* ignore */ }
    };

    // Data refresh signal for all views + the timer + unbilled panel.
    const [refreshKey, setRefreshKey] = useState(0);
    const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

    // Projects (customer / customer—job pairs) — served by the time API so
    // timekeepers can load it too.
    const [projects, setProjects] = useState<TimeProject[]>([]);
    useEffect(() => {
        let cancelled = false;
        fetch('/api/business/time/projects')
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { projects: TimeProject[] } | null) => {
                if (!cancelled && data?.projects) setProjects(data.projects);
            })
            .catch(() => { /* selector stays empty */ });
        return () => { cancelled = true; };
    }, []);

    /* ---------------- running timer ---------------- */

    const [runningTimer, setRunningTimer] = useState<TimeEntryDTO | null>(null);
    const [timerProjectKey, setTimerProjectKey] = useState('');
    const [timerDescription, setTimerDescription] = useState('');
    const [timerBusy, setTimerBusy] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    const fetchTimer = useCallback(async () => {
        try {
            const today = toIso(new Date());
            const res = await fetch(`/api/business/time?startDate=${today}&endDate=${today}`);
            if (!res.ok) return;
            const data: { runningTimer: TimeEntryDTO | null } = await res.json();
            setRunningTimer(data.runningTimer);
        } catch { /* keep the last known state */ }
    }, []);

    useEffect(() => { void fetchTimer(); }, [fetchTimer, refreshKey]);

    useEffect(() => {
        if (!runningTimer) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [runningTimer]);

    const timerProject = useMemo(
        () => projects.find((p) => p.key === timerProjectKey) ?? null,
        [projects, timerProjectKey],
    );

    const handleStartTimer = async () => {
        setTimerBusy(true);
        try {
            const res = await fetch('/api/business/time/timer/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerGuid: timerProject?.customerGuid ?? null,
                    jobGuid: timerProject?.jobGuid ?? null,
                    description: timerDescription,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to start the timer');
            }
            setTimerDescription('');
            setNow(Date.now());
            bumpRefresh();
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
            success(`Logged ${formatMinutesAsHours(entry.minutes)}h`);
            bumpRefresh();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to stop the timer');
        } finally {
            setTimerBusy(false);
        }
    };

    /* ---------------- entry modal ---------------- */

    const [modalOpen, setModalOpen] = useState(false);
    const [modalSeed, setModalSeed] = useState<EntryModalSeed>({ entry: null });

    const openNewEntry = useCallback((date?: string, projectKey?: string) => {
        setModalSeed({ entry: null, date, projectKey });
        setModalOpen(true);
    }, []);

    const openEditEntry = useCallback((entry: TimeEntryDTO) => {
        setModalSeed({ entry });
        setModalOpen(true);
    }, []);

    /* ---------------- keyboard shortcuts ---------------- */

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (isTypingTarget(e.target)) return;
            if (modalOpen) return;
            if (e.key === '[') {
                window.dispatchEvent(new CustomEvent('time-nav-prev'));
                e.preventDefault();
            } else if (e.key === ']') {
                window.dispatchEvent(new CustomEvent('time-nav-next'));
                e.preventDefault();
            } else if (e.key === 'n' && canWrite) {
                openNewEntry();
                e.preventDefault();
                e.stopPropagation();
            }
        };
        // Capture phase so 'n' does not also trigger the global new-transaction shortcut.
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [modalOpen, canWrite, openNewEntry]);

    /* ---------------- unbilled panel (financial roles only) ---------------- */

    const [unbilled, setUnbilled] = useState<UnbilledCustomerGroup[]>([]);
    const [selectedEntries, setSelectedEntries] = useState<Set<number>>(new Set());
    const [incomeAccount, setIncomeAccount] = useState('');
    const [invoicingCustomer, setInvoicingCustomer] = useState<string | null>(null);
    const [invoiceBusy, setInvoiceBusy] = useState(false);
    const [lastInvoice, setLastInvoice] = useState<{ guid: string; id: string } | null>(null);

    useEffect(() => {
        if (!canSeeFinancials) return;
        let cancelled = false;
        fetch('/api/business/time?view=unbilled')
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { unbilled: UnbilledCustomerGroup[] } | null) => {
                if (!cancelled && data?.unbilled) setUnbilled(data.unbilled);
            })
            .catch(() => { /* panel stays stale */ });
        return () => { cancelled = true; };
    }, [canSeeFinancials, refreshKey]);

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
            bumpRefresh();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to create the invoice');
        } finally {
            setInvoiceBusy(false);
        }
    };

    /* ---------------- render ---------------- */

    return (
        <div className="space-y-4">
            <PageHeader
                title="Time Tracking"
                subtitle={isTimekeeper
                    ? 'Log your hours against projects — week grid, calendar, or list.'
                    : 'Timers and timesheets per project — unbilled time flows onto draft invoices.'}
            />

            {!isTimekeeper && <HouseholdBookBanner />}

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
                                {runningTimer.customerName ?? 'No project'}
                                {runningTimer.jobName && <span className="text-foreground-secondary"> · {runningTimer.jobName}</span>}
                                {runningTimer.description && <span className="text-foreground-muted"> — {runningTimer.description}</span>}
                            </p>
                            <p className="text-xs text-foreground-muted">
                                Started {new Date(runningTimer.timerStartedAt!).toLocaleTimeString()}
                                {canSeeFinancials && runningTimer.rate != null && <> · {formatCurrency(runningTimer.rate)}/h</>}
                            </p>
                        </div>
                        <span className="font-mono text-2xl text-foreground" style={TNUM}>
                            {formatElapsed(runningTimer.timerStartedAt!, now)}
                        </span>
                        <button
                            type="button"
                            onClick={handleStopTimer}
                            disabled={timerBusy || !canWrite}
                            className="px-4 py-2 text-sm bg-negative/90 hover:bg-negative text-white rounded-lg transition-colors duration-150 disabled:opacity-50"
                        >
                            Stop
                        </button>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.2fr_1.5fr_auto] md:items-end">
                        <div>
                            <label className={labelClass}>Project</label>
                            <ProjectSelect
                                projects={projects}
                                value={timerProjectKey}
                                onChange={(key) => setTimerProjectKey(key)}
                                disabled={!canWrite}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Description</label>
                            <input
                                type="text"
                                value={timerDescription}
                                onChange={(e) => setTimerDescription(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !timerBusy && canWrite) void handleStartTimer(); }}
                                disabled={!canWrite}
                                className={inputClass}
                                placeholder="What are you working on?"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={handleStartTimer}
                            disabled={timerBusy || !canWrite}
                            title={!canWrite ? 'Read-only access' : undefined}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors duration-150 whitespace-nowrap"
                        >
                            ▶ Start Timer
                        </button>
                    </div>
                )}
            </div>

            {/* View tabs + new entry */}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="tablist">
                    {([
                        ['week', 'Week grid'],
                        ['calendar', 'Calendar'],
                        ['list', 'List'],
                    ] as Array<[ViewMode, string]>).map(([mode, label]) => (
                        <button
                            key={mode}
                            type="button"
                            role="tab"
                            aria-selected={view === mode}
                            onClick={() => changeView(mode)}
                            className={`px-3 py-1.5 text-sm rounded-md transition-colors duration-150 ${
                                view === mode
                                    ? 'bg-primary-light text-primary font-medium'
                                    : 'text-foreground-secondary hover:text-foreground'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-2">
                    <span className="hidden md:inline text-[11px] text-foreground-muted">
                        Shortcuts: <kbd className="rounded border border-border px-1">[</kbd> <kbd className="rounded border border-border px-1">]</kbd> navigate · <kbd className="rounded border border-border px-1">n</kbd> new entry
                    </span>
                    {canWrite && (
                        <button
                            type="button"
                            onClick={() => openNewEntry()}
                            className="px-3 py-1.5 text-sm rounded-md bg-primary hover:bg-primary-hover text-primary-foreground transition-colors duration-150"
                        >
                            + New entry
                        </button>
                    )}
                </div>
            </div>

            {/* Active view */}
            {view === 'week' && (
                <WeekGrid
                    projects={projects}
                    canWrite={canWrite}
                    refreshKey={refreshKey}
                    onDataChanged={bumpRefresh}
                    onEditEntry={openEditEntry}
                    onQuickAdd={(date, projectKey) => openNewEntry(date, projectKey)}
                />
            )}
            {view === 'calendar' && (
                <MonthCalendar
                    canWrite={canWrite}
                    refreshKey={refreshKey}
                    onEditEntry={openEditEntry}
                    onQuickAdd={(date) => openNewEntry(date)}
                />
            )}
            {view === 'list' && (
                <TimeEntryList
                    projects={projects}
                    canWrite={canWrite}
                    canSeeRates={canSeeFinancials}
                    canFilterUsers={role === 'edit' || role === 'admin'}
                    refreshKey={refreshKey}
                    onEditEntry={openEditEntry}
                />
            )}

            {/* Unbilled time per customer — financial roles only */}
            {canSeeFinancials && (
                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                        <h2 className="text-sm font-semibold text-foreground">Unbilled time</h2>
                        {lastInvoice && (
                            <Link
                                href={`/business/invoices/${lastInvoice.guid}`}
                                className="text-xs text-primary hover:text-primary-hover transition-colors duration-150"
                            >
                                Draft invoice {lastInvoice.id} created — open →
                            </Link>
                        )}
                    </div>
                    {unbilled.length === 0 ? (
                        <p className="px-4 py-6 text-sm text-foreground-muted">
                            No unbilled time. Billable entries with a project appear here until they are invoiced.
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
                                                disabled={!canInvoice}
                                                title={!canInvoice ? 'Read-only access' : undefined}
                                                className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-md transition-colors duration-150"
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
                                                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors duration-150 whitespace-nowrap"
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
            )}

            {/* Shared entry modal */}
            <TimeEntryModal
                open={modalOpen}
                seed={modalSeed}
                projects={projects}
                canSeeRates={canSeeFinancials}
                onClose={() => setModalOpen(false)}
                onSaved={bumpRefresh}
            />
        </div>
    );
}
