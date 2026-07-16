'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';
import { ProjectSelect } from './ProjectSelect';
import {
    aggregateWeekCells,
    buildCopyWeekOps,
    dayTotals,
    formatMinutesAsHours,
    parseTimeInput,
    type GridCell,
    type TimeProject,
} from '@/lib/timesheet';
import type { TimeEntryDTO } from '@/lib/business/time-tracking.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PINNED_KEY = 'time-pinned-projects';

/* ---------------- date helpers (local, string based) ---------------- */

function toIso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfWeek(d: Date): Date {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7)); // Mon = 0
    return copy;
}

function addDays(d: Date, n: number): Date {
    const copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
}

/* ---------------- pinned projects (localStorage) ---------------- */

function loadPinned(): string[] {
    try {
        const raw = localStorage.getItem(PINNED_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
        return [];
    }
}

function savePinned(keys: string[]) {
    try { localStorage.setItem(PINNED_KEY, JSON.stringify(keys)); } catch { /* ignore */ }
}

/* ---------------- cell hours input ---------------- */

function CellInput({
    cell,
    disabled,
    onCommit,
}: {
    cell: GridCell | undefined;
    disabled: boolean;
    onCommit: (text: string) => void;
}) {
    const committed = cell && cell.minutes > 0 ? formatMinutesAsHours(cell.minutes) : '';
    const [text, setText] = useState(committed);
    const [invalid, setInvalid] = useState(false);
    const [prevCommitted, setPrevCommitted] = useState(committed);
    const [isFocused, setIsFocused] = useState(false);

    // Adopt refetched values unless the user is mid-edit (derived-state
    // adjustment during render, per the React docs pattern).
    if (prevCommitted !== committed) {
        setPrevCommitted(committed);
        if (!isFocused) {
            setText(committed);
            setInvalid(false);
        }
    }

    return (
        <input
            type="text"
            inputMode="decimal"
            value={text}
            disabled={disabled}
            onFocus={(e) => { setIsFocused(true); e.target.select(); }}
            onChange={(e) => { setText(e.target.value); setInvalid(false); }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') { setText(committed); (e.target as HTMLInputElement).blur(); }
            }}
            onBlur={() => {
                setIsFocused(false);
                if (text.trim() === committed.trim()) { setText(committed); return; }
                if (parseTimeInput(text) === null) { setInvalid(true); return; }
                onCommit(text);
            }}
            placeholder="–"
            aria-invalid={invalid || undefined}
            title={invalid ? "Unrecognized time — try '2.5', '2:30', '2h 30m', or '150m'" : undefined}
            className={`w-full bg-transparent border rounded-md px-1.5 py-1 text-center font-mono text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-colors duration-150 ${
                invalid ? 'border-negative/70' : 'border-transparent hover:border-border'
            } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            style={TNUM}
        />
    );
}

/* ---------------- notes popover ---------------- */

function NotesPopover({
    initial,
    onSave,
    onClose,
}: {
    initial: string;
    onSave: (text: string) => void;
    onClose: () => void;
}) {
    const [text, setText] = useState(initial);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onDocClick = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [onClose]);

    return (
        <div
            ref={ref}
            className="absolute z-40 top-full left-1/2 -translate-x-1/2 mt-1 w-56 rounded-md border border-border bg-surface-elevated p-2 shadow-lg"
        >
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Note for this entry…"
                onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSave(text); }
                    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
                }}
                className="w-full bg-input-bg border border-border rounded-md px-2 py-1.5 text-xs text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 resize-none"
            />
            <div className="mt-1.5 flex justify-end gap-1">
                <button
                    type="button" onClick={onClose}
                    className="px-2 py-1 text-xs rounded-md text-foreground-secondary hover:text-foreground transition-colors duration-150"
                >
                    Cancel
                </button>
                <button
                    type="button" onClick={() => onSave(text)}
                    className="px-2 py-1 text-xs rounded-md bg-primary hover:bg-primary-hover text-primary-foreground transition-colors duration-150"
                >
                    Save
                </button>
            </div>
        </div>
    );
}

/* ---------------- component ---------------- */

interface WeekGridProps {
    projects: TimeProject[];
    canWrite: boolean;
    refreshKey: number;
    onDataChanged: () => void;
    onEditEntry: (entry: TimeEntryDTO) => void;
    onQuickAdd: (date: string, projectKey?: string) => void;
}

export function WeekGrid({ projects, canWrite, refreshKey, onDataChanged, onEditEntry, onQuickAdd }: WeekGridProps) {
    const { success, error } = useToast();

    const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
    const [entries, setEntries] = useState<TimeEntryDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [pinned, setPinned] = useState<string[]>([]);
    const [extraRowKeys, setExtraRowKeys] = useState<string[]>([]);
    const [rowBillable, setRowBillable] = useState<Record<string, boolean>>({});
    const [addRowKey, setAddRowKey] = useState('');
    const [notesOpenFor, setNotesOpenFor] = useState<string | null>(null); // `${rowKey}@${date}`
    const [dayDetail, setDayDetail] = useState<string | null>(null); // dateIso

    useEffect(() => { setPinned(loadPinned()); }, []);

    const weekDays = useMemo(
        () => Array.from({ length: 7 }, (_, i) => toIso(addDays(weekStart, i))),
        [weekStart],
    );
    const todayIso = toIso(new Date());

    const fetchWeek = useCallback(async () => {
        try {
            const params = new URLSearchParams({ startDate: weekDays[0], endDate: weekDays[6] });
            const res = await fetch(`/api/business/time?${params}`);
            if (!res.ok) throw new Error('Failed to load the timesheet');
            const data: { entries: TimeEntryDTO[] } = await res.json();
            setEntries(data.entries);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load the timesheet');
        } finally {
            setLoading(false);
        }
    }, [weekDays, error]);

    useEffect(() => { void fetchWeek(); }, [fetchWeek, refreshKey]);

    // '[' / ']' week navigation (dispatched by the page-level shortcut handler)
    useEffect(() => {
        const prev = () => setWeekStart((d) => addDays(d, -7));
        const next = () => setWeekStart((d) => addDays(d, 7));
        window.addEventListener('time-nav-prev', prev);
        window.addEventListener('time-nav-next', next);
        return () => {
            window.removeEventListener('time-nav-prev', prev);
            window.removeEventListener('time-nav-next', next);
        };
    }, []);

    const grid = useMemo(() => aggregateWeekCells(entries), [entries]);
    const totalsByDay = useMemo(() => dayTotals(entries, weekDays), [entries, weekDays]);
    const weekTotal = entries.reduce((s, e) => s + e.minutes, 0);

    // Row set: pinned first (in pin order), then rows with entries, then
    // session-added rows — deduplicated.
    const rowKeys = useMemo(() => {
        const seen = new Set<string>();
        const keys: string[] = [];
        const push = (k: string) => { if (!seen.has(k)) { seen.add(k); keys.push(k); } };
        pinned.forEach(push);
        Array.from(grid.keys()).sort((a, b) => labelFor(a).localeCompare(labelFor(b))).forEach(push);
        extraRowKeys.forEach(push);
        return keys;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pinned, grid, extraRowKeys, projects]);

    function labelFor(key: string): string {
        const project = projects.find((p) => p.key === key);
        if (project) return project.label;
        const row = grid.get(key);
        if (row) {
            const name = row.customerName ?? (row.customerGuid ? 'Unknown customer' : 'No project');
            return row.jobName ? `${name} — ${row.jobName}` : name;
        }
        return key === ':' ? 'No project' : 'Unknown project';
    }

    const togglePin = (key: string) => {
        setPinned((prev) => {
            const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
            savePinned(next);
            return next;
        });
    };

    const isRowBillable = (key: string): boolean => rowBillable[key] ?? true;

    /* ---------------- cell persistence ---------------- */

    const commitCell = async (rowKey: string, date: string, text: string) => {
        const minutes = parseTimeInput(text);
        if (minutes === null) return; // CellInput already flagged it
        const cell = grid.get(rowKey)?.cells.get(date);
        const [customerGuid, jobGuid] = rowKey.split(':');
        setBusy(true);
        try {
            if (!cell || cell.count === 0) {
                if (minutes === 0) return;
                const res = await fetch('/api/business/time', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        customerGuid: customerGuid || null,
                        jobGuid: jobGuid || null,
                        entryDate: date,
                        minutes,
                        billable: isRowBillable(rowKey),
                    }),
                });
                if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to save the cell');
            } else if (cell.count === 1) {
                const id = cell.entryIds[0];
                if (minutes === 0) {
                    const res = await fetch(`/api/business/time/${id}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to clear the cell');
                } else if (minutes !== cell.minutes) {
                    const res = await fetch(`/api/business/time/${id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ minutes }),
                    });
                    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to save the cell');
                }
            }
            onDataChanged();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save the cell');
            await fetchWeek(); // revert the input to server truth
        } finally {
            setBusy(false);
        }
    };

    const saveNote = async (cell: GridCell, text: string) => {
        try {
            const res = await fetch(`/api/business/time/${cell.entryIds[0]}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: text }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to save the note');
            setNotesOpenFor(null);
            onDataChanged();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save the note');
        }
    };

    /* ---------------- copy previous week ---------------- */

    const copyPreviousWeek = async () => {
        setBusy(true);
        try {
            const prevDays = Array.from({ length: 7 }, (_, i) => toIso(addDays(weekStart, i - 7)));
            const params = new URLSearchParams({ startDate: prevDays[0], endDate: prevDays[6] });
            const res = await fetch(`/api/business/time?${params}`);
            if (!res.ok) throw new Error('Failed to load the previous week');
            const data: { entries: TimeEntryDTO[] } = await res.json();
            const ops = buildCopyWeekOps(data.entries, entries);
            if (ops.length === 0) {
                success('Nothing to copy — every matching cell already has time');
                return;
            }
            let created = 0;
            for (const op of ops) {
                const createRes = await fetch('/api/business/time', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(op),
                });
                if (createRes.ok) created += 1;
            }
            success(`Copied ${created} cell${created === 1 ? '' : 's'} from the previous week`);
            onDataChanged();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to copy the previous week');
        } finally {
            setBusy(false);
        }
    };

    /* ---------------- render ---------------- */

    const dayDetailEntries = dayDetail ? entries.filter((e) => e.entryDate === dayDetail) : [];

    return (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
            {/* Header: week nav + copy + total */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => setWeekStart((d) => addDays(d, -7))}
                        className="px-2 py-1 text-sm rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors duration-150"
                        aria-label="Previous week"
                        title="Previous week ( [ )"
                    >
                        ◀
                    </button>
                    <button
                        type="button"
                        onClick={() => setWeekStart(startOfWeek(new Date()))}
                        className="px-2 py-1 text-xs rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors duration-150"
                    >
                        This week
                    </button>
                    <button
                        type="button"
                        onClick={() => setWeekStart((d) => addDays(d, 7))}
                        className="px-2 py-1 text-sm rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors duration-150"
                        aria-label="Next week"
                        title="Next week ( ] )"
                    >
                        ▶
                    </button>
                    <span className="ml-2 font-mono text-sm text-foreground" style={TNUM}>
                        {weekDays[0]} → {weekDays[6]}
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    {canWrite && (
                        <button
                            type="button"
                            onClick={copyPreviousWeek}
                            disabled={busy}
                            className="px-3 py-1.5 text-xs rounded-md border border-border text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors duration-150 disabled:opacity-50"
                            title="Copy the previous week's project hours into the empty cells of this week"
                        >
                            Copy previous week
                        </button>
                    )}
                    <span className="font-mono text-sm text-foreground-secondary" style={TNUM}>
                        Week total: <span className="text-foreground">{formatMinutesAsHours(weekTotal)}h</span>
                    </span>
                </div>
            </div>

            {loading ? (
                <div className="p-12 flex items-center justify-center gap-3">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading timesheet…</span>
                </div>
            ) : (
                <>
                    {/* Desktop grid */}
                    <div className="hidden md:block overflow-x-auto">
                        <table className="w-full min-w-[960px] border-collapse text-sm">
                            <thead>
                                <tr className="border-b border-border">
                                    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground-muted w-56">
                                        Project
                                    </th>
                                    {weekDays.map((iso, i) => (
                                        <th
                                            key={iso}
                                            className={`px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wider ${
                                                iso === todayIso ? 'text-primary' : 'text-foreground-muted'
                                            }`}
                                        >
                                            {DAY_LABELS[i]} <span className="font-mono font-normal" style={TNUM}>{iso.slice(8)}</span>
                                        </th>
                                    ))}
                                    <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-foreground-muted w-20">
                                        Total
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                                {rowKeys.length === 0 && (
                                    <tr>
                                        <td colSpan={9} className="px-4 py-8 text-center text-sm text-foreground-muted">
                                            No time this week. {canWrite ? 'Add a project row below or press n for a new entry.' : ''}
                                        </td>
                                    </tr>
                                )}
                                {rowKeys.map((key) => {
                                    const row = grid.get(key);
                                    const isPinned = pinned.includes(key);
                                    return (
                                        <tr key={key} className="group">
                                            <td className="px-3 py-1.5">
                                                <div className="flex items-center gap-1.5">
                                                    <button
                                                        type="button"
                                                        onClick={() => togglePin(key)}
                                                        className={`shrink-0 transition-colors duration-150 ${
                                                            isPinned ? 'text-warning' : 'text-foreground-muted/40 hover:text-foreground-muted group-hover:opacity-100'
                                                        }`}
                                                        title={isPinned ? 'Unpin project' : 'Pin project'}
                                                        aria-label={isPinned ? 'Unpin project' : 'Pin project'}
                                                    >
                                                        <svg className="w-3.5 h-3.5" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5c.2-.4.84-.4 1.04 0l2.13 4.35 4.8.7c.45.06.63.62.3.94l-3.47 3.38.82 4.78c.08.44-.39.78-.79.57L12 15.97l-4.3 2.25c-.4.21-.87-.13-.8-.57l.83-4.78-3.48-3.38c-.32-.32-.14-.88.3-.94l4.8-.7 2.13-4.34z" />
                                                        </svg>
                                                    </button>
                                                    <span className="truncate text-foreground" title={labelFor(key)}>{labelFor(key)}</span>
                                                    {canWrite && (
                                                        <button
                                                            type="button"
                                                            onClick={() => setRowBillable((prev) => ({ ...prev, [key]: !isRowBillable(key) }))}
                                                            className={`ml-auto shrink-0 rounded px-1 text-[10px] font-medium transition-colors duration-150 ${
                                                                isRowBillable(key)
                                                                    ? 'bg-primary-light text-primary'
                                                                    : 'bg-surface-hover text-foreground-muted'
                                                            }`}
                                                            title={isRowBillable(key)
                                                                ? 'New entries in this row are billable — click to make non-billable'
                                                                : 'New entries in this row are non-billable — click to make billable'}
                                                        >
                                                            {isRowBillable(key) ? 'billable' : 'non-bill.'}
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                            {weekDays.map((iso) => {
                                                const cell = row?.cells.get(iso);
                                                const cellKey = `${key}@${iso}`;
                                                const locked = !canWrite || Boolean(cell?.hasInvoiced) || Boolean(cell?.hasRunning);
                                                if (cell && cell.count > 1) {
                                                    return (
                                                        <td key={iso} className={`px-1 py-1 text-center ${iso === todayIso ? 'bg-primary-light/30' : ''}`}>
                                                            <button
                                                                type="button"
                                                                onClick={() => setDayDetail(iso)}
                                                                className="w-full rounded-md border border-border bg-background-secondary/60 px-1.5 py-1 font-mono text-sm text-foreground hover:border-border-hover hover:bg-surface-hover transition-colors duration-150"
                                                                style={TNUM}
                                                                title={`${cell.count} entries — open the day to edit them individually`}
                                                            >
                                                                {formatMinutesAsHours(cell.minutes)}
                                                                <span className="ml-1 rounded bg-secondary-light px-1 text-[10px] text-secondary align-middle">{cell.count}</span>
                                                            </button>
                                                        </td>
                                                    );
                                                }
                                                return (
                                                    <td key={iso} className={`relative px-1 py-1 ${iso === todayIso ? 'bg-primary-light/30' : ''}`}>
                                                        <div className="relative flex items-center">
                                                            <CellInput
                                                                cell={cell}
                                                                disabled={locked}
                                                                onCommit={(text) => void commitCell(key, iso, text)}
                                                            />
                                                            {cell && cell.count === 1 && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setNotesOpenFor(notesOpenFor === cellKey ? null : cellKey)}
                                                                    className={`absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors duration-150 ${
                                                                        cell.description
                                                                            ? 'text-secondary'
                                                                            : 'text-foreground-muted/0 hover:text-foreground-muted group-hover:text-foreground-muted/60'
                                                                    }`}
                                                                    title={cell.description || 'Add a note'}
                                                                    aria-label="Cell note"
                                                                >
                                                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5m-9 6V6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2H8l-4 4z" />
                                                                    </svg>
                                                                </button>
                                                            )}
                                                            {cell?.hasInvoiced && (
                                                                <span className="absolute -top-0.5 right-0.5 text-[9px] text-positive" title="Invoiced — locked">✓</span>
                                                            )}
                                                        </div>
                                                        {notesOpenFor === cellKey && cell && cell.count === 1 && (
                                                            <NotesPopover
                                                                initial={cell.description}
                                                                onSave={(text) => void saveNote(cell, text)}
                                                                onClose={() => setNotesOpenFor(null)}
                                                            />
                                                        )}
                                                    </td>
                                                );
                                            })}
                                            <td className="px-3 py-1.5 text-right font-mono text-foreground-secondary" style={TNUM}>
                                                {row && row.totalMinutes > 0 ? `${formatMinutesAsHours(row.totalMinutes)}h` : '—'}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-border bg-background-secondary/40">
                                    <td className="px-3 py-2 text-xs font-medium text-foreground-secondary">Daily total</td>
                                    {weekDays.map((iso) => {
                                        const m = totalsByDay.get(iso) ?? 0;
                                        return (
                                            <td key={iso} className={`px-2 py-2 text-center font-mono text-sm ${m > 0 ? 'text-foreground' : 'text-foreground-muted'}`} style={TNUM}>
                                                {m > 0 ? formatMinutesAsHours(m) : '·'}
                                            </td>
                                        );
                                    })}
                                    <td className="px-3 py-2 text-right font-mono text-sm font-semibold text-foreground" style={TNUM}>
                                        {formatMinutesAsHours(weekTotal)}h
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>

                    {/* Mobile: stacked per-day list */}
                    <div className="md:hidden divide-y divide-border">
                        {weekDays.map((iso, i) => {
                            const dayEntries = entries.filter((e) => e.entryDate === iso);
                            const total = totalsByDay.get(iso) ?? 0;
                            return (
                                <div key={iso} className={iso === todayIso ? 'bg-primary-light/20' : ''}>
                                    <div className="flex items-baseline justify-between px-4 pt-2.5 pb-1">
                                        <span className={`text-xs font-semibold uppercase tracking-wider ${iso === todayIso ? 'text-primary' : 'text-foreground-secondary'}`}>
                                            {DAY_LABELS[i]} <span className="font-mono font-normal" style={TNUM}>{iso.slice(5)}</span>
                                        </span>
                                        {total > 0 && <span className="font-mono text-xs text-foreground-secondary" style={TNUM}>{formatMinutesAsHours(total)}h</span>}
                                    </div>
                                    <div className="px-3 pb-2 space-y-1">
                                        {dayEntries.map((e) => (
                                            <button
                                                key={e.id}
                                                type="button"
                                                onClick={() => onEditEntry(e)}
                                                className="flex w-full items-baseline justify-between gap-2 rounded-md border border-border bg-background-secondary/60 px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-hover transition-colors duration-150"
                                            >
                                                <span className="min-w-0 flex-1 truncate">
                                                    {e.customerName ?? 'No project'}
                                                    {e.jobName && <span className="text-foreground-muted"> — {e.jobName}</span>}
                                                </span>
                                                <span className="font-mono shrink-0" style={TNUM}>
                                                    {e.running ? '● live' : `${formatMinutesAsHours(e.minutes)}h`}
                                                </span>
                                            </button>
                                        ))}
                                        {canWrite && (
                                            <button
                                                type="button"
                                                onClick={() => onQuickAdd(iso)}
                                                className="w-full rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors duration-150"
                                            >
                                                + Add
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Add project row */}
                    {canWrite && (
                        <div className="hidden md:flex items-center gap-2 border-t border-border px-3 py-2">
                            <div className="w-72">
                                <ProjectSelect
                                    projects={projects.filter((p) => !rowKeys.includes(p.key))}
                                    value={addRowKey}
                                    onChange={(key) => {
                                        if (key) setExtraRowKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
                                        setAddRowKey('');
                                    }}
                                    allowNone={false}
                                    placeholder="Add project row…"
                                    compact
                                />
                            </div>
                            <span className="text-[11px] text-foreground-muted">
                                {"Type into a cell — '2.5', '2:30', '2h 30m', or '150m'. Saves on blur."}
                            </span>
                        </div>
                    )}
                </>
            )}

            {/* Day detail (multi-entry cells) */}
            <Modal isOpen={dayDetail !== null} onClose={() => setDayDetail(null)} title={dayDetail ? `Entries on ${dayDetail}` : ''} size="md">
                <div className="p-4 space-y-1.5">
                    {dayDetailEntries.map((e) => (
                        <button
                            key={e.id}
                            type="button"
                            onClick={() => { setDayDetail(null); onEditEntry(e); }}
                            className="flex w-full items-baseline justify-between gap-3 rounded-md border border-border bg-background-secondary/60 px-3 py-2 text-left text-sm text-foreground hover:bg-surface-hover transition-colors duration-150"
                        >
                            <span className="min-w-0 flex-1">
                                <span className="block truncate">
                                    {e.customerName ?? 'No project'}
                                    {e.jobName && <span className="text-foreground-muted"> — {e.jobName}</span>}
                                </span>
                                {e.description && <span className="block truncate text-xs text-foreground-muted">{e.description}</span>}
                            </span>
                            <span className="font-mono shrink-0" style={TNUM}>
                                {e.running ? '● live' : `${formatMinutesAsHours(e.minutes)}h`}
                            </span>
                        </button>
                    ))}
                    {canWrite && dayDetail && (
                        <button
                            type="button"
                            onClick={() => { const d = dayDetail; setDayDetail(null); onQuickAdd(d); }}
                            className="w-full rounded-md border border-dashed border-border px-3 py-2 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors duration-150"
                        >
                            + Add entry
                        </button>
                    )}
                </div>
            </Modal>
        </div>
    );
}
