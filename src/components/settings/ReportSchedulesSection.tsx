'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useToast } from '@/contexts/ToastContext';

/**
 * Settings → Report Schedules.
 *
 * Lists the current user's report email schedules for the active book with
 * enable toggle, run-now, and an inline add/edit form. Reports can target a
 * saved report configuration or one of the standard schedulable types.
 *
 * Self-contained: mount anywhere inside the settings page.
 */

interface ScheduleItem {
    id: number;
    savedReportId: number | null;
    baseReportType: string | null;
    config: Record<string, unknown>;
    cadence: 'weekly' | 'monthly' | 'quarterly';
    anchorDay: number;
    recipients: string | null;
    enabled: boolean;
    lastRunAt: string | null;
    lastRunPeriod: string | null;
}

interface ReportTypeOption {
    type: string;
    label: string;
}

interface SavedReportItem {
    id: number;
    name: string;
    baseReportType: string;
}

interface FormState {
    /** 'saved:<id>' or 'base:<type>' */
    reportKey: string;
    cadence: 'weekly' | 'monthly' | 'quarterly';
    anchorDay: number;
    recipients: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DEFAULT_FORM: FormState = {
    reportKey: 'base:balance_sheet',
    cadence: 'monthly',
    anchorDay: 1,
    recipients: '',
};

function cadenceSummary(item: ScheduleItem): string {
    if (item.cadence === 'weekly') {
        return `Weekly · ${WEEKDAYS[item.anchorDay] ?? `day ${item.anchorDay}`}`;
    }
    if (item.cadence === 'monthly') {
        return `Monthly · day ${item.anchorDay}`;
    }
    return `Quarterly · day ${item.anchorDay}`;
}

export function ReportSchedulesSection() {
    const { success, error } = useToast();
    const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
    const [reportTypes, setReportTypes] = useState<ReportTypeOption[]>([]);
    const [savedReports, setSavedReports] = useState<SavedReportItem[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [runningId, setRunningId] = useState<number | null>(null);
    const [formOpen, setFormOpen] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [form, setForm] = useState<FormState>(DEFAULT_FORM);

    const schedulableTypes = useMemo(
        () => new Set(reportTypes.map(t => t.type)),
        [reportTypes],
    );

    const typeLabel = useCallback(
        (type: string | null) => reportTypes.find(t => t.type === type)?.label ?? type ?? 'Report',
        [reportTypes],
    );

    const refresh = useCallback(() => {
        Promise.all([
            fetch('/api/settings/report-schedules').then(r => (r.ok ? r.json() : null)),
            fetch('/api/reports/saved').then(r => (r.ok ? r.json() : null)),
        ])
            .then(([schedulesData, savedData]) => {
                setSchedules(schedulesData?.schedules ?? []);
                setReportTypes(schedulesData?.reportTypes ?? []);
                setSavedReports(
                    Array.isArray(savedData)
                        ? savedData.map((r: { id: number; name: string; baseReportType: string }) => ({
                            id: r.id,
                            name: r.name,
                            baseReportType: r.baseReportType,
                        }))
                        : [],
                );
            })
            .catch(() => undefined)
            .finally(() => setLoaded(true));
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const reportLabel = useCallback(
        (item: ScheduleItem): string => {
            if (item.savedReportId != null) {
                const saved = savedReports.find(r => r.id === item.savedReportId);
                return saved ? saved.name : `Saved report #${item.savedReportId}`;
            }
            return typeLabel(item.baseReportType);
        },
        [savedReports, typeLabel],
    );

    const openCreate = () => {
        setEditingId(null);
        setForm(DEFAULT_FORM);
        setFormOpen(true);
    };

    const openEdit = (item: ScheduleItem) => {
        setEditingId(item.id);
        setForm({
            reportKey: item.savedReportId != null
                ? `saved:${item.savedReportId}`
                : `base:${item.baseReportType ?? 'balance_sheet'}`,
            cadence: item.cadence,
            anchorDay: item.anchorDay,
            recipients: item.recipients ?? '',
        });
        setFormOpen(true);
    };

    const submit = async () => {
        const [kind, value] = form.reportKey.split(':');
        const payload: Record<string, unknown> = {
            savedReportId: kind === 'saved' ? Number(value) : null,
            baseReportType: kind === 'base' ? value : null,
            cadence: form.cadence,
            anchorDay: form.anchorDay,
            recipients: form.recipients.trim() || null,
        };

        setSaving(true);
        try {
            const res = editingId != null
                ? await fetch(`/api/settings/report-schedules/${editingId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                : await fetch('/api/settings/report-schedules', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || 'Request failed');
            }
            success(editingId != null ? 'Schedule updated' : 'Schedule created');
            setFormOpen(false);
            setEditingId(null);
            refresh();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Failed to save schedule');
        } finally {
            setSaving(false);
        }
    };

    const toggleEnabled = async (item: ScheduleItem) => {
        try {
            const res = await fetch(`/api/settings/report-schedules/${item.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !item.enabled }),
            });
            if (!res.ok) throw new Error();
            setSchedules(prev => prev.map(s => (s.id === item.id ? { ...s, enabled: !item.enabled } : s)));
        } catch {
            error('Failed to update schedule');
        }
    };

    const runNow = async (item: ScheduleItem) => {
        setRunningId(item.id);
        try {
            const res = await fetch(`/api/settings/report-schedules/${item.id}`, { method: 'POST' });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error || 'Run failed');
            const result = body?.result;
            if (result?.status === 'sent') {
                success(`Report sent to ${result.recipients?.join(', ') || 'recipients'}`);
            } else {
                error(`Run ${result?.status ?? 'failed'}${result?.detail ? `: ${result.detail}` : ''}`);
            }
            refresh();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Failed to run schedule');
        } finally {
            setRunningId(null);
        }
    };

    const remove = async (item: ScheduleItem) => {
        try {
            const res = await fetch(`/api/settings/report-schedules/${item.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            setSchedules(prev => prev.filter(s => s.id !== item.id));
            success('Schedule deleted');
        } catch {
            error('Failed to delete schedule');
        }
    };

    const schedulableSaved = savedReports.filter(r => schedulableTypes.has(r.baseReportType));
    const enabledCount = schedules.filter(s => s.enabled).length;

    return (
        <CollapsibleConfigSection
            title="Report Schedules"
            summary={schedules.length > 0 ? `${enabledCount} of ${schedules.length} active` : 'Email reports on a schedule'}
            configured={schedules.length > 0}
            storageKey="settings.reportSchedulesOpen"
        >
            <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <p className="text-sm text-foreground-muted">
                        Email reports weekly, monthly, or quarterly. Schedules run daily in the background
                        and each report covers the period just ended (last week, month, or quarter). A CSV
                        export is included in every email. Requires SMTP to be configured.
                    </p>
                    <button
                        onClick={openCreate}
                        className="inline-flex items-center justify-center px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors shrink-0"
                    >
                        Add schedule
                    </button>
                </div>

                {formOpen && (
                    <div className="border border-border rounded-lg p-4 space-y-3 bg-background-secondary/30">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <label className="block text-sm">
                                <span className="text-foreground-secondary">Report</span>
                                <select
                                    value={form.reportKey}
                                    onChange={e => setForm(f => ({ ...f, reportKey: e.target.value }))}
                                    className="mt-1 w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground"
                                >
                                    {schedulableSaved.length > 0 && (
                                        <optgroup label="Saved reports">
                                            {schedulableSaved.map(r => (
                                                <option key={`saved-${r.id}`} value={`saved:${r.id}`}>
                                                    {r.name}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                    <optgroup label="Standard reports">
                                        {reportTypes.map(t => (
                                            <option key={`base-${t.type}`} value={`base:${t.type}`}>
                                                {t.label}
                                            </option>
                                        ))}
                                    </optgroup>
                                </select>
                            </label>

                            <label className="block text-sm">
                                <span className="text-foreground-secondary">Cadence</span>
                                <select
                                    value={form.cadence}
                                    onChange={e => {
                                        const cadence = e.target.value as FormState['cadence'];
                                        setForm(f => ({
                                            ...f,
                                            cadence,
                                            anchorDay: cadence === 'weekly'
                                                ? Math.min(6, Math.max(0, f.anchorDay))
                                                : Math.min(28, Math.max(1, f.anchorDay)),
                                        }));
                                    }}
                                    className="mt-1 w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground"
                                >
                                    <option value="weekly">Weekly</option>
                                    <option value="monthly">Monthly</option>
                                    <option value="quarterly">Quarterly</option>
                                </select>
                            </label>

                            <label className="block text-sm">
                                <span className="text-foreground-secondary">
                                    {form.cadence === 'weekly' ? 'Day of week' : 'Day of month (1–28)'}
                                </span>
                                {form.cadence === 'weekly' ? (
                                    <select
                                        value={form.anchorDay}
                                        onChange={e => setForm(f => ({ ...f, anchorDay: Number(e.target.value) }))}
                                        className="mt-1 w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground"
                                    >
                                        {WEEKDAYS.map((day, i) => (
                                            <option key={day} value={i}>{day}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        type="number"
                                        min={1}
                                        max={28}
                                        value={form.anchorDay}
                                        onChange={e => setForm(f => ({ ...f, anchorDay: Number(e.target.value) }))}
                                        className="mt-1 w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground"
                                    />
                                )}
                            </label>

                            <label className="block text-sm">
                                <span className="text-foreground-secondary">Recipients (comma-separated)</span>
                                <input
                                    type="text"
                                    value={form.recipients}
                                    onChange={e => setForm(f => ({ ...f, recipients: e.target.value }))}
                                    placeholder="Defaults to your account email"
                                    className="mt-1 w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-foreground-tertiary"
                                />
                            </label>
                        </div>

                        <div className="flex items-center gap-2 justify-end">
                            <button
                                onClick={() => { setFormOpen(false); setEditingId(null); }}
                                className="px-3 py-1.5 rounded-lg border border-border text-sm text-foreground-secondary hover:text-foreground transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={submit}
                                disabled={saving}
                                className="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-primary-foreground text-sm transition-colors disabled:opacity-50"
                            >
                                {saving ? 'Saving…' : editingId != null ? 'Save changes' : 'Create schedule'}
                            </button>
                        </div>
                    </div>
                )}

                {!loaded ? (
                    <p className="text-sm text-foreground-tertiary">Loading…</p>
                ) : schedules.length === 0 ? (
                    <p className="text-sm text-foreground-tertiary">No report schedules yet.</p>
                ) : (
                    <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
                        {schedules.map(item => (
                            <div key={item.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-3 py-2 text-sm">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className={`font-medium truncate ${item.enabled ? 'text-foreground' : 'text-foreground-tertiary line-through'}`}>
                                            {reportLabel(item)}
                                        </span>
                                        {item.savedReportId != null && (
                                            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">saved</span>
                                        )}
                                    </div>
                                    <div className="text-xs text-foreground-tertiary mt-0.5">
                                        {cadenceSummary(item)}
                                        {' · '}
                                        {item.recipients || 'your email'}
                                        {' · '}
                                        {item.lastRunAt
                                            ? `last sent ${new Date(item.lastRunAt).toLocaleDateString()}`
                                            : 'never sent'}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <button
                                        onClick={() => toggleEnabled(item)}
                                        role="switch"
                                        aria-checked={item.enabled}
                                        aria-label={`${item.enabled ? 'Disable' : 'Enable'} schedule`}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${item.enabled ? 'bg-primary' : 'bg-border'}`}
                                    >
                                        <span
                                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${item.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}`}
                                        />
                                    </button>
                                    <button
                                        onClick={() => runNow(item)}
                                        disabled={runningId === item.id}
                                        className="px-2.5 py-1 rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors text-xs disabled:opacity-50"
                                    >
                                        {runningId === item.id ? 'Sending…' : 'Run now'}
                                    </button>
                                    <button
                                        onClick={() => openEdit(item)}
                                        className="px-2.5 py-1 rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors text-xs"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        onClick={() => remove(item)}
                                        className="px-2.5 py-1 rounded-md border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 transition-colors text-xs"
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </CollapsibleConfigSection>
    );
}
