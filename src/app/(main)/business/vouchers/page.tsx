'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import {
    STATUS_META,
    newDraftKey,
    parseAmount,
    roundCents,
    todayIso,
    type InvoiceStatus,
} from '@/components/business/invoice-ui';
import type { VoucherView, VoucherDetailView } from '@/lib/business/vouchers';
import type { EmployeeDTO } from '@/lib/business/employees.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const cellInputClass = 'w-full bg-input-bg border border-border rounded-md px-2 py-1 text-[13px] text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

const STATUS_FILTERS: Array<'all' | InvoiceStatus> = ['all', 'draft', 'open', 'paid', 'overdue'];
/** Voucher lines debit expenses; assets allowed for e.g. reimbursable deposits. */
const ENTRY_ACCOUNT_TYPES = ['EXPENSE', 'ASSET'];
const TRANSFER_ACCOUNT_TYPES = ['BANK', 'CASH', 'ASSET', 'CREDIT'];

interface EntryRow {
    key: string;
    description: string;
    accountGuid: string;
    quantity: string;
    price: string;
}

function emptyRow(): EntryRow {
    return { key: newDraftKey(), description: '', accountGuid: '', quantity: '1', price: '' };
}

function rowTotal(row: EntryRow): number {
    return roundCents(parseAmount(row.quantity) * parseAmount(row.price));
}

function StatusBadge({ status }: { status: InvoiceStatus }) {
    const meta = STATUS_META[status];
    return (
        <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${meta.className}`}>
            {meta.label}
        </span>
    );
}

export default function VouchersPage() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [vouchers, setVouchers] = useState<VoucherView[]>([]);
    const [employees, setEmployees] = useState<EmployeeDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<'all' | InvoiceStatus>('all');
    const [currencyByGuid, setCurrencyByGuid] = useState<Record<string, string>>({});

    // Create/edit modal
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingGuid, setEditingGuid] = useState<string | null>(null);
    const [employeeGuid, setEmployeeGuid] = useState('');
    const [dateOpened, setDateOpened] = useState(todayIso());
    const [notes, setNotes] = useState('');
    const [rows, setRows] = useState<EntryRow[]>([emptyRow()]);
    const [saving, setSaving] = useState(false);

    // Post modal
    const [posting, setPosting] = useState<VoucherView | null>(null);
    const [postDate, setPostDate] = useState(todayIso());
    const [postBusy, setPostBusy] = useState(false);

    // Pay (reimburse) modal
    const [paying, setPaying] = useState<VoucherView | null>(null);
    const [payAccount, setPayAccount] = useState('');
    const [payAmount, setPayAmount] = useState('');
    const [payDate, setPayDate] = useState(todayIso());
    const [payMemo, setPayMemo] = useState('');
    const [payBusy, setPayBusy] = useState(false);

    // Delete confirmation
    const [deleting, setDeleting] = useState<VoucherView | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);

    const fetchVouchers = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ limit: '500' });
            if (status !== 'all') params.set('status', status);
            const res = await fetch(`/api/business/vouchers?${params}`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load vouchers');
            setVouchers(data.vouchers ?? []);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load vouchers');
        } finally {
            setLoading(false);
        }
    }, [status, error]);

    useEffect(() => { fetchVouchers(); }, [fetchVouchers]);

    useEffect(() => {
        fetch('/api/business/employees?active=active')
            .then((res) => (res.ok ? res.json() : []))
            .then((rows: EmployeeDTO[]) => setEmployees(Array.isArray(rows) ? rows : []))
            .catch(() => {});
        fetch('/api/commodities?type=CURRENCY')
            .then((res) => (res.ok ? res.json() : []))
            .then((rows: Array<{ guid: string; mnemonic: string }>) => {
                const map: Record<string, string> = {};
                for (const r of rows) map[r.guid] = r.mnemonic;
                setCurrencyByGuid(map);
            })
            .catch(() => {});
    }, []);

    const currencyOf = (v: VoucherView) => currencyByGuid[v.currencyGuid] ?? 'USD';

    const openCreate = useCallback(() => {
        setEditingGuid(null);
        setEmployeeGuid(employees[0]?.guid ?? '');
        setDateOpened(todayIso());
        setNotes('');
        setRows([emptyRow()]);
        setEditorOpen(true);
    }, [employees]);

    useEffect(() => {
        const handler = () => {
            if (!isReadonly) openCreate();
        };
        window.addEventListener('open-new-transaction', handler);
        return () => window.removeEventListener('open-new-transaction', handler);
    }, [openCreate, isReadonly]);

    const openEdit = async (voucher: VoucherView) => {
        try {
            const res = await fetch(`/api/business/vouchers/${voucher.guid}`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to load voucher');
            const detail: VoucherDetailView = data.voucher;
            setEditingGuid(detail.guid);
            setEmployeeGuid(detail.ownerGuid);
            setDateOpened(detail.dateOpened ?? todayIso());
            setNotes(detail.notes ?? '');
            setRows(
                detail.entries.length > 0
                    ? detail.entries.map((e) => ({
                          key: e.guid || newDraftKey(),
                          description: e.description ?? '',
                          accountGuid: e.accountGuid ?? '',
                          quantity: String(e.quantity),
                          price: String(e.price),
                      }))
                    : [emptyRow()],
            );
            setEditorOpen(true);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load voucher');
        }
    };

    const updateRow = (key: string, patch: Partial<EntryRow>) => {
        setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    };

    const removeRow = (key: string) => {
        setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
    };

    const editorTotal = useMemo(
        () => roundCents(rows.reduce((s, r) => s + rowTotal(r), 0)),
        [rows],
    );

    const handleSave = async () => {
        if (!employeeGuid) {
            error('Select an employee');
            return;
        }
        const meaningful = rows.filter((r) => r.accountGuid || r.description.trim() || parseAmount(r.price) !== 0);
        if (meaningful.length === 0) {
            error('Add at least one expense line');
            return;
        }
        if (meaningful.some((r) => !r.accountGuid)) {
            error('Every line needs an expense account');
            return;
        }
        setSaving(true);
        try {
            const entries = meaningful.map((r) => ({
                description: r.description,
                accountGuid: r.accountGuid,
                quantity: parseAmount(r.quantity),
                price: parseAmount(r.price),
            }));
            const res = await fetch(
                editingGuid ? `/api/business/vouchers/${editingGuid}` : '/api/business/vouchers',
                {
                    method: editingGuid ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(
                        editingGuid
                            ? { dateOpened, notes, entries }
                            : { employeeGuid, dateOpened, notes, entries },
                    ),
                },
            );
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to save voucher');
            success(editingGuid ? 'Voucher updated' : 'Voucher created');
            setEditorOpen(false);
            await fetchVouchers();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save voucher');
        } finally {
            setSaving(false);
        }
    };

    const handlePost = async () => {
        if (!posting) return;
        setPostBusy(true);
        try {
            const res = await fetch(`/api/business/vouchers/${posting.guid}/post`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ postDate }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to post voucher');
            success(`Voucher ${posting.id} posted to Accounts Payable`);
            setPosting(null);
            await fetchVouchers();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to post voucher');
        } finally {
            setPostBusy(false);
        }
    };

    const handleUnpost = async (voucher: VoucherView) => {
        try {
            const res = await fetch(`/api/business/vouchers/${voucher.guid}/post`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to unpost voucher');
            success(`Voucher ${voucher.id} unposted`);
            await fetchVouchers();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to unpost voucher');
        }
    };

    const openPay = (voucher: VoucherView) => {
        setPaying(voucher);
        setPayAccount('');
        setPayAmount(voucher.amountDue.toFixed(2));
        setPayDate(todayIso());
        setPayMemo('');
    };

    const handlePay = async () => {
        if (!paying) return;
        const amount = parseAmount(payAmount);
        if (!payAccount) {
            error('Select the account to pay from');
            return;
        }
        if (!(amount > 0)) {
            error('Amount must be greater than zero');
            return;
        }
        if (amount > paying.amountDue + 0.005) {
            error('Amount exceeds the voucher balance');
            return;
        }
        setPayBusy(true);
        try {
            const res = await fetch('/api/business/payments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ownerType: 'employee',
                    ownerGuid: paying.ownerGuid,
                    transferAccountGuid: payAccount,
                    amount,
                    date: payDate,
                    memo: payMemo || undefined,
                    allocations: [{ invoiceGuid: paying.guid, amount }],
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to record reimbursement');
            success('Reimbursement recorded');
            setPaying(null);
            await fetchVouchers();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to record reimbursement');
        } finally {
            setPayBusy(false);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setDeleteBusy(true);
        try {
            const res = await fetch(`/api/business/vouchers/${deleting.guid}`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to delete voucher');
            success(`Voucher ${deleting.id} deleted`);
            setDeleting(null);
            await fetchVouchers();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete voucher');
        } finally {
            setDeleteBusy(false);
        }
    };

    const statusButton = (value: 'all' | InvoiceStatus) => (
        <button
            key={value}
            type="button"
            onClick={() => setStatus(value)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors capitalize ${
                status === value
                    ? 'bg-primary-light text-primary'
                    : 'text-foreground-secondary hover:text-foreground hover:bg-surface-hover'
            }`}
        >
            {value}
        </button>
    );

    return (
        <div className="space-y-4">
            <PageHeader
                title="Expense Vouchers"
                subtitle="Employee expenses posted to Accounts Payable and reimbursed like bills."
                actions={
                    <button
                        type="button"
                        onClick={openCreate}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : 'New Voucher (n)'}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        + New Voucher
                    </button>
                }
                toolbar={
                    <FilterBar activeCount={status !== 'all' ? 1 : 0}>
                        <div className="flex gap-1">
                            {STATUS_FILTERS.map(statusButton)}
                        </div>
                    </FilterBar>
                }
            />

            <HouseholdBookBanner />

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading vouchers...</span>
                    </div>
                ) : vouchers.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No expense vouchers found. Create one to get started.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">#</th>
                                    <th className="px-4 py-2 font-semibold">Employee</th>
                                    <th className="px-4 py-2 font-semibold">Opened</th>
                                    <th className="px-4 py-2 font-semibold">Posted</th>
                                    <th className="px-4 py-2 font-semibold text-right">Total</th>
                                    <th className="px-4 py-2 font-semibold text-right">Balance</th>
                                    <th className="px-4 py-2 font-semibold">Status</th>
                                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {vouchers.map((v) => (
                                    <tr key={v.guid} className="hover:bg-surface-hover/50 transition-colors">
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground" style={TNUM}>{v.id}</td>
                                        <td className="px-4 py-2 text-foreground max-w-xs truncate">{v.ownerName}</td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{v.dateOpened ?? '—'}</td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{v.datePosted ?? '—'}</td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                            {formatCurrency(v.totals.total, currencyOf(v))}
                                        </td>
                                        <td className={`px-4 py-2 font-mono tabular-nums text-right ${v.amountDue > 0.005 ? 'text-foreground' : 'text-foreground-muted'}`} style={TNUM}>
                                            {v.posted ? formatCurrency(v.amountDue, currencyOf(v)) : '—'}
                                        </td>
                                        <td className="px-4 py-2">
                                            <StatusBadge status={v.status} />
                                        </td>
                                        <td className="px-4 py-2 text-right whitespace-nowrap">
                                            {!v.posted ? (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => openEdit(v)}
                                                        className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setPosting(v);
                                                            setPostDate(todayIso());
                                                        }}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                        className="ml-1 px-2 py-1 text-xs rounded-md text-primary hover:bg-primary-light transition-colors disabled:opacity-50"
                                                    >
                                                        Post
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setDeleting(v)}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                        className="ml-1 px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                                    >
                                                        Delete
                                                    </button>
                                                </>
                                            ) : (
                                                <>
                                                    {v.amountDue > 0.005 && (
                                                        <button
                                                            type="button"
                                                            onClick={() => openPay(v)}
                                                            disabled={isReadonly}
                                                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                            className="px-2 py-1 text-xs rounded-md text-primary hover:bg-primary-light transition-colors disabled:opacity-50"
                                                        >
                                                            Reimburse
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => handleUnpost(v)}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : 'Rejected when reimbursements exist'}
                                                        className="ml-1 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                                                    >
                                                        Unpost
                                                    </button>
                                                </>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Create / edit modal */}
            <Modal
                isOpen={editorOpen}
                onClose={() => setEditorOpen(false)}
                title={editingGuid ? 'Edit Voucher' : 'New Expense Voucher'}
                size="xl"
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSave();
                    }}
                >
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className={labelClass}>Employee *</label>
                            <select
                                value={employeeGuid}
                                onChange={(e) => setEmployeeGuid(e.target.value)}
                                disabled={!!editingGuid}
                                className={inputClass}
                            >
                                <option value="">Select employee...</option>
                                {employees.map((emp) => (
                                    <option key={emp.guid} value={emp.guid}>
                                        {emp.name || emp.username}
                                    </option>
                                ))}
                            </select>
                            {employees.length === 0 && (
                                <p className="mt-1 text-xs text-foreground-muted">
                                    No active employees — create one on the Employees page first.
                                </p>
                            )}
                        </div>
                        <div>
                            <label className={labelClass}>Date</label>
                            <input
                                type="date"
                                value={dateOpened}
                                onChange={(e) => setDateOpened(e.target.value)}
                                className={`${inputClass} font-mono`}
                                style={TNUM}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Notes</label>
                            <input
                                type="text"
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                className={inputClass}
                                placeholder="Optional"
                            />
                        </div>
                    </div>

                    <div className="border border-border rounded-lg overflow-hidden">
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-3 py-2 font-semibold min-w-44">Description</th>
                                    <th className="px-3 py-2 font-semibold min-w-52">Expense account</th>
                                    <th className="px-3 py-2 font-semibold text-right w-20">Qty</th>
                                    <th className="px-3 py-2 font-semibold text-right w-28">Price</th>
                                    <th className="px-3 py-2 font-semibold text-right w-28">Total</th>
                                    <th className="px-2 py-2 w-8" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {rows.map((row) => (
                                    <tr key={row.key} className="align-top">
                                        <td className="px-2 py-1.5">
                                            <input
                                                type="text"
                                                value={row.description}
                                                onChange={(e) => updateRow(row.key, { description: e.target.value })}
                                                placeholder="What was the expense?"
                                                className={cellInputClass}
                                            />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <AccountSelector
                                                value={row.accountGuid}
                                                onChange={(guid) => updateRow(row.key, { accountGuid: guid })}
                                                accountTypes={ENTRY_ACCOUNT_TYPES}
                                                compact
                                            />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <input
                                                type="number"
                                                step="any"
                                                value={row.quantity}
                                                onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
                                                className={`${cellInputClass} font-mono text-right`}
                                                style={TNUM}
                                            />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <input
                                                type="number"
                                                step="0.01"
                                                value={row.price}
                                                onChange={(e) => updateRow(row.key, { price: e.target.value })}
                                                placeholder="0.00"
                                                className={`${cellInputClass} font-mono text-right`}
                                                style={TNUM}
                                            />
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground-secondary" style={TNUM}>
                                            {formatCurrency(rowTotal(row))}
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <button
                                                type="button"
                                                onClick={() => removeRow(row.key)}
                                                disabled={rows.length === 1}
                                                className="px-1.5 py-0.5 text-xs rounded text-foreground-muted hover:text-negative transition-colors disabled:opacity-30"
                                                title="Remove line"
                                            >
                                                ✕
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-border">
                                    <td colSpan={4} className="px-3 py-2">
                                        <button
                                            type="button"
                                            onClick={() => setRows((prev) => [...prev, emptyRow()])}
                                            className="text-xs text-primary hover:text-primary-hover transition-colors"
                                        >
                                            + Add line
                                        </button>
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono tabular-nums font-medium text-foreground" style={TNUM}>
                                        {formatCurrency(editorTotal)}
                                    </td>
                                    <td />
                                </tr>
                            </tfoot>
                        </table>
                    </div>

                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditorOpen(false)}
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
                            {saving ? 'Saving...' : editingGuid ? 'Save Draft' : 'Create Draft'}
                        </button>
                    </div>
                </form>
            </Modal>

            {/* Post modal */}
            <Modal
                isOpen={!!posting}
                onClose={() => setPosting(null)}
                title={`Post Voucher ${posting?.id ?? ''}`}
                size="sm"
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handlePost();
                    }}
                >
                    <p className="text-sm text-foreground-secondary">
                        Posting credits Accounts Payable and debits the expense accounts for{' '}
                        <span className="text-foreground font-medium">{posting?.ownerName}</span>.
                    </p>
                    <div>
                        <label className={labelClass}>Post date *</label>
                        <input
                            type="date"
                            value={postDate}
                            onChange={(e) => setPostDate(e.target.value)}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setPosting(null)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={postBusy || !postDate}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                        >
                            {postBusy ? 'Posting...' : 'Post'}
                        </button>
                    </div>
                </form>
            </Modal>

            {/* Reimburse modal */}
            <Modal
                isOpen={!!paying}
                onClose={() => setPaying(null)}
                title={`Reimburse ${paying?.ownerName ?? ''}`}
                size="md"
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handlePay();
                    }}
                >
                    <p className="text-sm text-foreground-secondary">
                        Voucher{' '}
                        <span className="font-mono tabular-nums text-foreground" style={TNUM}>{paying?.id}</span>
                        {paying && (
                            <span className="ml-2 font-mono tabular-nums text-foreground-muted" style={TNUM}>
                                ({formatCurrency(paying.amountDue, currencyOf(paying))} outstanding)
                            </span>
                        )}
                    </p>
                    <div>
                        <label className={labelClass}>Pay from account *</label>
                        <AccountSelector
                            value={payAccount}
                            onChange={(guid) => setPayAccount(guid)}
                            accountTypes={TRANSFER_ACCOUNT_TYPES}
                            placeholder="Pay from account..."
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Amount *</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={payAmount}
                                onChange={(e) => setPayAmount(e.target.value)}
                                className={`${inputClass} font-mono text-right`}
                                style={TNUM}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Date *</label>
                            <input
                                type="date"
                                value={payDate}
                                onChange={(e) => setPayDate(e.target.value)}
                                className={`${inputClass} font-mono`}
                                style={TNUM}
                            />
                        </div>
                    </div>
                    <div>
                        <label className={labelClass}>Memo</label>
                        <input
                            type="text"
                            value={payMemo}
                            onChange={(e) => setPayMemo(e.target.value)}
                            className={inputClass}
                            placeholder="Optional"
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setPaying(null)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={payBusy}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                        >
                            {payBusy ? 'Recording...' : 'Record Reimbursement'}
                        </button>
                    </div>
                </form>
            </Modal>

            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title="Delete Voucher"
                message={deleting ? `Delete draft voucher ${deleting.id}? This cannot be undone.` : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={deleteBusy}
            />
        </div>
    );
}
