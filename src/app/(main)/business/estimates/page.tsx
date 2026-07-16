'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { OwnerSelector } from '@/components/business/OwnerSelector';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import type { EstimateView, EstimateStatus } from '@/lib/business/estimates.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const cellInputClass = 'w-full bg-input-bg border border-border rounded-md px-2 py-1 text-[13px] text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

const STATUS_META: Record<EstimateStatus, { label: string; className: string }> = {
    draft: { label: 'Draft', className: 'bg-surface-hover text-foreground-muted' },
    sent: { label: 'Sent', className: 'bg-secondary-light text-secondary' },
    accepted: { label: 'Accepted', className: 'bg-positive/10 text-positive' },
    declined: { label: 'Declined', className: 'bg-negative/10 text-negative' },
    converted: { label: 'Converted', className: 'bg-primary-light text-primary' },
};

const STATUS_FILTERS: Array<'all' | EstimateStatus> = ['all', 'draft', 'sent', 'accepted', 'declined', 'converted'];

interface LineDraft {
    key: string;
    description: string;
    quantity: string;
    unitPrice: string;
    incomeAccountGuid: string;
}

let lineSeq = 0;
function emptyLine(): LineDraft {
    lineSeq += 1;
    return { key: `line-${lineSeq}-${Date.now()}`, description: '', quantity: '1', unitPrice: '', incomeAccountGuid: '' };
}

interface EditorForm {
    customerGuid: string;
    dateCreated: string;
    expires: string;
    notes: string;
    terms: string;
    lines: LineDraft[];
}

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

function emptyForm(): EditorForm {
    return { customerGuid: '', dateCreated: todayIso(), expires: '', notes: '', terms: '', lines: [emptyLine()] };
}

function formFromEstimate(est: EstimateView): EditorForm {
    return {
        customerGuid: est.customerGuid ?? '',
        dateCreated: est.dateCreated ?? todayIso(),
        expires: est.expires ?? '',
        notes: est.notes ?? '',
        terms: est.terms ?? '',
        lines: est.lines.length > 0
            ? est.lines.map((l) => {
                lineSeq += 1;
                return {
                    key: `line-${lineSeq}-${l.id}`,
                    description: l.description,
                    quantity: String(l.quantity),
                    unitPrice: String(l.unitPrice),
                    incomeAccountGuid: l.incomeAccountGuid ?? '',
                };
            })
            : [emptyLine()],
    };
}

function lineAmount(l: LineDraft): number {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.unitPrice) || 0;
    return Math.round(qty * price * 100) / 100;
}

function isBlankLine(l: LineDraft): boolean {
    return !l.description.trim() && !l.incomeAccountGuid && !(parseFloat(l.unitPrice) > 0);
}

function StatusBadge({ status }: { status: EstimateStatus }) {
    const meta = STATUS_META[status];
    return (
        <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${meta.className}`}>
            {meta.label}
        </span>
    );
}

export default function EstimatesPage() {
    const router = useRouter();
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [estimates, setEstimates] = useState<EstimateView[]>([]);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState<'all' | EstimateStatus>('all');
    const [search, setSearch] = useState('');

    // Editor state
    const [editing, setEditing] = useState<'new' | EstimateView | null>(null);
    const [form, setForm] = useState<EditorForm>(emptyForm());
    const [saving, setSaving] = useState(false);

    // Row actions
    const [confirmDelete, setConfirmDelete] = useState<EstimateView | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);

    const fetchEstimates = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (statusFilter !== 'all') params.set('status', statusFilter);
            const res = await fetch(`/api/business/estimates${params.size ? `?${params}` : ''}`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load estimates');
            setEstimates(data.estimates ?? []);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load estimates');
        } finally {
            setLoading(false);
        }
    }, [statusFilter, error]);

    useEffect(() => { fetchEstimates(); }, [fetchEstimates]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return estimates;
        return estimates.filter(
            (e) => e.estimateNo.toLowerCase().includes(q) || (e.customerName ?? '').toLowerCase().includes(q),
        );
    }, [estimates, search]);

    // ------------------------------------------------------------------
    // Editor
    // ------------------------------------------------------------------

    const openNew = () => {
        setForm(emptyForm());
        setEditing('new');
    };

    const openEdit = (est: EstimateView) => {
        setForm(formFromEstimate(est));
        setEditing(est);
    };

    const updateLine = (key: string, patch: Partial<LineDraft>) => {
        setForm((prev) => ({
            ...prev,
            lines: prev.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
        }));
    };

    const addLine = () => setForm((prev) => ({ ...prev, lines: [...prev.lines, emptyLine()] }));

    const removeLine = (key: string) => {
        setForm((prev) => {
            const next = prev.lines.filter((l) => l.key !== key);
            return { ...prev, lines: next.length > 0 ? next : [emptyLine()] };
        });
    };

    const editorTotal = useMemo(
        () => Math.round(form.lines.reduce((s, l) => s + lineAmount(l), 0) * 100) / 100,
        [form.lines],
    );

    const editingConverted = editing !== 'new' && editing !== null && editing.status === 'converted';

    const handleSave = async () => {
        const rows = form.lines.filter((l) => !isBlankLine(l));
        if (rows.length === 0) {
            error('At least one line is required');
            return;
        }
        setSaving(true);
        try {
            const payload = {
                customerGuid: form.customerGuid || null,
                dateCreated: form.dateCreated || undefined,
                expires: form.expires || null,
                notes: form.notes || null,
                terms: form.terms || null,
                lines: rows.map((l) => ({
                    description: l.description,
                    quantity: parseFloat(l.quantity) || 0,
                    unitPrice: parseFloat(l.unitPrice) || 0,
                    incomeAccountGuid: l.incomeAccountGuid || null,
                })),
            };
            const isNew = editing === 'new';
            const res = await fetch(
                isNew ? '/api/business/estimates' : `/api/business/estimates/${(editing as EstimateView).id}`,
                {
                    method: isNew ? 'POST' : 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
            );
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to save estimate');
            success(isNew ? `Estimate ${data.estimate.estimateNo} created` : 'Estimate saved');
            setEditing(null);
            await fetchEstimates();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save estimate');
        } finally {
            setSaving(false);
        }
    };

    // ------------------------------------------------------------------
    // Row actions
    // ------------------------------------------------------------------

    const setStatus = async (est: EstimateView, status: EstimateStatus) => {
        setBusyId(est.id);
        try {
            const res = await fetch(`/api/business/estimates/${est.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to update status');
            success(`Estimate ${est.estimateNo} marked ${STATUS_META[status].label.toLowerCase()}`);
            await fetchEstimates();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update status');
        } finally {
            setBusyId(null);
        }
    };

    const handleConvert = async (est: EstimateView) => {
        setBusyId(est.id);
        try {
            const res = await fetch(`/api/business/estimates/${est.id}/convert`, { method: 'POST' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to convert estimate');
            success(`Estimate ${est.estimateNo} converted to a draft invoice`);
            router.push(`/business/invoices/${data.invoiceGuid}`);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to convert estimate');
            setBusyId(null);
        }
    };

    const handleCopyLink = async (est: EstimateView) => {
        setBusyId(est.id);
        try {
            const res = await fetch(`/api/business/estimates/${est.id}/share`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to create share link');
            const url = `${window.location.origin}${data.share.path}`;
            await navigator.clipboard.writeText(url);
            success('Customer link copied to clipboard');
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to create share link');
        } finally {
            setBusyId(null);
        }
    };

    const handleDelete = async () => {
        if (!confirmDelete) return;
        setDeleting(true);
        try {
            const res = await fetch(`/api/business/estimates/${confirmDelete.id}`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to delete estimate');
            success(`Estimate ${confirmDelete.estimateNo} deleted`);
            setConfirmDelete(null);
            await fetchEstimates();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete estimate');
        } finally {
            setDeleting(false);
        }
    };

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------

    const statusButton = (value: 'all' | EstimateStatus) => (
        <button
            key={value}
            type="button"
            onClick={() => setStatusFilter(value)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors capitalize ${
                statusFilter === value
                    ? 'bg-primary-light text-primary'
                    : 'text-foreground-secondary hover:text-foreground hover:bg-surface-hover'
            }`}
        >
            {value}
        </button>
    );

    const rowActionClass = 'px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50';

    return (
        <div className="space-y-4">
            <PageHeader
                title="Estimates"
                subtitle="Quotes with line items — send, track acceptance, and convert to invoices."
                actions={
                    <button
                        type="button"
                        onClick={openNew}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        + New Estimate
                    </button>
                }
                toolbar={
                    <FilterBar
                        primary={
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search by number or customer..."
                                className={`${inputClass} md:max-w-sm`}
                            />
                        }
                        activeCount={statusFilter !== 'all' ? 1 : 0}
                    >
                        <div className="flex gap-1">
                            {STATUS_FILTERS.map(statusButton)}
                        </div>
                    </FilterBar>
                }
            />

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading estimates...</span>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No estimates found. Create one to get started.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">#</th>
                                    <th className="px-4 py-2 font-semibold">Customer</th>
                                    <th className="px-4 py-2 font-semibold">Date</th>
                                    <th className="px-4 py-2 font-semibold">Valid until</th>
                                    <th className="px-4 py-2 font-semibold text-right">Total</th>
                                    <th className="px-4 py-2 font-semibold">Status</th>
                                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {filtered.map((est) => {
                                    const busy = busyId === est.id;
                                    return (
                                        <tr key={est.id} className="hover:bg-surface-hover/50 transition-colors">
                                            <td
                                                className="px-4 py-2 font-mono tabular-nums text-foreground cursor-pointer"
                                                style={TNUM}
                                                onClick={() => openEdit(est)}
                                            >
                                                {est.estimateNo}
                                            </td>
                                            <td className="px-4 py-2 text-foreground max-w-xs truncate cursor-pointer" onClick={() => openEdit(est)}>
                                                {est.customerName ?? <span className="text-foreground-muted">—</span>}
                                            </td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{est.dateCreated ?? '—'}</td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{est.expires ?? '—'}</td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                                {formatCurrency(est.total, 'USD')}
                                            </td>
                                            <td className="px-4 py-2">
                                                <StatusBadge status={est.status} />
                                                {est.status === 'converted' && est.convertedInvoiceGuid && (
                                                    <Link
                                                        href={`/business/invoices/${est.convertedInvoiceGuid}`}
                                                        className="ml-2 text-xs text-primary hover:text-primary-hover transition-colors"
                                                    >
                                                        View invoice →
                                                    </Link>
                                                )}
                                            </td>
                                            <td className="px-4 py-2 text-right whitespace-nowrap">
                                                {est.status === 'draft' && (
                                                    <button type="button" onClick={() => setStatus(est, 'sent')} disabled={isReadonly || busy} title={isReadonly ? READONLY_TOOLTIP : undefined} className={rowActionClass}>
                                                        Mark sent
                                                    </button>
                                                )}
                                                {est.status === 'sent' && (
                                                    <>
                                                        <button type="button" onClick={() => setStatus(est, 'accepted')} disabled={isReadonly || busy} title={isReadonly ? READONLY_TOOLTIP : undefined} className="px-2 py-1 text-xs rounded-md text-positive hover:bg-positive/10 transition-colors disabled:opacity-50">
                                                            Accept
                                                        </button>
                                                        <button type="button" onClick={() => setStatus(est, 'declined')} disabled={isReadonly || busy} title={isReadonly ? READONLY_TOOLTIP : undefined} className="ml-1 px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50">
                                                            Decline
                                                        </button>
                                                    </>
                                                )}
                                                {est.status !== 'converted' && est.status !== 'declined' && (
                                                    <button type="button" onClick={() => handleConvert(est)} disabled={isReadonly || busy} title={isReadonly ? READONLY_TOOLTIP : 'Create a draft invoice from this estimate'} className="ml-1 px-2 py-1 text-xs rounded-md text-primary hover:bg-primary-light transition-colors disabled:opacity-50">
                                                        Convert
                                                    </button>
                                                )}
                                                {est.status !== 'converted' && (
                                                    <button type="button" onClick={() => handleCopyLink(est)} disabled={isReadonly || busy} title={isReadonly ? READONLY_TOOLTIP : 'Copy a customer-facing link'} className={`ml-1 ${rowActionClass}`}>
                                                        Copy link
                                                    </button>
                                                )}
                                                {est.status !== 'converted' && (
                                                    <button type="button" onClick={() => setConfirmDelete(est)} disabled={isReadonly || busy} title={isReadonly ? READONLY_TOOLTIP : undefined} className="ml-1 px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50">
                                                        Delete
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Editor modal */}
            <Modal
                isOpen={!!editing}
                onClose={saving ? () => {} : () => setEditing(null)}
                title={editing === 'new' || editing === null ? 'New Estimate' : `Estimate ${editing.estimateNo}`}
                size="lg"
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => { e.preventDefault(); if (!editingConverted) handleSave(); }}
                >
                    {editingConverted && (
                        <p className="text-sm text-foreground-muted">
                            This estimate was converted to an invoice and is read-only.
                        </p>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Customer</label>
                            <OwnerSelector
                                kind="customer"
                                value={form.customerGuid}
                                onChange={(guid) => setForm((f) => ({ ...f, customerGuid: guid }))}
                                disabled={editingConverted}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>Date</label>
                                <input
                                    type="date"
                                    value={form.dateCreated}
                                    onChange={(e) => setForm((f) => ({ ...f, dateCreated: e.target.value }))}
                                    className={`${inputClass} font-mono`}
                                    style={TNUM}
                                    disabled={editingConverted}
                                />
                            </div>
                            <div>
                                <label className={labelClass}>Valid until</label>
                                <input
                                    type="date"
                                    value={form.expires}
                                    onChange={(e) => setForm((f) => ({ ...f, expires: e.target.value }))}
                                    className={`${inputClass} font-mono`}
                                    style={TNUM}
                                    disabled={editingConverted}
                                />
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className={labelClass}>Lines</label>
                        <div className="border border-border rounded-lg overflow-hidden">
                            <table className="w-full text-left text-[13px]">
                                <thead>
                                    <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                        <th className="px-2 py-2 font-semibold min-w-40">Description</th>
                                        <th className="px-2 py-2 font-semibold min-w-48">Income account</th>
                                        <th className="px-2 py-2 font-semibold text-right w-20">Qty</th>
                                        <th className="px-2 py-2 font-semibold text-right w-28">Unit price</th>
                                        <th className="px-2 py-2 font-semibold text-right w-28">Amount</th>
                                        <th className="px-1 py-2 w-8" />
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {form.lines.map((l) => (
                                        <tr key={l.key} className="align-top">
                                            <td className="px-2 py-1.5">
                                                <input
                                                    type="text"
                                                    value={l.description}
                                                    onChange={(e) => updateLine(l.key, { description: e.target.value })}
                                                    placeholder="Description"
                                                    className={cellInputClass}
                                                    disabled={editingConverted}
                                                />
                                            </td>
                                            <td className="px-2 py-1.5">
                                                <AccountSelector
                                                    value={l.incomeAccountGuid}
                                                    onChange={(guid) => updateLine(l.key, { incomeAccountGuid: guid })}
                                                    accountTypes={['INCOME']}
                                                    compact
                                                />
                                            </td>
                                            <td className="px-2 py-1.5">
                                                <input
                                                    type="number"
                                                    step="any"
                                                    value={l.quantity}
                                                    onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                                                    className={`${cellInputClass} font-mono text-right`}
                                                    style={TNUM}
                                                    disabled={editingConverted}
                                                />
                                            </td>
                                            <td className="px-2 py-1.5">
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    value={l.unitPrice}
                                                    onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
                                                    placeholder="0.00"
                                                    className={`${cellInputClass} font-mono text-right`}
                                                    style={TNUM}
                                                    disabled={editingConverted}
                                                />
                                            </td>
                                            <td className="px-2 py-1.5 font-mono tabular-nums text-right text-foreground whitespace-nowrap" style={TNUM}>
                                                {formatCurrency(lineAmount(l), 'USD')}
                                            </td>
                                            <td className="px-1 py-1.5 text-center">
                                                <button
                                                    type="button"
                                                    onClick={() => removeLine(l.key)}
                                                    disabled={editingConverted}
                                                    className="px-1.5 py-0.5 text-xs rounded-md text-foreground-muted hover:text-negative hover:bg-negative/10 transition-colors disabled:opacity-30"
                                                    title="Remove line"
                                                >
                                                    ✕
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div className="px-2 py-2 border-t border-border flex items-center justify-between">
                                <button
                                    type="button"
                                    onClick={addLine}
                                    disabled={editingConverted}
                                    className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-30"
                                >
                                    + Add line
                                </button>
                                <div className="text-sm text-foreground font-semibold pr-8">
                                    Total{' '}
                                    <span className="font-mono tabular-nums" style={TNUM}>
                                        {formatCurrency(editorTotal, 'USD')}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Notes</label>
                            <textarea
                                value={form.notes}
                                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                                rows={2}
                                placeholder="Internal or customer-visible notes..."
                                className={inputClass}
                                disabled={editingConverted}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Terms</label>
                            <textarea
                                value={form.terms}
                                onChange={(e) => setForm((f) => ({ ...f, terms: e.target.value }))}
                                rows={2}
                                placeholder="e.g. Valid 30 days. 50% deposit to begin work."
                                className={inputClass}
                                disabled={editingConverted}
                            />
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditing(null)}
                            disabled={saving}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            {editingConverted ? 'Close' : 'Cancel'}
                        </button>
                        {!editingConverted && (
                            <button
                                type="submit"
                                disabled={saving || isReadonly}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                            >
                                {saving ? 'Saving...' : editing === 'new' ? 'Create Estimate' : 'Save'}
                            </button>
                        )}
                    </div>
                </form>
            </Modal>

            <ConfirmationDialog
                isOpen={!!confirmDelete}
                onConfirm={handleDelete}
                onCancel={() => setConfirmDelete(null)}
                title="Delete Estimate"
                message={confirmDelete
                    ? `Delete estimate ${confirmDelete.estimateNo}? This removes the estimate and its lines. This cannot be undone.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={deleting}
            />
        </div>
    );
}
