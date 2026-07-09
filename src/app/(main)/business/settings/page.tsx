'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import type { BilltermDTO, TaxtableDTO } from '@/lib/business-types';

const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';
const thClass = 'px-4 py-2 font-semibold';
const primaryButtonClass = 'px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap';

interface BilltermForm {
    name: string;
    description: string;
    dueDays: string;
    discountDays: string;
    discountPercent: string;
}

const EMPTY_BILLTERM: BilltermForm = {
    name: '', description: '', dueDays: '30', discountDays: '0', discountPercent: '0',
};

interface EntryForm {
    account: string;
    amount: string;
    type: 'percent' | 'value';
}

interface TaxtableForm {
    name: string;
    entries: EntryForm[];
}

const EMPTY_TAXTABLE: TaxtableForm = {
    name: '',
    entries: [{ account: '', amount: '0', type: 'percent' }],
};

function BilltermsSection() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const [terms, setTerms] = useState<BilltermDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<'new' | BilltermDTO | null>(null);
    const [form, setForm] = useState<BilltermForm>(EMPTY_BILLTERM);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState<BilltermDTO | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchTerms = useCallback(async () => {
        try {
            const res = await fetch('/api/business/billterms');
            if (!res.ok) throw new Error('Failed to load bill terms');
            setTerms(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load bill terms');
        } finally {
            setLoading(false);
        }
    }, [error]);

    useEffect(() => { fetchTerms(); }, [fetchTerms]);

    const openCreate = () => {
        setForm(EMPTY_BILLTERM);
        setEditing('new');
    };

    const openEdit = (term: BilltermDTO) => {
        setForm({
            name: term.name,
            description: term.description,
            dueDays: String(term.dueDays),
            discountDays: String(term.discountDays),
            discountPercent: String(term.discountPercent),
        });
        setEditing(term);
    };

    const handleSave = async () => {
        if (!form.name.trim()) {
            error('Name is required');
            return;
        }
        setSaving(true);
        try {
            const isNew = editing === 'new';
            const url = isNew
                ? '/api/business/billterms'
                : `/api/business/billterms/${(editing as BilltermDTO).guid}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: form.name.trim(),
                    description: form.description,
                    dueDays: parseInt(form.dueDays, 10) || 0,
                    discountDays: parseInt(form.discountDays, 10) || 0,
                    discountPercent: parseFloat(form.discountPercent) || 0,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save bill terms');
            }
            success(isNew ? 'Bill terms created' : 'Bill terms updated');
            setEditing(null);
            await fetchTerms();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save bill terms');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/business/billterms/${deleting.guid}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete bill terms');
            }
            const result = await res.json();
            success(result.deleted
                ? `Deleted "${deleting.name}"`
                : `"${deleting.name}" is in use — hidden instead of deleted`);
            setDeleting(null);
            await fetchTerms();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete bill terms');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <section className="space-y-3">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-foreground">Bill Terms</h2>
                    <p className="text-sm text-foreground-muted">Net-N payment terms for customers and vendors.</p>
                </div>
                <button
                    type="button"
                    onClick={openCreate}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className={primaryButtonClass}
                >
                    + New Terms
                </button>
            </div>

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-8 text-center text-foreground-muted text-sm">Loading bill terms...</div>
                ) : terms.length === 0 ? (
                    <div className="p-8 text-center text-foreground-muted text-sm">
                        No bill terms yet. Create one (e.g. &quot;Net 30&quot;) to use on customers and vendors.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className={thClass}>Name</th>
                                    <th className={thClass}>Description</th>
                                    <th className={`${thClass} text-right`}>Due Days</th>
                                    <th className={`${thClass} text-right`}>Discount Days</th>
                                    <th className={`${thClass} text-right`}>Discount %</th>
                                    <th className={`${thClass} text-right`}>In Use</th>
                                    <th className={`${thClass} text-right`}>Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {terms.map(term => (
                                    <tr key={term.guid} className="hover:bg-surface-hover/50 transition-colors">
                                        <td className="px-4 py-3 text-sm text-foreground">{term.name}</td>
                                        <td className="px-4 py-3 text-sm text-foreground-secondary max-w-xs truncate">
                                            {term.description || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-foreground-secondary">{term.dueDays}</td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-foreground-secondary">{term.discountDays}</td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-foreground-secondary">{term.discountPercent}</td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-foreground-secondary">{term.refcount}</td>
                                        <td className="px-4 py-3 text-right whitespace-nowrap">
                                            <button
                                                type="button"
                                                onClick={() => openEdit(term)}
                                                className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setDeleting(term)}
                                                disabled={isReadonly}
                                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                className="ml-1 px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <Modal
                isOpen={!!editing}
                onClose={() => setEditing(null)}
                title={editing === 'new' ? 'New Bill Terms' : 'Edit Bill Terms'}
                size="sm"
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSave();
                    }}
                >
                    <div>
                        <label className={labelClass}>Name *</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            className={inputClass}
                            placeholder="e.g. Net 30"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Description</label>
                        <input
                            type="text"
                            value={form.description}
                            onChange={(e) => setForm({ ...form, description: e.target.value })}
                            className={inputClass}
                            placeholder="Optional description"
                        />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <div>
                            <label className={labelClass}>Due days</label>
                            <input
                                type="number"
                                min="0"
                                value={form.dueDays}
                                onChange={(e) => setForm({ ...form, dueDays: e.target.value })}
                                className={`${inputClass} font-mono`}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Discount days</label>
                            <input
                                type="number"
                                min="0"
                                value={form.discountDays}
                                onChange={(e) => setForm({ ...form, discountDays: e.target.value })}
                                className={`${inputClass} font-mono`}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Discount %</label>
                            <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                value={form.discountPercent}
                                onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                                className={`${inputClass} font-mono`}
                            />
                        </div>
                    </div>
                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditing(null)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={saving || isReadonly}
                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                            className={primaryButtonClass}
                        >
                            {saving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </form>
            </Modal>

            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title="Delete Bill Terms"
                message={deleting
                    ? `Delete "${deleting.name}"? If these terms are in use by customers, vendors, or invoices they will be hidden instead of deleted.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </section>
    );
}

function TaxtablesSection() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const [tables, setTables] = useState<TaxtableDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<'new' | TaxtableDTO | null>(null);
    const [form, setForm] = useState<TaxtableForm>(EMPTY_TAXTABLE);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState<TaxtableDTO | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchTables = useCallback(async () => {
        try {
            const res = await fetch('/api/business/taxtables');
            if (!res.ok) throw new Error('Failed to load tax tables');
            setTables(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load tax tables');
        } finally {
            setLoading(false);
        }
    }, [error]);

    useEffect(() => { fetchTables(); }, [fetchTables]);

    const openCreate = () => {
        setForm({ name: '', entries: [{ account: '', amount: '0', type: 'percent' }] });
        setEditing('new');
    };

    const openEdit = (table: TaxtableDTO) => {
        setForm({
            name: table.name,
            entries: table.entries.map(e => ({
                account: e.account,
                amount: String(e.amount),
                type: e.type,
            })),
        });
        setEditing(table);
    };

    const setEntry = (index: number, patch: Partial<EntryForm>) => {
        setForm(prev => ({
            ...prev,
            entries: prev.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)),
        }));
    };

    const addEntry = () => {
        setForm(prev => ({
            ...prev,
            entries: [...prev.entries, { account: '', amount: '0', type: 'percent' }],
        }));
    };

    const removeEntry = (index: number) => {
        setForm(prev => ({
            ...prev,
            entries: prev.entries.filter((_, i) => i !== index),
        }));
    };

    const handleSave = async () => {
        if (!form.name.trim()) {
            error('Name is required');
            return;
        }
        if (form.entries.length === 0 || form.entries.some(e => !e.account)) {
            error('Every entry needs a target account');
            return;
        }
        setSaving(true);
        try {
            const isNew = editing === 'new';
            const url = isNew
                ? '/api/business/taxtables'
                : `/api/business/taxtables/${(editing as TaxtableDTO).guid}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: form.name.trim(),
                    entries: form.entries.map(e => ({
                        account: e.account,
                        amount: parseFloat(e.amount) || 0,
                        type: e.type,
                    })),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save tax table');
            }
            success(isNew ? 'Tax table created' : 'Tax table updated');
            setEditing(null);
            await fetchTables();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save tax table');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/business/taxtables/${deleting.guid}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete tax table');
            }
            const result = await res.json();
            success(result.deleted
                ? `Deleted "${deleting.name}"`
                : `"${deleting.name}" is in use — hidden instead of deleted`);
            setDeleting(null);
            await fetchTables();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete tax table');
        } finally {
            setIsDeleting(false);
        }
    };

    const entrySummary = (table: TaxtableDTO) =>
        table.entries
            .map(e => `${e.accountName ?? 'Unknown'}: ${e.amount}${e.type === 'percent' ? '%' : ''}`)
            .join(', ');

    return (
        <section className="space-y-3">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-foreground">Tax Tables</h2>
                    <p className="text-sm text-foreground-muted">
                        Sales tax rates posted to liability or expense accounts on invoice entries.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={openCreate}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className={primaryButtonClass}
                >
                    + New Tax Table
                </button>
            </div>

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-8 text-center text-foreground-muted text-sm">Loading tax tables...</div>
                ) : tables.length === 0 ? (
                    <div className="p-8 text-center text-foreground-muted text-sm">
                        No tax tables yet. Create one to apply sales tax on invoices and bills.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className={thClass}>Name</th>
                                    <th className={thClass}>Entries</th>
                                    <th className={`${thClass} text-right`}>In Use</th>
                                    <th className={`${thClass} text-right`}>Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {tables.map(table => (
                                    <tr key={table.guid} className="hover:bg-surface-hover/50 transition-colors">
                                        <td className="px-4 py-3 text-sm text-foreground">{table.name}</td>
                                        <td className="px-4 py-3 text-sm text-foreground-secondary max-w-md truncate">
                                            {entrySummary(table) || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-foreground-secondary">{table.refcount}</td>
                                        <td className="px-4 py-3 text-right whitespace-nowrap">
                                            <button
                                                type="button"
                                                onClick={() => openEdit(table)}
                                                className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setDeleting(table)}
                                                disabled={isReadonly}
                                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                className="ml-1 px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <Modal
                isOpen={!!editing}
                onClose={() => setEditing(null)}
                title={editing === 'new' ? 'New Tax Table' : 'Edit Tax Table'}
                size="lg"
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSave();
                    }}
                >
                    <div>
                        <label className={labelClass}>Name *</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            className={inputClass}
                            maxLength={50}
                            placeholder="e.g. State Sales Tax"
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Entries</label>
                        <div className="space-y-2">
                            {form.entries.map((entry, index) => (
                                <div key={index} className="flex gap-2 items-start">
                                    <div className="flex-1 min-w-0">
                                        <AccountSelector
                                            value={entry.account}
                                            onChange={(guid) => setEntry(index, { account: guid })}
                                            placeholder="Tax account (liability or expense)..."
                                            accountTypes={['LIABILITY', 'EXPENSE']}
                                            compact
                                        />
                                    </div>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={entry.amount}
                                        onChange={(e) => setEntry(index, { amount: e.target.value })}
                                        className={`${inputClass} font-mono w-28`}
                                        style={{ width: '7rem' }}
                                    />
                                    <select
                                        value={entry.type}
                                        onChange={(e) => setEntry(index, { type: e.target.value as 'percent' | 'value' })}
                                        className={`${inputClass} w-32`}
                                        style={{ width: '8rem' }}
                                    >
                                        <option value="percent">Percent %</option>
                                        <option value="value">Fixed value</option>
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => removeEntry(index)}
                                        disabled={form.entries.length <= 1}
                                        className="px-2 py-2 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-30"
                                        title="Remove entry"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={addEntry}
                            className="mt-2 text-sm text-primary hover:text-primary-hover transition-colors"
                        >
                            + Add entry
                        </button>
                    </div>

                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditing(null)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={saving || isReadonly}
                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                            className={primaryButtonClass}
                        >
                            {saving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </form>
            </Modal>

            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title="Delete Tax Table"
                message={deleting
                    ? `Delete "${deleting.name}"? If this tax table is in use by customers, vendors, or invoice entries it will be hidden instead of deleted.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </section>
    );
}

export default function BusinessSettingsPage() {
    return (
        <div className="space-y-8">
            <PageHeader
                title="Business Settings"
                subtitle="Bill terms and tax tables used by customers, vendors, and invoices."
            />

            <HouseholdBookBanner />

            <BilltermsSection />
            <TaxtablesSection />
        </div>
    );
}
