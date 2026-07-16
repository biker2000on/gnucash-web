'use client';

import { useCallback, useEffect, useState, Fragment } from 'react';
import Link from 'next/link';
import type { HomeTask, HomeItem, HomeServiceEntry, TaskStatus } from '@/lib/services/home.service';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { PersonalToolNotice } from '@/components/PersonalToolNotice';
import { useToast } from '@/contexts/ToastContext';
import { inputClass, labelClass, TNUM } from '@/components/home/home-shared';

const SEASON_OPTIONS = [
    { value: '', label: '—' },
    { value: 'spring', label: 'Spring' },
    { value: 'summer', label: 'Summer' },
    { value: 'fall', label: 'Fall' },
    { value: 'winter', label: 'Winter' },
    { value: 'spring+fall', label: 'Spring + Fall' },
];

const STATUS_GROUPS: Array<{ status: TaskStatus; label: string; tone: string }> = [
    { status: 'overdue', label: 'Overdue', tone: 'text-error' },
    { status: 'due_soon', label: 'Due soon (30 days)', tone: 'text-warning' },
    { status: 'later', label: 'Later', tone: 'text-foreground-muted' },
    { status: 'unscheduled', label: 'Unscheduled', tone: 'text-foreground-muted' },
];

interface TaskFormState {
    name: string;
    cadenceMonths: string;
    season: string;
    itemId: string;
    lastDone: string;
    notes: string;
}

function emptyTaskForm(): TaskFormState {
    return { name: '', cadenceMonths: '', season: '', itemId: '', lastDone: '', notes: '' };
}

function taskFormFrom(task: HomeTask): TaskFormState {
    return {
        name: task.name,
        cadenceMonths: task.cadenceMonths !== null ? String(task.cadenceMonths) : '',
        season: task.season ?? '',
        itemId: task.itemId !== null ? String(task.itemId) : '',
        lastDone: task.lastDone ?? '',
        notes: task.notes ?? '',
    };
}

function taskFormBody(form: TaskFormState): Record<string, unknown> {
    return {
        name: form.name.trim(),
        cadenceMonths: form.cadenceMonths === '' ? null : Number(form.cadenceMonths),
        season: form.season || null,
        itemId: form.itemId === '' ? null : Number(form.itemId),
        lastDone: form.lastDone || null,
        notes: form.notes || null,
    };
}

interface DoneFormState {
    date: string;
    cost: string;
    vendor: string;
    txnGuid: string;
    notes: string;
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

function cadenceLabel(task: HomeTask): string {
    const parts: string[] = [];
    if (task.cadenceMonths) parts.push(`every ${task.cadenceMonths} mo`);
    if (task.seasonLabel) parts.push(task.seasonLabel);
    return parts.join(' · ') || 'no schedule';
}

function dueLabel(task: HomeTask): string {
    if (!task.nextDue) return task.lastDone ? '—' : 'Never done';
    const d = task.daysUntilDue;
    if (d === null) return task.nextDue;
    if (d < 0) return `${task.nextDue} (${Math.abs(d)}d overdue)`;
    if (d === 0) return `${task.nextDue} (today)`;
    return `${task.nextDue} (in ${d}d)`;
}

type Panel = { taskId: number; kind: 'done' | 'history' | 'edit' } | null;

export default function HomeMaintenancePage() {
    const toast = useToast();
    const [tasks, setTasks] = useState<HomeTask[] | null>(null);
    const [items, setItems] = useState<HomeItem[]>([]);
    const [logEntries, setLogEntries] = useState<HomeServiceEntry[]>([]);
    const [ytdCost, setYtdCost] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [tab, setTab] = useState<'tasks' | 'log'>('tasks');
    const [panel, setPanel] = useState<Panel>(null);
    const [history, setHistory] = useState<Record<number, HomeServiceEntry[]>>({});
    const [saving, setSaving] = useState(false);

    const [seeding, setSeeding] = useState(false);
    const [addOpen, setAddOpen] = useState(false);
    const [addForm, setAddForm] = useState<TaskFormState>(emptyTaskForm());
    const [editForm, setEditForm] = useState<TaskFormState>(emptyTaskForm());
    const [doneForm, setDoneForm] = useState<DoneFormState>({
        date: today(),
        cost: '',
        vendor: '',
        txnGuid: '',
        notes: '',
    });
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

    // Standalone service-log entry form (log tab)
    const [logForm, setLogForm] = useState({
        date: today(),
        taskId: '',
        itemId: '',
        cost: '',
        vendor: '',
        txnGuid: '',
        notes: '',
    });
    const [confirmDeleteLogId, setConfirmDeleteLogId] = useState<number | null>(null);

    const load = useCallback(async () => {
        try {
            const [tasksRes, itemsRes, logRes] = await Promise.all([
                fetch('/api/home/tasks?includeInactive=true'),
                fetch('/api/home/items'),
                fetch('/api/home/service-log'),
            ]);
            if (!tasksRes.ok || !logRes.ok) throw new Error('Request failed');
            const tasksJson = (await tasksRes.json()) as { tasks: HomeTask[] };
            const logJson = (await logRes.json()) as {
                entries: HomeServiceEntry[];
                ytdCost: number;
            };
            setTasks(tasksJson.tasks);
            setLogEntries(logJson.entries);
            setYtdCost(logJson.ytdCost);
            if (itemsRes.ok) {
                const itemsJson = (await itemsRes.json()) as { items: HomeItem[] };
                setItems(itemsJson.items);
            }
            setHistory({});
            setError(null);
        } catch {
            setError('Failed to load maintenance tasks.');
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            await load();
            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [load]);

    const seedTemplate = async () => {
        setSeeding(true);
        try {
            const res = await fetch('/api/home/tasks/seed', { method: 'POST' });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Failed to seed template');
            }
            toast.success('Standard maintenance template added — edit anything to fit your home');
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to seed template');
        } finally {
            setSeeding(false);
        }
    };

    const openPanel = (taskId: number, kind: 'done' | 'history' | 'edit', task?: HomeTask) => {
        if (panel?.taskId === taskId && panel.kind === kind) {
            setPanel(null);
            return;
        }
        setPanel({ taskId, kind });
        setConfirmDeleteId(null);
        if (kind === 'done') {
            setDoneForm({ date: today(), cost: '', vendor: '', txnGuid: '', notes: '' });
        }
        if (kind === 'edit' && task) setEditForm(taskFormFrom(task));
        if (kind === 'history' && history[taskId] === undefined) {
            fetch(`/api/home/service-log?taskId=${taskId}`)
                .then((res) => (res.ok ? res.json() : null))
                .then((json) => {
                    if (json) setHistory((prev) => ({ ...prev, [taskId]: json.entries }));
                })
                .catch(() => {
                    /* history panel is best-effort */
                });
        }
    };

    const handleMarkDone = async (task: HomeTask) => {
        setSaving(true);
        try {
            const res = await fetch('/api/home/service-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskId: task.id,
                    itemId: task.itemId,
                    serviceDate: doneForm.date,
                    cost: doneForm.cost === '' ? null : Number(doneForm.cost),
                    vendor: doneForm.vendor || null,
                    txnGuid: doneForm.txnGuid || null,
                    notes: doneForm.notes || null,
                }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Failed to log service');
            }
            toast.success(`${task.name} marked done`);
            setPanel(null);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to log service');
        } finally {
            setSaving(false);
        }
    };

    const handleCreateTask = async () => {
        if (!addForm.name.trim()) {
            toast.error('Task name is required');
            return;
        }
        setSaving(true);
        try {
            const res = await fetch('/api/home/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(taskFormBody(addForm)),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Failed to create task');
            }
            toast.success('Task added');
            setAddForm(emptyTaskForm());
            setAddOpen(false);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create task');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveTask = async (task: HomeTask) => {
        if (!editForm.name.trim()) {
            toast.error('Task name is required');
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(`/api/home/tasks/${task.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(taskFormBody(editForm)),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Save failed');
            }
            toast.success('Task updated');
            setPanel(null);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update task');
        } finally {
            setSaving(false);
        }
    };

    const handleToggleActive = async (task: HomeTask) => {
        try {
            const res = await fetch(`/api/home/tasks/${task.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: !task.active }),
            });
            if (!res.ok) throw new Error('Failed');
            await load();
        } catch {
            toast.error('Failed to update task');
        }
    };

    const handleDeleteTask = async (id: number) => {
        try {
            const res = await fetch(`/api/home/tasks/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            toast.success('Task deleted');
            setConfirmDeleteId(null);
            await load();
        } catch {
            toast.error('Failed to delete task');
        }
    };

    const handleAddLogEntry = async () => {
        setSaving(true);
        try {
            const res = await fetch('/api/home/service-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    serviceDate: logForm.date,
                    taskId: logForm.taskId === '' ? null : Number(logForm.taskId),
                    itemId: logForm.itemId === '' ? null : Number(logForm.itemId),
                    cost: logForm.cost === '' ? null : Number(logForm.cost),
                    vendor: logForm.vendor || null,
                    txnGuid: logForm.txnGuid || null,
                    notes: logForm.notes || null,
                }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Failed to log service');
            }
            toast.success('Service logged');
            setLogForm({
                date: today(),
                taskId: '',
                itemId: '',
                cost: '',
                vendor: '',
                txnGuid: '',
                notes: '',
            });
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to log service');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteLogEntry = async (id: number) => {
        try {
            const res = await fetch(`/api/home/service-log/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            toast.success('Entry deleted');
            setConfirmDeleteLogId(null);
            await load();
        } catch {
            toast.error('Failed to delete entry');
        }
    };

    const activeTasks = (tasks ?? []).filter((t) => t.active);
    const inactiveTasks = (tasks ?? []).filter((t) => !t.active);

    const renderTaskForm = (
        form: TaskFormState,
        setForm: (f: TaskFormState) => void,
        onSubmit: () => void,
        onCancel: () => void,
        submitLabel: string,
    ) => (
        <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="sm:col-span-2">
                    <label className={labelClass}>Task name *</label>
                    <input
                        type="text"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="e.g. Replace HVAC filter"
                        className={inputClass}
                    />
                </div>
                <div>
                    <label className={labelClass}>Every N months</label>
                    <input
                        type="number"
                        min="1"
                        max="120"
                        value={form.cadenceMonths}
                        onChange={(e) => setForm({ ...form, cadenceMonths: e.target.value })}
                        placeholder="e.g. 3"
                        className={`${inputClass} font-mono`}
                        style={TNUM}
                    />
                </div>
                <div>
                    <label className={labelClass}>Season</label>
                    <select
                        value={form.season}
                        onChange={(e) => setForm({ ...form, season: e.target.value })}
                        className={inputClass}
                    >
                        {SEASON_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className={labelClass}>Linked item (optional)</label>
                    <select
                        value={form.itemId}
                        onChange={(e) => setForm({ ...form, itemId: e.target.value })}
                        className={inputClass}
                    >
                        <option value="">None</option>
                        {items.map((i) => (
                            <option key={i.id} value={String(i.id)}>
                                {i.name}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className={labelClass}>Last done</label>
                    <input
                        type="date"
                        value={form.lastDone}
                        onChange={(e) => setForm({ ...form, lastDone: e.target.value })}
                        className={`${inputClass} font-mono`}
                    />
                </div>
                <div className="sm:col-span-2">
                    <label className={labelClass}>Notes</label>
                    <input
                        type="text"
                        value={form.notes}
                        onChange={(e) => setForm({ ...form, notes: e.target.value })}
                        placeholder="Filter size, breaker location…"
                        className={inputClass}
                    />
                </div>
            </div>
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={onSubmit}
                    disabled={saving}
                    className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                >
                    {saving ? 'Saving…' : submitLabel}
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                >
                    Cancel
                </button>
            </div>
        </div>
    );

    const renderTaskRow = (task: HomeTask) => (
        <Fragment key={task.id}>
            <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/30 px-4 py-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                    <span className="text-sm text-foreground">{task.name}</span>
                    <span className="ml-3 text-xs text-foreground-muted">
                        {cadenceLabel(task)}
                        {task.itemName && ` · ${task.itemName}`}
                    </span>
                    {task.notes && (
                        <p className="mt-0.5 truncate text-xs text-foreground-muted">{task.notes}</p>
                    )}
                </div>
                <span className="font-mono text-xs text-foreground-secondary" style={TNUM}>
                    {task.lastDone ? `done ${task.lastDone}` : 'never done'}
                </span>
                <span
                    className={`font-mono text-xs ${
                        task.status === 'overdue'
                            ? 'text-error'
                            : task.status === 'due_soon'
                              ? 'text-warning'
                              : 'text-foreground-muted'
                    }`}
                    style={TNUM}
                >
                    {dueLabel(task)}
                </span>
                <div className="flex items-center gap-3 text-sm">
                    {task.active && (
                        <button
                            type="button"
                            onClick={() => openPanel(task.id, 'done')}
                            className="text-primary hover:text-primary-hover transition-colors"
                        >
                            Mark done
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => openPanel(task.id, 'history')}
                        className="text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        History
                    </button>
                    <button
                        type="button"
                        onClick={() => openPanel(task.id, 'edit', task)}
                        className="text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Edit
                    </button>
                    <button
                        type="button"
                        onClick={() => handleToggleActive(task)}
                        className="text-foreground-muted hover:text-foreground transition-colors"
                    >
                        {task.active ? 'Pause' : 'Resume'}
                    </button>
                    {confirmDeleteId === task.id ? (
                        <span className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => handleDeleteTask(task.id)}
                                className="font-medium text-error hover:opacity-80 transition-opacity"
                            >
                                Confirm
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="text-foreground-muted hover:text-foreground transition-colors"
                            >
                                Cancel
                            </button>
                        </span>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setConfirmDeleteId(task.id)}
                            className="text-foreground-muted hover:text-error transition-colors"
                        >
                            Delete
                        </button>
                    )}
                </div>
            </li>
            {panel?.taskId === task.id && (
                <li className="border-b border-border/30 bg-background-tertiary/30 px-4 py-3 last:border-b-0">
                    {panel.kind === 'done' && (
                        <div className="space-y-3">
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                                <div>
                                    <label className={labelClass}>Date</label>
                                    <input
                                        type="date"
                                        value={doneForm.date}
                                        onChange={(e) =>
                                            setDoneForm({ ...doneForm, date: e.target.value })
                                        }
                                        className={`${inputClass} font-mono`}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Cost (optional)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        inputMode="decimal"
                                        value={doneForm.cost}
                                        onChange={(e) =>
                                            setDoneForm({ ...doneForm, cost: e.target.value })
                                        }
                                        placeholder="0.00"
                                        className={`${inputClass} font-mono`}
                                        style={TNUM}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Vendor (optional)</label>
                                    <input
                                        type="text"
                                        value={doneForm.vendor}
                                        onChange={(e) =>
                                            setDoneForm({ ...doneForm, vendor: e.target.value })
                                        }
                                        className={inputClass}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>GnuCash txn GUID (optional)</label>
                                    <input
                                        type="text"
                                        value={doneForm.txnGuid}
                                        onChange={(e) =>
                                            setDoneForm({ ...doneForm, txnGuid: e.target.value })
                                        }
                                        placeholder="32-char guid"
                                        className={`${inputClass} font-mono`}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Notes</label>
                                    <input
                                        type="text"
                                        value={doneForm.notes}
                                        onChange={(e) =>
                                            setDoneForm({ ...doneForm, notes: e.target.value })
                                        }
                                        className={inputClass}
                                    />
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => handleMarkDone(task)}
                                    disabled={saving}
                                    className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                >
                                    {saving ? 'Saving…' : 'Log service'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPanel(null)}
                                    className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                    {panel.kind === 'history' &&
                        (history[task.id] === undefined ? (
                            <p className="text-sm text-foreground-muted">Loading history…</p>
                        ) : history[task.id].length === 0 ? (
                            <p className="text-sm text-foreground-muted">
                                No service history for this task yet.
                            </p>
                        ) : (
                            <ul className="space-y-1">
                                {history[task.id].map((entry) => (
                                    <li
                                        key={entry.id}
                                        className="flex flex-wrap items-center gap-x-4 text-sm"
                                    >
                                        <span className="font-mono text-foreground-secondary" style={TNUM}>
                                            {entry.serviceDate}
                                        </span>
                                        <span className="font-mono text-foreground-secondary" style={TNUM}>
                                            {entry.cost !== null ? formatCurrency(entry.cost) : '—'}
                                        </span>
                                        {entry.vendor && (
                                            <span className="text-foreground-secondary">{entry.vendor}</span>
                                        )}
                                        {entry.notes && (
                                            <span className="text-xs text-foreground-muted">{entry.notes}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ))}
                    {panel.kind === 'edit' &&
                        renderTaskForm(
                            editForm,
                            setEditForm,
                            () => handleSaveTask(task),
                            () => setPanel(null),
                            'Save',
                        )}
                </li>
            )}
        </Fragment>
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title="Home Maintenance"
                subtitle="Recurring and seasonal upkeep with a service log — so nothing quietly rusts, clogs, or burns out."
                actions={
                    <button
                        type="button"
                        onClick={() => setAddOpen((v) => !v)}
                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors"
                    >
                        Add task
                    </button>
                }
            />

            <PersonalToolNotice />

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

            {!loading && !error && tasks !== null && (
                <>
                    {/* Tabs */}
                    <div className="flex items-center gap-1 border-b border-border">
                        {(
                            [
                                { id: 'tasks', label: 'Tasks' },
                                { id: 'log', label: 'Service log' },
                            ] as const
                        ).map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTab(t.id)}
                                className={`border-b-2 px-3 py-2 text-sm transition-colors ${
                                    tab === t.id
                                        ? 'border-primary font-medium text-primary'
                                        : 'border-transparent text-foreground-secondary hover:text-foreground'
                                }`}
                            >
                                {t.label}
                            </button>
                        ))}
                        <Link
                            href="/home/inventory"
                            className="ml-auto pb-2 text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            Home inventory →
                        </Link>
                    </div>

                    {tab === 'tasks' && (
                        <>
                            {addOpen && (
                                <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
                                    {renderTaskForm(
                                        addForm,
                                        setAddForm,
                                        handleCreateTask,
                                        () => {
                                            setAddOpen(false);
                                            setAddForm(emptyTaskForm());
                                        },
                                        'Add task',
                                    )}
                                </div>
                            )}

                            {tasks.length === 0 && (
                                <div className="bg-background-secondary/30 border border-border rounded-xl p-6 space-y-3">
                                    <p className="text-sm text-foreground">
                                        No maintenance tasks yet. Start with the standard template —
                                        every task is editable afterwards:
                                    </p>
                                    <p className="text-sm text-foreground-secondary">
                                        HVAC filter (3mo) · smoke/CO detector test (6mo) + batteries
                                        (12mo) · gutters (spring + fall) · water heater flush (12mo) ·
                                        dryer vent (12mo) · refrigerator coils (12mo) · sump pump test
                                        (spring) · winterize outdoor faucets (fall) · HVAC service (12mo)
                                    </p>
                                    <button
                                        type="button"
                                        onClick={seedTemplate}
                                        disabled={seeding}
                                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                    >
                                        {seeding ? 'Adding…' : 'Seed standard template'}
                                    </button>
                                </div>
                            )}

                            {STATUS_GROUPS.map((group) => {
                                const groupTasks = activeTasks.filter((t) => t.status === group.status);
                                if (groupTasks.length === 0) return null;
                                return (
                                    <div
                                        key={group.status}
                                        className="bg-background-secondary/30 border border-border rounded-xl overflow-hidden"
                                    >
                                        <div
                                            className={`border-b border-border px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider ${group.tone}`}
                                        >
                                            {group.label}
                                            <span className="ml-2 font-mono" style={TNUM}>
                                                {groupTasks.length}
                                            </span>
                                        </div>
                                        <ul>{groupTasks.map(renderTaskRow)}</ul>
                                    </div>
                                );
                            })}

                            {inactiveTasks.length > 0 && (
                                <div className="bg-background-secondary/30 border border-border rounded-xl overflow-hidden opacity-70">
                                    <div className="border-b border-border px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                        Paused
                                        <span className="ml-2 font-mono" style={TNUM}>
                                            {inactiveTasks.length}
                                        </span>
                                    </div>
                                    <ul>{inactiveTasks.map(renderTaskRow)}</ul>
                                </div>
                            )}
                        </>
                    )}

                    {tab === 'log' && (
                        <>
                            <div className="bg-background-secondary/30 border border-border rounded-xl p-5">
                                <p className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                    Maintenance cost — year to date
                                </p>
                                <p
                                    className="mt-1 font-mono text-3xl font-semibold text-foreground"
                                    style={TNUM}
                                >
                                    {formatCurrency(ytdCost)}
                                </p>
                            </div>

                            {/* Add standalone entry */}
                            <div className="bg-background-secondary/30 border border-border rounded-xl p-4 space-y-3">
                                <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted">
                                    Log a service
                                </p>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                    <div>
                                        <label className={labelClass}>Date</label>
                                        <input
                                            type="date"
                                            value={logForm.date}
                                            onChange={(e) =>
                                                setLogForm({ ...logForm, date: e.target.value })
                                            }
                                            className={`${inputClass} font-mono`}
                                        />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Task (optional)</label>
                                        <select
                                            value={logForm.taskId}
                                            onChange={(e) =>
                                                setLogForm({ ...logForm, taskId: e.target.value })
                                            }
                                            className={inputClass}
                                        >
                                            <option value="">None</option>
                                            {(tasks ?? []).map((t) => (
                                                <option key={t.id} value={String(t.id)}>
                                                    {t.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className={labelClass}>Item (optional)</label>
                                        <select
                                            value={logForm.itemId}
                                            onChange={(e) =>
                                                setLogForm({ ...logForm, itemId: e.target.value })
                                            }
                                            className={inputClass}
                                        >
                                            <option value="">None</option>
                                            {items.map((i) => (
                                                <option key={i.id} value={String(i.id)}>
                                                    {i.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className={labelClass}>Cost</label>
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            inputMode="decimal"
                                            value={logForm.cost}
                                            onChange={(e) =>
                                                setLogForm({ ...logForm, cost: e.target.value })
                                            }
                                            placeholder="0.00"
                                            className={`${inputClass} font-mono`}
                                            style={TNUM}
                                        />
                                    </div>
                                    <div>
                                        <label className={labelClass}>Vendor</label>
                                        <input
                                            type="text"
                                            value={logForm.vendor}
                                            onChange={(e) =>
                                                setLogForm({ ...logForm, vendor: e.target.value })
                                            }
                                            className={inputClass}
                                        />
                                    </div>
                                    <div>
                                        <label className={labelClass}>GnuCash txn GUID</label>
                                        <input
                                            type="text"
                                            value={logForm.txnGuid}
                                            onChange={(e) =>
                                                setLogForm({ ...logForm, txnGuid: e.target.value })
                                            }
                                            placeholder="optional"
                                            className={`${inputClass} font-mono`}
                                        />
                                    </div>
                                    <div className="sm:col-span-2">
                                        <label className={labelClass}>Notes</label>
                                        <input
                                            type="text"
                                            value={logForm.notes}
                                            onChange={(e) =>
                                                setLogForm({ ...logForm, notes: e.target.value })
                                            }
                                            className={inputClass}
                                        />
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleAddLogEntry}
                                    disabled={saving}
                                    className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                >
                                    {saving ? 'Saving…' : 'Add entry'}
                                </button>
                            </div>

                            {logEntries.length === 0 ? (
                                <div className="bg-background-secondary/30 border border-border rounded-xl p-8 text-center">
                                    <p className="text-sm text-foreground-secondary">
                                        No service history yet. Marking a task done logs an entry here
                                        automatically.
                                    </p>
                                </div>
                            ) : (
                                <div className="bg-background-secondary/30 border border-border rounded-xl overflow-hidden">
                                    <ul>
                                        {logEntries.map((entry) => (
                                            <li
                                                key={entry.id}
                                                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/30 px-4 py-2.5 last:border-b-0"
                                            >
                                                <span
                                                    className="font-mono text-xs text-foreground-secondary"
                                                    style={TNUM}
                                                >
                                                    {entry.serviceDate}
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <span className="text-sm text-foreground">
                                                        {entry.taskName ?? entry.itemName ?? 'Service'}
                                                    </span>
                                                    <span className="ml-3 text-xs text-foreground-muted">
                                                        {[
                                                            entry.taskName && entry.itemName
                                                                ? entry.itemName
                                                                : null,
                                                            entry.vendor,
                                                            entry.txnGuid ? 'txn linked' : null,
                                                            entry.notes,
                                                        ]
                                                            .filter(Boolean)
                                                            .join(' · ')}
                                                    </span>
                                                </div>
                                                <span
                                                    className="font-mono text-sm text-foreground-secondary"
                                                    style={TNUM}
                                                >
                                                    {entry.cost !== null
                                                        ? formatCurrency(entry.cost)
                                                        : '—'}
                                                </span>
                                                {confirmDeleteLogId === entry.id ? (
                                                    <span className="flex items-center gap-2 text-sm">
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                handleDeleteLogEntry(entry.id)
                                                            }
                                                            className="font-medium text-error hover:opacity-80 transition-opacity"
                                                        >
                                                            Confirm
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setConfirmDeleteLogId(null)}
                                                            className="text-foreground-muted hover:text-foreground transition-colors"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </span>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={() => setConfirmDeleteLogId(entry.id)}
                                                        className="text-sm text-foreground-muted hover:text-error transition-colors"
                                                    >
                                                        Delete
                                                    </button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </>
                    )}
                </>
            )}
        </div>
    );
}
