'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { PersonalToolNotice } from '@/components/PersonalToolNotice';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';

/* ------------------------------------------------------------------ */
/* API payload types                                                   */
/* ------------------------------------------------------------------ */

interface Renewal {
    id: number;
    name: string;
    renewalDate: string;
    amount: number | null;
    cadenceMonths: number;
    remindDays: number;
    source: string;
    notes: string | null;
    dismissedUntil: string | null;
}

interface ImportResult {
    imported: Renewal[];
    skippedExisting: number;
    candidates: number;
}

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

function daysUntil(dateIso: string, today: string): number {
    const target = Date.UTC(Number(dateIso.slice(0, 4)), Number(dateIso.slice(5, 7)) - 1, Number(dateIso.slice(8, 10)));
    const base = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
    return Math.round((target - base) / 86_400_000);
}

function cadenceLabel(months: number): string {
    if (months === 1) return 'Monthly';
    if (months === 3) return 'Quarterly';
    if (months === 6) return 'Semi-annual';
    if (months === 12) return 'Annual';
    if (months === 24) return 'Every 2 years';
    if (months % 12 === 0) return `Every ${months / 12} years`;
    return `Every ${months} months`;
}

/* ------------------------------------------------------------------ */
/* Editor form state                                                   */
/* ------------------------------------------------------------------ */

interface RenewalDraft {
    name: string;
    renewalDate: string;
    amount: string;
    cadenceMonths: string;
    remindDays: string;
    notes: string;
}

const EMPTY_DRAFT: RenewalDraft = {
    name: '',
    renewalDate: '',
    amount: '',
    cadenceMonths: '12',
    remindDays: '30',
    notes: '',
};

function draftFromRenewal(r: Renewal): RenewalDraft {
    return {
        name: r.name,
        renewalDate: r.renewalDate,
        amount: r.amount != null ? String(r.amount) : '',
        cadenceMonths: String(r.cadenceMonths),
        remindDays: String(r.remindDays),
        notes: r.notes ?? '',
    };
}

/* ------------------------------------------------------------------ */
/* Days-until chip                                                     */
/* ------------------------------------------------------------------ */

function DaysChip({ days }: { days: number }) {
    let cls = 'border-border text-foreground-secondary';
    let label: string;
    if (days < 0) {
        cls = 'border-error/40 bg-error/10 text-error';
        label = `${Math.abs(days)}d overdue`;
    } else if (days === 0) {
        cls = 'border-error/40 bg-error/10 text-error';
        label = 'today';
    } else if (days <= 14) {
        cls = 'border-warning/40 bg-warning/10 text-warning';
        label = `in ${days}d`;
    } else {
        label = `in ${days}d`;
    }
    return (
        <span className={`inline-block text-[11px] font-mono px-2 py-0.5 rounded-full border ${cls}`} style={TNUM}>
            {label}
        </span>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function RenewalsPage() {
    const toast = useToast();
    const [renewals, setRenewals] = useState<Renewal[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState<Renewal | null>(null);
    const [draft, setDraft] = useState<RenewalDraft>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [importing, setImporting] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [dismissingId, setDismissingId] = useState<number | null>(null);
    const [dismissDate, setDismissDate] = useState('');

    const today = todayIso();

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/tools/renewals');
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error ?? 'Failed to load renewals');
            }
            const payload = (await res.json()) as { renewals: Renewal[] };
            setRenewals(payload.renewals);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const sorted = useMemo(
        () => [...renewals].sort((a, b) => a.renewalDate.localeCompare(b.renewalDate)),
        [renewals],
    );
    const dueSoonCount = useMemo(
        () => sorted.filter(r => daysUntil(r.renewalDate, today) <= 14).length,
        [sorted, today],
    );

    const openCreate = () => {
        setEditing(null);
        setDraft({ ...EMPTY_DRAFT, renewalDate: today });
        setEditorOpen(true);
    };

    const openEdit = (r: Renewal) => {
        setEditing(r);
        setDraft(draftFromRenewal(r));
        setEditorOpen(true);
    };

    const save = async () => {
        if (draft.name.trim() === '') { toast.error('Give the renewal a name'); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.renewalDate)) { toast.error('Pick a renewal date'); return; }
        setSaving(true);
        try {
            const body = {
                name: draft.name.trim(),
                renewalDate: draft.renewalDate,
                amount: draft.amount.trim() === '' ? null : parseFloat(draft.amount),
                cadenceMonths: parseInt(draft.cadenceMonths, 10) || 12,
                remindDays: parseInt(draft.remindDays, 10) || 0,
                notes: draft.notes.trim() || null,
            };
            const res = await fetch(
                editing ? `/api/tools/renewals/${editing.id}` : '/api/tools/renewals',
                {
                    method: editing ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Failed to save renewal');
            }
            toast.success(editing ? 'Renewal updated' : 'Renewal added');
            setEditorOpen(false);
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save renewal');
        } finally {
            setSaving(false);
        }
    };

    const markRenewed = async (r: Renewal) => {
        setBusyId(r.id);
        try {
            const res = await fetch(`/api/tools/renewals/${r.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'renew' }),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Failed to mark renewed');
            }
            const updated = (await res.json()) as Renewal;
            setRenewals(prev => prev.map(x => (x.id === r.id ? updated : x)));
            toast.success(`${r.name} — next renewal ${updated.renewalDate}`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to mark renewed');
        } finally {
            setBusyId(null);
        }
    };

    const startDismiss = (r: Renewal) => {
        setDismissingId(r.id);
        // Default: suppress reminders through this cycle's renewal date.
        setDismissDate(r.renewalDate >= today ? r.renewalDate : today);
    };

    const confirmDismiss = async (r: Renewal) => {
        setBusyId(r.id);
        try {
            const res = await fetch(`/api/tools/renewals/${r.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'dismiss', until: dismissDate }),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Failed to dismiss');
            }
            const updated = (await res.json()) as Renewal;
            setRenewals(prev => prev.map(x => (x.id === r.id ? updated : x)));
            setDismissingId(null);
            toast.success(`Reminders paused until ${updated.dismissedUntil}`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to dismiss');
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (r: Renewal) => {
        if (!window.confirm(`Delete "${r.name}" from the renewals tracker?`)) return;
        setBusyId(r.id);
        try {
            const res = await fetch(`/api/tools/renewals/${r.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Failed to delete');
            }
            setRenewals(prev => prev.filter(x => x.id !== r.id));
            toast.success('Renewal deleted');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete');
        } finally {
            setBusyId(null);
        }
    };

    const importFromSubscriptions = async () => {
        setImporting(true);
        try {
            const res = await fetch('/api/tools/renewals/import', { method: 'POST' });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                throw new Error(payload?.error ?? 'Import failed');
            }
            const result = (await res.json()) as ImportResult;
            if (result.imported.length > 0) {
                toast.success(
                    `Imported ${result.imported.length} renewal${result.imported.length === 1 ? '' : 's'}` +
                    (result.skippedExisting > 0 ? ` (${result.skippedExisting} already tracked)` : ''),
                );
            } else if (result.candidates === 0) {
                toast.success('No recurring charges detected to import');
            } else {
                toast.success(`All ${result.candidates} detected series are already tracked`);
            }
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setImporting(false);
        }
    };

    return (
        <div className="space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Renewals &amp; Contracts</h1>
                    <p className="text-foreground-muted mt-1">
                        Insurance, registrations, domains, and contracts — with reminders before they auto-renew.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={importFromSubscriptions}
                        disabled={importing || loading}
                        className="px-4 py-2 border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover text-sm rounded-lg transition-colors disabled:opacity-50"
                    >
                        {importing ? 'Importing…' : 'Pull from subscriptions'}
                    </button>
                    <button
                        type="button"
                        onClick={openCreate}
                        className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors"
                    >
                        Add renewal
                    </button>
                </div>
            </header>

            <PersonalToolNotice />

            {loading && (
                <section className="bg-surface/30 border border-border rounded-xl p-6 animate-pulse">
                    <div className="h-4 bg-foreground-muted/20 rounded w-48 mb-3" />
                    <div className="h-4 bg-foreground-muted/20 rounded w-72" />
                </section>
            )}

            {!loading && error && (
                <section className="bg-surface/30 border border-error/30 rounded-xl p-6">
                    <p className="text-sm text-error">{error}</p>
                </section>
            )}

            {!loading && !error && (
                <section className="bg-surface/30 border border-border rounded-xl p-6">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-sm font-semibold text-foreground">Upcoming</h2>
                        {dueSoonCount > 0 && (
                            <span className="text-xs text-warning">
                                {dueSoonCount} due within 14 days
                            </span>
                        )}
                    </div>

                    {sorted.length === 0 ? (
                        <p className="text-sm text-foreground-muted py-6 text-center">
                            Nothing tracked yet. Add renewals by hand or pull detected recurring charges
                            from the subscriptions tool.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {sorted.map(r => {
                                const days = daysUntil(r.renewalDate, today);
                                const dismissed = r.dismissedUntil != null && r.dismissedUntil >= today;
                                return (
                                    <div key={r.id} className="border border-border rounded-lg p-3">
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div className="min-w-0 flex items-center gap-3">
                                                <DaysChip days={days} />
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-medium text-foreground truncate">{r.name}</span>
                                                        {r.source === 'subscription' && (
                                                            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-secondary/40 text-secondary bg-secondary-light">
                                                                Subscription
                                                            </span>
                                                        )}
                                                        {dismissed && (
                                                            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border text-foreground-muted">
                                                                Muted until {r.dismissedUntil}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-xs text-foreground-muted mt-0.5">
                                                        <span className="font-mono" style={TNUM}>{r.renewalDate}</span>
                                                        {' · '}{cadenceLabel(r.cadenceMonths)}
                                                        {r.amount != null && <> · <span className="font-mono text-foreground-secondary" style={TNUM}>{formatCurrency(r.amount)}</span></>}
                                                        {' · '}remind {r.remindDays}d ahead
                                                        {r.notes && <> · {r.notes}</>}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                {dismissingId === r.id ? (
                                                    <>
                                                        <input
                                                            type="date"
                                                            value={dismissDate}
                                                            min={today}
                                                            onChange={e => setDismissDate(e.target.value)}
                                                            className="bg-input-bg border border-border rounded-lg py-1.5 px-2 text-xs text-foreground font-mono focus:outline-none focus:border-primary/50"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => confirmDismiss(r)}
                                                            disabled={busyId === r.id || !dismissDate}
                                                            className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                                                        >
                                                            Mute
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setDismissingId(null)}
                                                            className="px-2 py-1.5 text-xs text-foreground-muted hover:text-foreground transition-colors"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <button
                                                            type="button"
                                                            onClick={() => markRenewed(r)}
                                                            disabled={busyId === r.id}
                                                            className="px-3 py-1.5 text-xs border border-primary/40 text-primary hover:bg-primary-light rounded-lg transition-colors disabled:opacity-50"
                                                        >
                                                            Renewed
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => startDismiss(r)}
                                                            className="px-3 py-1.5 text-xs border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover rounded-lg transition-colors"
                                                        >
                                                            Dismiss
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => openEdit(r)}
                                                            className="px-3 py-1.5 text-xs border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover rounded-lg transition-colors"
                                                        >
                                                            Edit
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => remove(r)}
                                                            disabled={busyId === r.id}
                                                            className="px-3 py-1.5 text-xs border border-error/30 text-error hover:bg-error/10 rounded-lg transition-colors disabled:opacity-50"
                                                        >
                                                            Delete
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <p className="text-xs text-foreground-muted mt-4">
                        &quot;Renewed&quot; moves the date forward by the cadence; &quot;Dismiss&quot; mutes reminders
                        through a date without moving it. Daily reminders arrive within each item&apos;s lead time.
                        Keep policy documents and contracts in{' '}
                        <Link href="/business/documents" className="text-primary hover:text-primary-hover underline underline-offset-2">
                            Household Documents
                        </Link>.
                    </p>
                </section>
            )}

            {/* Add/Edit modal */}
            <Modal
                isOpen={editorOpen}
                onClose={() => setEditorOpen(false)}
                title={editing ? 'Edit renewal' : 'Add renewal'}
                size="md"
            >
                <div className="p-6 space-y-4">
                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Name</label>
                        <input
                            type="text"
                            value={draft.name}
                            onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                            placeholder="Auto insurance — Honda"
                            className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Next renewal date</label>
                            <input
                                type="date"
                                value={draft.renewalDate}
                                onChange={e => setDraft(prev => ({ ...prev, renewalDate: e.target.value }))}
                                className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50"
                            />
                        </div>
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Amount (optional)</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={draft.amount}
                                onChange={e => setDraft(prev => ({ ...prev, amount: e.target.value }))}
                                placeholder="0.00"
                                className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50"
                                style={TNUM}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Cadence</label>
                            <select
                                value={draft.cadenceMonths}
                                onChange={e => setDraft(prev => ({ ...prev, cadenceMonths: e.target.value }))}
                                className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:border-primary/50"
                            >
                                <option value="1">Monthly</option>
                                <option value="3">Quarterly</option>
                                <option value="6">Semi-annual</option>
                                <option value="12">Annual</option>
                                <option value="24">Every 2 years</option>
                                <option value="36">Every 3 years</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Remind days ahead</label>
                            <input
                                type="number"
                                min="0"
                                max="365"
                                value={draft.remindDays}
                                onChange={e => setDraft(prev => ({ ...prev, remindDays: e.target.value }))}
                                className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50"
                                style={TNUM}
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">Notes</label>
                        <textarea
                            value={draft.notes}
                            onChange={e => setDraft(prev => ({ ...prev, notes: e.target.value }))}
                            rows={2}
                            placeholder="Policy number, agent contact, cancellation deadline…"
                            className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>

                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditorOpen(false)}
                            className="px-4 py-2 border border-border text-foreground-secondary hover:text-foreground text-sm rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={save}
                            disabled={saving}
                            className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors disabled:opacity-50"
                        >
                            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add renewal'}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
