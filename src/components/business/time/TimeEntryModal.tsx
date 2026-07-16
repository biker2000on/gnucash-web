'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';
import { ProjectSelect } from './ProjectSelect';
import {
    parseTimeInput,
    formatMinutesAsHours,
    addDaysIso,
    hoursBetween,
    type TimeProject,
} from '@/lib/timesheet';
import type { TimeEntryDTO } from '@/lib/business/time-tracking.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-colors duration-150';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

const LAST_PROJECT_KEY = 'time-last-project';

export interface EntryModalSeed {
    /** Existing entry to edit, or null to create. */
    entry: TimeEntryDTO | null;
    /** Prefill for new entries. */
    date?: string;
    projectKey?: string;
}

interface TimeEntryModalProps {
    open: boolean;
    seed: EntryModalSeed;
    projects: TimeProject[];
    /** Rates are financial data — hidden from timekeepers. */
    canSeeRates: boolean;
    onClose: () => void;
    onSaved: () => void;
}

function todayIso(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Shared create/edit entry modal.
 * Keyboard: on the date field '+'/'=' next day, '-' previous day, 't' today;
 * Ctrl/Cmd+Enter submits from anywhere in the form.
 */
export function TimeEntryModal({ open, seed, projects, canSeeRates, onClose, onSaved }: TimeEntryModalProps) {
    const { success, error } = useToast();

    const [date, setDate] = useState(todayIso());
    const [projectKey, setProjectKey] = useState('');
    const [hoursText, setHoursText] = useState('');
    const [startTime, setStartTime] = useState('');
    const [endTime, setEndTime] = useState('');
    const [rateText, setRateText] = useState('');
    const [billable, setBillable] = useState(true);
    const [notes, setNotes] = useState('');
    const [busy, setBusy] = useState(false);

    const editing = seed.entry;

    // (Re)seed the form when the modal opens.
    useEffect(() => {
        if (!open) return;
        if (editing) {
            setDate(editing.entryDate);
            setProjectKey(`${editing.customerGuid ?? ''}:${editing.jobGuid ?? ''}`);
            setHoursText(editing.minutes > 0 ? formatMinutesAsHours(editing.minutes) : '');
            setRateText(editing.rate != null ? String(editing.rate) : '');
            setBillable(editing.billable);
            setNotes(editing.description);
        } else {
            setDate(seed.date ?? todayIso());
            let key = seed.projectKey ?? '';
            if (!key) {
                try { key = localStorage.getItem(LAST_PROJECT_KEY) ?? ''; } catch { /* ignore */ }
            }
            setProjectKey(key);
            setHoursText('');
            setRateText('');
            setBillable(true);
            setNotes('');
        }
        setStartTime('');
        setEndTime('');
        setBusy(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Start/end time pickers auto-compute the hours field.
    useEffect(() => {
        if (!startTime || !endTime) return;
        const hours = hoursBetween(startTime, endTime);
        if (hours != null) setHoursText(String(hours));
    }, [startTime, endTime]);

    const project = useMemo(
        () => projects.find((p) => p.key === projectKey) ?? null,
        [projects, projectKey],
    );

    const parsedMinutes = parseTimeInput(hoursText);
    const invalidHours = parsedMinutes === null;

    const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === '+' || e.key === '=') {
            setDate((d) => addDaysIso(d, 1));
            e.preventDefault();
        } else if (e.key === '-') {
            setDate((d) => addDaysIso(d, -1));
            e.preventDefault();
        } else if (e.key.toLowerCase() === 't') {
            setDate(todayIso());
            e.preventDefault();
        }
    };

    const save = async () => {
        if (busy) return;
        const minutes = parseTimeInput(hoursText);
        if (minutes === null) {
            error("Enter the hours worked — '2.5', '2:30', '2h 30m', or '150m'");
            return;
        }
        if (!editing && minutes === 0) {
            error('Enter more than zero hours');
            return;
        }
        setBusy(true);
        try {
            const payload: Record<string, unknown> = {
                customerGuid: project?.customerGuid ?? null,
                jobGuid: project?.jobGuid ?? null,
                entryDate: date,
                minutes,
                description: notes,
                billable,
            };
            if (canSeeRates) {
                payload.rate = rateText.trim() === '' ? null : Math.max(0, parseFloat(rateText) || 0);
            }
            const res = await fetch(
                editing ? `/api/business/time/${editing.id}` : '/api/business/time',
                {
                    method: editing ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save the entry');
            }
            if (projectKey) {
                try { localStorage.setItem(LAST_PROJECT_KEY, projectKey); } catch { /* ignore */ }
            }
            success(editing ? 'Entry updated' : 'Entry added');
            onSaved();
            onClose();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save the entry');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!editing || busy) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/business/time/${editing.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete the entry');
            }
            success('Entry deleted');
            onSaved();
            onClose();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete the entry');
        } finally {
            setBusy(false);
        }
    };

    const locked = Boolean(editing?.invoicedInvoiceGuid) || Boolean(editing?.running);

    return (
        <Modal isOpen={open} onClose={onClose} title={editing ? 'Edit time entry' : 'New time entry'} size="md">
            <div
                className="p-6 space-y-4"
                onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !locked) {
                        e.preventDefault();
                        void save();
                    }
                }}
            >
                {locked && (
                    <p className="text-xs rounded-md border border-warning/40 bg-warning/10 text-warning px-3 py-2">
                        {editing?.invoicedInvoiceGuid
                            ? 'This entry has been invoiced and can no longer be edited.'
                            : 'This entry has a running timer — stop it before editing.'}
                    </p>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className={labelClass}>
                            Date <span className="text-foreground-muted normal-case">(+ next · − prev · t today)</span>
                        </label>
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => e.target.value && setDate(e.target.value)}
                            onKeyDown={handleDateKeyDown}
                            disabled={locked}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Project</label>
                        <ProjectSelect
                            projects={projects}
                            value={projectKey}
                            onChange={(key) => setProjectKey(key)}
                            disabled={locked}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                        <label className={labelClass}>Start</label>
                        <input
                            type="time" value={startTime}
                            onChange={(e) => setStartTime(e.target.value)}
                            disabled={locked}
                            className={`${inputClass} font-mono`} style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>End</label>
                        <input
                            type="time" value={endTime}
                            onChange={(e) => setEndTime(e.target.value)}
                            disabled={locked}
                            className={`${inputClass} font-mono`} style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Hours</label>
                        <input
                            type="text" value={hoursText}
                            onChange={(e) => setHoursText(e.target.value)}
                            disabled={locked}
                            placeholder="2.5 · 2:30 · 2h30m"
                            className={`${inputClass} font-mono ${invalidHours && hoursText.trim() !== '' ? 'border-negative/60' : ''}`}
                            style={TNUM}
                            autoFocus
                        />
                    </div>
                    {canSeeRates && (
                        <div>
                            <label className={labelClass}>Rate/h</label>
                            <input
                                type="number" min="0" step="0.01" value={rateText}
                                onChange={(e) => setRateText(e.target.value)}
                                disabled={locked}
                                placeholder="—"
                                className={`${inputClass} font-mono`} style={TNUM}
                            />
                        </div>
                    )}
                </div>

                <div>
                    <label className={labelClass}>Notes</label>
                    <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        disabled={locked}
                        rows={2}
                        placeholder="What was done?"
                        className={`${inputClass} resize-y`}
                    />
                </div>

                <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                    <input
                        type="checkbox" checked={billable}
                        onChange={(e) => setBillable(e.target.checked)}
                        disabled={locked}
                        className="accent-primary"
                    />
                    Billable
                </label>

                <div className="flex items-center justify-between pt-2 border-t border-border">
                    {editing && !locked ? (
                        <button
                            type="button" onClick={remove} disabled={busy}
                            className="px-3 py-2 text-sm rounded-md text-negative hover:bg-negative/10 transition-colors duration-150 disabled:opacity-50"
                        >
                            Delete
                        </button>
                    ) : <span />}
                    <div className="flex items-center gap-2">
                        <span className="hidden sm:inline text-[11px] text-foreground-muted">Ctrl+Enter to save</span>
                        <button
                            type="button" onClick={onClose}
                            className="px-3 py-2 text-sm rounded-md text-foreground-secondary hover:text-foreground transition-colors duration-150"
                        >
                            Cancel
                        </button>
                        <button
                            type="button" onClick={save} disabled={busy || locked}
                            className="px-4 py-2 text-sm rounded-md bg-primary hover:bg-primary-hover text-primary-foreground transition-colors duration-150 disabled:opacity-50"
                        >
                            {busy ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
