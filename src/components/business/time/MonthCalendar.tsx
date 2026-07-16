'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { formatMinutesAsHours } from '@/lib/timesheet';
import type { TimeEntryDTO } from '@/lib/business/time-tracking.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function toIso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Hours -> background intensity class (static strings so Tailwind keeps them). */
function intensityClass(minutes: number): string {
    const hours = minutes / 60;
    if (hours <= 0) return '';
    if (hours < 2) return 'bg-primary/5';
    if (hours < 4) return 'bg-primary/10';
    if (hours < 8) return 'bg-primary/20';
    return 'bg-primary/30';
}

interface MonthCalendarProps {
    canWrite: boolean;
    refreshKey: number;
    onEditEntry: (entry: TimeEntryDTO) => void;
    onQuickAdd: (date: string) => void;
}

/**
 * Custom light month calendar (no calendar dependency): day cells show total
 * hours, up to two project chips and a '+N more' overflow, with background
 * intensity scaled by hours. Clicking a day opens the day detail panel with
 * the entry list and quick add.
 */
export function MonthCalendar({ canWrite, refreshKey, onEditEntry, onQuickAdd }: MonthCalendarProps) {
    const { error } = useToast();
    const [monthStart, setMonthStart] = useState<Date>(() => {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), 1);
    });
    const [entries, setEntries] = useState<TimeEntryDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedDay, setSelectedDay] = useState<string | null>(null);

    // Full Monday-start weeks covering the month.
    const gridDays = useMemo(() => {
        const first = new Date(monthStart);
        const start = new Date(first);
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        const last = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
        const end = new Date(last);
        end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
        const days: Date[] = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            days.push(new Date(d));
        }
        return days;
    }, [monthStart]);

    const fetchMonth = useCallback(async () => {
        try {
            const params = new URLSearchParams({
                startDate: toIso(gridDays[0]),
                endDate: toIso(gridDays[gridDays.length - 1]),
            });
            const res = await fetch(`/api/business/time?${params}`);
            if (!res.ok) throw new Error('Failed to load the calendar');
            const data: { entries: TimeEntryDTO[] } = await res.json();
            setEntries(data.entries);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load the calendar');
        } finally {
            setLoading(false);
        }
    }, [gridDays, error]);

    useEffect(() => { void fetchMonth(); }, [fetchMonth, refreshKey]);

    // '[' / ']' month navigation
    useEffect(() => {
        const prev = () => setMonthStart((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
        const next = () => setMonthStart((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
        window.addEventListener('time-nav-prev', prev);
        window.addEventListener('time-nav-next', next);
        return () => {
            window.removeEventListener('time-nav-prev', prev);
            window.removeEventListener('time-nav-next', next);
        };
    }, []);

    const byDay = useMemo(() => {
        const map = new Map<string, TimeEntryDTO[]>();
        for (const e of entries) {
            const list = map.get(e.entryDate) ?? [];
            list.push(e);
            map.set(e.entryDate, list);
        }
        return map;
    }, [entries]);

    const todayIso = toIso(new Date());
    const selectedEntries = selectedDay ? (byDay.get(selectedDay) ?? []) : [];

    return (
        <div className="space-y-3">
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {/* Month nav */}
                <div className="flex items-center justify-between border-b border-border px-4 py-2">
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => setMonthStart((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
                            className="px-2 py-1 text-sm rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors duration-150"
                            aria-label="Previous month" title="Previous month ( [ )"
                        >
                            ◀
                        </button>
                        <button
                            type="button"
                            onClick={() => { const now = new Date(); setMonthStart(new Date(now.getFullYear(), now.getMonth(), 1)); }}
                            className="px-2 py-1 text-xs rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors duration-150"
                        >
                            Today
                        </button>
                        <button
                            type="button"
                            onClick={() => setMonthStart((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
                            className="px-2 py-1 text-sm rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors duration-150"
                            aria-label="Next month" title="Next month ( ] )"
                        >
                            ▶
                        </button>
                    </div>
                    <span className="text-sm font-semibold text-foreground">
                        {MONTHS[monthStart.getMonth()]} <span className="font-mono font-normal text-foreground-secondary" style={TNUM}>{monthStart.getFullYear()}</span>
                    </span>
                    <span className="font-mono text-xs text-foreground-secondary" style={TNUM}>
                        {formatMinutesAsHours(
                            entries
                                .filter((e) => e.entryDate.slice(0, 7) === toIso(monthStart).slice(0, 7))
                                .reduce((s, e) => s + e.minutes, 0),
                        )}h this month
                    </span>
                </div>

                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading calendar…</span>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <div className="min-w-[700px]">
                            <div className="grid grid-cols-7 border-b border-border">
                                {DAY_LABELS.map((label) => (
                                    <div key={label} className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                                        {label}
                                    </div>
                                ))}
                            </div>
                            <div className="grid grid-cols-7">
                                {gridDays.map((d) => {
                                    const iso = toIso(d);
                                    const dayEntries = byDay.get(iso) ?? [];
                                    const minutes = dayEntries.reduce((s, e) => s + e.minutes, 0);
                                    const inMonth = d.getMonth() === monthStart.getMonth();
                                    const chips = dayEntries.slice(0, 2);
                                    return (
                                        <button
                                            key={iso}
                                            type="button"
                                            onClick={() => setSelectedDay(selectedDay === iso ? null : iso)}
                                            className={`min-h-[84px] border-b border-r border-border/60 p-1.5 text-left align-top transition-colors duration-150 hover:bg-surface-hover ${
                                                intensityClass(minutes)
                                            } ${!inMonth ? 'opacity-40' : ''} ${selectedDay === iso ? 'ring-1 ring-inset ring-primary' : ''}`}
                                        >
                                            <div className="flex items-baseline justify-between">
                                                <span className={`font-mono text-xs ${iso === todayIso ? 'rounded bg-primary px-1 text-primary-foreground' : 'text-foreground-secondary'}`} style={TNUM}>
                                                    {d.getDate()}
                                                </span>
                                                {minutes > 0 && (
                                                    <span className="font-mono text-xs font-medium text-foreground" style={TNUM}>
                                                        {formatMinutesAsHours(minutes)}h
                                                    </span>
                                                )}
                                            </div>
                                            <div className="mt-1 space-y-0.5">
                                                {chips.map((e) => (
                                                    <span
                                                        key={e.id}
                                                        className="block truncate rounded bg-background-secondary/80 px-1 py-px text-[10px] text-foreground-secondary"
                                                    >
                                                        {e.customerName ?? 'No project'}{e.jobName ? ` — ${e.jobName}` : ''}
                                                    </span>
                                                ))}
                                                {dayEntries.length > 2 && (
                                                    <span className="block px-1 text-[10px] text-foreground-muted">+{dayEntries.length - 2} more</span>
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Day detail panel */}
            {selectedDay && (
                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between border-b border-border px-4 py-2">
                        <h3 className="text-sm font-semibold text-foreground">
                            <span className="font-mono" style={TNUM}>{selectedDay}</span>
                            <span className="ml-2 font-mono text-xs text-foreground-secondary" style={TNUM}>
                                {formatMinutesAsHours(selectedEntries.reduce((s, e) => s + e.minutes, 0))}h
                            </span>
                        </h3>
                        <div className="flex items-center gap-2">
                            {canWrite && (
                                <button
                                    type="button"
                                    onClick={() => onQuickAdd(selectedDay)}
                                    className="px-3 py-1 text-xs rounded-md bg-primary hover:bg-primary-hover text-primary-foreground transition-colors duration-150"
                                >
                                    + Add entry
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setSelectedDay(null)}
                                className="px-2 py-1 text-xs rounded-md text-foreground-secondary hover:text-foreground transition-colors duration-150"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                    {selectedEntries.length === 0 ? (
                        <p className="px-4 py-4 text-sm text-foreground-muted">No entries on this day.</p>
                    ) : (
                        <div className="divide-y divide-border/60">
                            {selectedEntries.map((e) => (
                                <button
                                    key={e.id}
                                    type="button"
                                    onClick={() => onEditEntry(e)}
                                    className="flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm hover:bg-surface-hover transition-colors duration-150"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-foreground">
                                            {e.customerName ?? 'No project'}
                                            {e.jobName && <span className="text-foreground-muted"> — {e.jobName}</span>}
                                        </span>
                                        {e.description && <span className="block truncate text-xs text-foreground-muted">{e.description}</span>}
                                    </span>
                                    {e.username && <span className="shrink-0 text-xs text-foreground-muted">{e.username}</span>}
                                    {!e.billable && <span className="shrink-0 rounded bg-surface-hover px-1 text-[10px] text-foreground-muted">non-billable</span>}
                                    {e.invoicedInvoiceGuid && <span className="shrink-0 rounded bg-positive/10 px-1 text-[10px] text-positive">invoiced</span>}
                                    <span className="shrink-0 font-mono text-foreground" style={TNUM}>
                                        {e.running ? '● live' : `${formatMinutesAsHours(e.minutes)}h`}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
