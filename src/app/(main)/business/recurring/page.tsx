'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import {
    type RecurringInvoiceDef,
    type Cadence,
    CADENCE_OPTIONS,
    cadenceToPattern,
    patternToCadence,
    cadenceLabel,
} from '@/components/business/recurring-ui';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

interface EditForm {
    name: string;
    cadence: Cadence;
    every: string;
    nextDate: string;
    autoPost: boolean;
    active: boolean;
}

export default function RecurringInvoicesPage() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [defs, setDefs] = useState<RecurringInvoiceDef[]>([]);
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState<number | 'all' | null>(null);
    const [editing, setEditing] = useState<RecurringInvoiceDef | null>(null);
    const [form, setForm] = useState<EditForm | null>(null);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState<RecurringInvoiceDef | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchDefs = useCallback(async () => {
        try {
            const res = await fetch('/api/business/recurring-invoices');
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load recurring invoices');
            setDefs(data.definitions ?? []);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load recurring invoices');
        } finally {
            setLoading(false);
        }
    }, [error]);

    useEffect(() => { fetchDefs(); }, [fetchDefs]);

    const todayIso = () => new Date().toISOString().slice(0, 10);
    const dueCount = defs.filter((d) => d.active && d.nextDate <= todayIso()).length;

    const handleRun = async (def?: RecurringInvoiceDef) => {
        setRunning(def ? def.id : 'all');
        try {
            const res = await fetch('/api/business/recurring-invoices/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(def ? { id: def.id } : {}),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Run failed');
            const failed = (data.results ?? []).filter((r: { error?: string }) => r.error);
            if (data.generated > 0) {
                success(`Generated ${data.generated} document${data.generated === 1 ? '' : 's'}`);
            } else if (failed.length === 0) {
                success('Nothing due — no documents generated');
            }
            if (failed.length > 0) {
                error(`${failed[0].name}: ${failed[0].error}`);
            }
            await fetchDefs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Run failed');
        } finally {
            setRunning(null);
        }
    };

    const handleToggleActive = async (def: RecurringInvoiceDef) => {
        try {
            const res = await fetch(`/api/business/recurring-invoices/${def.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: !def.active }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to update');
            success(def.active ? `Paused "${def.name}"` : `Activated "${def.name}"`);
            await fetchDefs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update');
        }
    };

    const openEdit = (def: RecurringInvoiceDef) => {
        const { cadence, every } = patternToCadence(def.periodType, def.mult);
        setForm({
            name: def.name,
            cadence,
            every: String(every),
            nextDate: def.nextDate,
            autoPost: def.autoPost,
            active: def.active,
        });
        setEditing(def);
    };

    const handleSave = async () => {
        if (!editing || !form) return;
        if (!form.name.trim()) {
            error('Name is required');
            return;
        }
        const every = parseInt(form.every, 10);
        if (!Number.isInteger(every) || every < 1) {
            error('Interval must be a positive whole number');
            return;
        }
        if (!form.nextDate) {
            error('Next date is required');
            return;
        }
        setSaving(true);
        try {
            const { periodType, mult } = cadenceToPattern(form.cadence, every);
            const res = await fetch(`/api/business/recurring-invoices/${editing.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: form.name.trim(),
                    periodType,
                    mult,
                    nextDate: form.nextDate,
                    autoPost: form.autoPost,
                    active: form.active,
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to save');
            success('Recurring invoice saved');
            setEditing(null);
            setForm(null);
            await fetchDefs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/business/recurring-invoices/${deleting.id}`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to delete');
            success(`Deleted "${deleting.name}"`);
            setDeleting(null);
            await fetchDefs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="space-y-4">
            <PageHeader
                title="Recurring Invoices"
                subtitle="Invoice and bill templates generated on a schedule."
                actions={
                    <button
                        type="button"
                        onClick={() => handleRun()}
                        disabled={isReadonly || running !== null || dueCount === 0}
                        title={isReadonly ? READONLY_TOOLTIP : dueCount === 0 ? 'Nothing is due' : undefined}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        {running === 'all' ? 'Running...' : `Run due now${dueCount > 0 ? ` (${dueCount})` : ''}`}
                    </button>
                }
            />

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading recurring invoices...</span>
                    </div>
                ) : defs.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No recurring invoices yet. Open an{' '}
                        <Link href="/business/invoices" className="text-primary hover:text-primary-hover">invoice or bill</Link>
                        {' '}and choose &ldquo;Make recurring...&rdquo; to create one.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Name</th>
                                    <th className="px-4 py-2 font-semibold">Owner</th>
                                    <th className="px-4 py-2 font-semibold">Type</th>
                                    <th className="px-4 py-2 font-semibold">Cadence</th>
                                    <th className="px-4 py-2 font-semibold">Next date</th>
                                    <th className="px-4 py-2 font-semibold">Last run</th>
                                    <th className="px-4 py-2 font-semibold">Posting</th>
                                    <th className="px-4 py-2 font-semibold">Status</th>
                                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {defs.map((def) => {
                                    const due = def.active && def.nextDate <= todayIso();
                                    return (
                                        <tr key={def.id} className="hover:bg-surface-hover/50 transition-colors">
                                            <td className="px-4 py-2 text-foreground max-w-xs truncate">{def.name}</td>
                                            <td className="px-4 py-2 text-foreground-secondary max-w-xs truncate">
                                                {def.ownerName ?? def.ownerGuid.slice(0, 8)}
                                            </td>
                                            <td className="px-4 py-2 text-foreground-secondary">
                                                {def.ownerType === 'customer' ? 'Invoice' : 'Bill'}
                                            </td>
                                            <td className="px-4 py-2 text-foreground-secondary">
                                                {cadenceLabel(def.periodType, def.mult)}
                                            </td>
                                            <td className={`px-4 py-2 font-mono tabular-nums ${due ? 'text-warning' : 'text-foreground-secondary'}`} style={TNUM}>
                                                {def.nextDate}
                                            </td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-foreground-muted" style={TNUM}>
                                                {def.lastRun ?? '—'}
                                            </td>
                                            <td className="px-4 py-2">
                                                {def.autoPost ? (
                                                    <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-secondary-light text-secondary">Auto-post</span>
                                                ) : (
                                                    <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-surface-hover text-foreground-muted">Draft</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-2">
                                                <button
                                                    type="button"
                                                    onClick={() => handleToggleActive(def)}
                                                    disabled={isReadonly}
                                                    title={isReadonly ? READONLY_TOOLTIP : def.active ? 'Pause this schedule' : 'Resume this schedule'}
                                                    className={`inline-block px-2 py-0.5 text-xs rounded-md transition-colors disabled:opacity-50 ${
                                                        def.active
                                                            ? 'bg-positive/10 text-positive hover:bg-positive/20'
                                                            : 'bg-surface-hover text-foreground-muted hover:text-foreground'
                                                    }`}
                                                >
                                                    {def.active ? 'Active' : 'Paused'}
                                                </button>
                                            </td>
                                            <td className="px-4 py-2 text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRun(def)}
                                                        disabled={isReadonly || running !== null || !def.active || !due}
                                                        title={isReadonly ? READONLY_TOOLTIP : !due ? 'Not due yet' : undefined}
                                                        className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                                                    >
                                                        {running === def.id ? 'Running...' : 'Run now'}
                                                    </button>
                                                    <ActionMenu
                                                        label={`Actions for ${def.name}`}
                                                        items={[
                                                            { label: 'Edit...', onSelect: () => openEdit(def), disabled: isReadonly },
                                                            { label: 'Delete...', onSelect: () => setDeleting(def), destructive: true, disabled: isReadonly },
                                                        ]}
                                                    />
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Edit modal */}
            <Modal
                isOpen={!!editing && !!form}
                onClose={() => { if (!saving) { setEditing(null); setForm(null); } }}
                title="Edit Recurring Invoice"
                size="sm"
            >
                {form && (
                    <form
                        className="px-6 py-4 space-y-3"
                        onSubmit={(e) => { e.preventDefault(); handleSave(); }}
                    >
                        <div>
                            <label className={labelClass}>Name *</label>
                            <input
                                type="text"
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                className={inputClass}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>Cadence</label>
                                <select
                                    value={form.cadence}
                                    onChange={(e) => setForm({ ...form, cadence: e.target.value as Cadence })}
                                    className={inputClass}
                                >
                                    {CADENCE_OPTIONS.map((o) => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>Every</label>
                                <input
                                    type="number"
                                    min="1"
                                    step="1"
                                    value={form.every}
                                    onChange={(e) => setForm({ ...form, every: e.target.value })}
                                    className={`${inputClass} font-mono`}
                                    style={TNUM}
                                />
                            </div>
                        </div>
                        <div>
                            <label className={labelClass}>Next date *</label>
                            <input
                                type="date"
                                value={form.nextDate}
                                onChange={(e) => setForm({ ...form, nextDate: e.target.value })}
                                className={`${inputClass} font-mono`}
                                style={TNUM}
                            />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                            <input
                                type="checkbox"
                                checked={form.autoPost}
                                onChange={(e) => setForm({ ...form, autoPost: e.target.checked })}
                                className="accent-primary"
                            />
                            Post automatically on generation
                        </label>
                        <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                            <input
                                type="checkbox"
                                checked={form.active}
                                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                                className="accent-primary"
                            />
                            Active
                        </label>
                        <div className="flex justify-end gap-3 pt-2 border-t border-border">
                            <button
                                type="button"
                                onClick={() => { setEditing(null); setForm(null); }}
                                disabled={saving}
                                className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={saving || isReadonly}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                            >
                                {saving ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                    </form>
                )}
            </Modal>

            {/* Delete confirmation */}
            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title="Delete Recurring Invoice"
                message={deleting
                    ? `Delete "${deleting.name}"? Already-generated invoices are kept; only the schedule is removed. This cannot be undone.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
