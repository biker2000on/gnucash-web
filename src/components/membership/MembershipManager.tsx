'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import { formatCurrency } from '@/lib/format';
import {
    computeMembershipPeriod,
    RENEWAL_MODES,
    RENEWAL_MODE_LABELS,
    MEMBER_STATUSES,
    PAYMENT_METHODS,
    DUES_STATUS_LABELS,
    type DuesStatus,
    type MemberStatus,
    type RenewalMode,
    type PaymentMethod,
} from '@/lib/membership';
import type {
    MemberListItemDTO,
    MemberDetailDTO,
    MembershipTypeDTO,
    MembershipSummaryDTO,
} from '@/lib/services/membership.service';

const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

const DUES_CHIP: Record<DuesStatus, string> = {
    current: 'bg-positive/10 text-positive',
    lifetime: 'bg-secondary-light text-secondary',
    lapsed: 'bg-warning/10 text-warning',
    unpaid: 'bg-surface-hover text-foreground-muted',
    exempt: 'bg-secondary-light text-secondary',
};

const STATUS_CHIP: Record<MemberStatus, string> = {
    active: 'bg-positive/10 text-positive',
    honorary: 'bg-secondary-light text-secondary',
    resigned: 'bg-surface-hover text-foreground-muted',
};

const STATUS_LABELS: Record<MemberStatus, string> = {
    active: 'Active',
    honorary: 'Honorary',
    resigned: 'Resigned',
};

const METHOD_LABELS: Record<PaymentMethod, string> = {
    cash: 'Cash',
    check: 'Check',
    card: 'Card',
    zeffy: 'Zeffy',
    other: 'Other',
};

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

function DuesChip({ status }: { status: DuesStatus }) {
    return (
        <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${DUES_CHIP[status]}`}>
            {DUES_STATUS_LABELS[status]}
        </span>
    );
}

// ============================================
// Member form (shared by create + edit)
// ============================================

interface MemberForm {
    name: string;
    email: string;
    phone: string;
    address: string;
    membershipTypeId: string; // '' = none
    joinedDate: string;
    status: MemberStatus;
    notes: string;
}

const EMPTY_MEMBER_FORM: MemberForm = {
    name: '', email: '', phone: '', address: '',
    membershipTypeId: '', joinedDate: todayIso(), status: 'active', notes: '',
};

function memberToForm(m: MemberDetailDTO): MemberForm {
    return {
        name: m.name,
        email: m.email ?? '',
        phone: m.phone ?? '',
        address: m.address ?? '',
        membershipTypeId: m.membershipTypeId != null ? String(m.membershipTypeId) : '',
        joinedDate: m.joinedDate ?? '',
        status: m.status,
        notes: m.notes ?? '',
    };
}

function formToPayload(form: MemberForm) {
    return {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address || null,
        membershipTypeId: form.membershipTypeId ? Number(form.membershipTypeId) : null,
        joinedDate: form.joinedDate || null,
        status: form.status,
        notes: form.notes || null,
    };
}

function MemberFields({ form, setForm, types }: {
    form: MemberForm;
    setForm: (f: MemberForm) => void;
    types: MembershipTypeDTO[];
}) {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
                <label className={labelClass}>Name *</label>
                <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputClass} placeholder="Member name" />
            </div>
            <div>
                <label className={labelClass}>Email</label>
                <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className={inputClass} />
            </div>
            <div>
                <label className={labelClass}>Phone</label>
                <input type="text" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className={inputClass} />
            </div>
            <div>
                <label className={labelClass}>Membership type</label>
                <select value={form.membershipTypeId} onChange={e => setForm({ ...form, membershipTypeId: e.target.value })} className={inputClass}>
                    <option value="">None</option>
                    {types.map(t => (
                        <option key={t.id} value={t.id}>
                            {t.name} ({formatCurrency(t.amount)}{t.active ? '' : ', inactive'})
                        </option>
                    ))}
                </select>
            </div>
            <div>
                <label className={labelClass}>Status</label>
                <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value as MemberStatus })} className={inputClass}>
                    {MEMBER_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                </select>
            </div>
            <div>
                <label className={labelClass}>Joined</label>
                <input type="date" value={form.joinedDate} onChange={e => setForm({ ...form, joinedDate: e.target.value })} className={`${inputClass} font-mono`} />
            </div>
            <div>
                <label className={labelClass}>Address</label>
                <input type="text" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className={inputClass} placeholder="Mailing address" />
            </div>
            <div className="sm:col-span-2">
                <label className={labelClass}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className={`${inputClass} resize-none`} placeholder="Optional notes..." />
            </div>
        </div>
    );
}

// ============================================
// Record-payment form (inside member detail)
// ============================================

function RecordPaymentForm({ member, types, onRecorded }: {
    member: MemberDetailDTO;
    types: MembershipTypeDTO[];
    onRecorded: () => void;
}) {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const usableTypes = types.filter(t => t.active || t.id === member.membershipTypeId);
    const defaultTypeId = member.membershipTypeId ?? usableTypes[0]?.id ?? null;

    const [typeId, setTypeId] = useState<number | null>(defaultTypeId);
    const [amount, setAmount] = useState<string>(() => {
        const t = types.find(x => x.id === defaultTypeId);
        return t ? String(t.amount) : '';
    });
    const [paidDate, setPaidDate] = useState(todayIso());
    const [method, setMethod] = useState<PaymentMethod>('cash');
    const [reference, setReference] = useState('');
    const [override, setOverride] = useState(false);
    const [periodStart, setPeriodStart] = useState('');
    const [periodEnd, setPeriodEnd] = useState('');
    const [saving, setSaving] = useState(false);

    const selectedType = types.find(t => t.id === typeId) ?? null;

    const handleTypeChange = (raw: string) => {
        const id = raw ? Number(raw) : null;
        setTypeId(id);
        const t = types.find(x => x.id === id);
        if (t) setAmount(String(t.amount));
    };

    // Live coverage preview (mirrors the server-side computation).
    const preview = useMemo(() => {
        if (!selectedType || !/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) return null;
        return computeMembershipPeriod(
            selectedType.renewalMode as RenewalMode,
            paidDate,
            member.hasLifetime ? null : member.paidThrough
        );
    }, [selectedType, paidDate, member.paidThrough, member.hasLifetime]);

    const handleSubmit = async () => {
        if (typeId == null) {
            error('Pick a membership type');
            return;
        }
        setSaving(true);
        try {
            const body: Record<string, unknown> = {
                membershipTypeId: typeId,
                amount: amount === '' ? null : Number(amount),
                paidDate,
                method,
                reference: reference.trim() || null,
            };
            if (override && periodStart) {
                body.periodStart = periodStart;
                body.periodEnd = periodEnd || null;
            }
            const res = await fetch(`/api/membership/members/${member.id}/payments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to record payment');
            }
            success('Payment recorded');
            setReference('');
            setOverride(false);
            setPeriodStart('');
            setPeriodEnd('');
            onRecorded();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to record payment');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="bg-background-tertiary border border-border rounded-lg p-3 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="col-span-2">
                    <label className={labelClass}>Type</label>
                    <select value={typeId ?? ''} onChange={e => handleTypeChange(e.target.value)} className={inputClass}>
                        {typeId == null && <option value="">Choose...</option>}
                        {usableTypes.map(t => (
                            <option key={t.id} value={t.id}>{t.name} ({formatCurrency(t.amount)})</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className={labelClass}>Amount</label>
                    <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className={`${inputClass} font-mono`} />
                </div>
                <div>
                    <label className={labelClass}>Paid date</label>
                    <input type="date" value={paidDate} onChange={e => setPaidDate(e.target.value)} className={`${inputClass} font-mono`} />
                </div>
                <div>
                    <label className={labelClass}>Method</label>
                    <select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
                        {PAYMENT_METHODS.map(m => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
                    </select>
                </div>
                <div className="col-span-2 sm:col-span-3">
                    <label className={labelClass}>Reference</label>
                    <input type="text" value={reference} onChange={e => setReference(e.target.value)} className={inputClass} placeholder="Check #, receipt..." />
                </div>
            </div>

            {!override && preview && (
                <p className="text-xs text-foreground-secondary">
                    Covers{' '}
                    <span className="font-mono tabular-nums text-foreground">
                        {preview.periodEnd
                            ? `${preview.periodStart} → ${preview.periodEnd}`
                            : `${preview.periodStart} → lifetime`}
                    </span>
                </p>
            )}

            <div className="flex flex-wrap items-end gap-3">
                <label className="flex items-center gap-2 text-xs text-foreground-secondary">
                    <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} className="accent-primary" />
                    Override period
                </label>
                {override && (
                    <>
                        <div>
                            <label className={labelClass}>Period start</label>
                            <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className={`${inputClass} font-mono`} />
                        </div>
                        <div>
                            <label className={labelClass}>Period end (empty = lifetime)</label>
                            <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className={`${inputClass} font-mono`} />
                        </div>
                    </>
                )}
                <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={saving || isReadonly || typeId == null || (override && !periodStart)}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className="ml-auto px-3 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                >
                    {saving ? 'Recording...' : 'Record payment'}
                </button>
            </div>
        </div>
    );
}

// ============================================
// Membership types modal
// ============================================

interface TypeForm {
    name: string;
    amount: string;
    renewalMode: RenewalMode;
    graceDays: string;
    active: boolean;
}

const EMPTY_TYPE_FORM: TypeForm = {
    name: '', amount: '0', renewalMode: 'calendar_year', graceDays: '0', active: true,
};

function TypesModal({ isOpen, onClose, types, onChanged }: {
    isOpen: boolean;
    onClose: () => void;
    types: MembershipTypeDTO[];
    onChanged: () => void;
}) {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const [editingId, setEditingId] = useState<number | null>(null);
    const [form, setForm] = useState<TypeForm>(EMPTY_TYPE_FORM);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState<MembershipTypeDTO | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const startEdit = (t: MembershipTypeDTO) => {
        setEditingId(t.id);
        setForm({
            name: t.name,
            amount: String(t.amount),
            renewalMode: t.renewalMode,
            graceDays: String(t.graceDays),
            active: t.active,
        });
    };

    const resetForm = () => {
        setEditingId(null);
        setForm(EMPTY_TYPE_FORM);
    };

    const handleSave = async () => {
        if (!form.name.trim()) {
            error('Name is required');
            return;
        }
        setSaving(true);
        try {
            const url = editingId != null ? `/api/membership/types/${editingId}` : '/api/membership/types';
            const res = await fetch(url, {
                method: editingId != null ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: form.name.trim(),
                    amount: parseFloat(form.amount) || 0,
                    renewalMode: form.renewalMode,
                    graceDays: parseInt(form.graceDays, 10) || 0,
                    active: form.active,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save membership type');
            }
            success(editingId != null ? 'Membership type updated' : 'Membership type created');
            resetForm();
            onChanged();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save membership type');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/membership/types/${deleting.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete membership type');
            }
            success(`Deleted "${deleting.name}"`);
            if (editingId === deleting.id) resetForm();
            setDeleting(null);
            onChanged();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete membership type');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title="Membership types" size="lg">
                <div className="p-6 space-y-4">
                    {types.length === 0 ? (
                        <p className="text-sm text-foreground-muted">
                            No membership types yet. Define one below — members and payments hang off these.
                        </p>
                    ) : (
                        <ul className="divide-y divide-border border border-border rounded-lg">
                            {types.map(t => (
                                <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                                    <span className={`flex-1 truncate ${t.active ? 'text-foreground' : 'text-foreground-muted line-through'}`}>
                                        {t.name}
                                        <span className="ml-2 text-xs text-foreground-muted">
                                            {RENEWAL_MODE_LABELS[t.renewalMode]}
                                            {t.graceDays > 0 && ` · ${t.graceDays}d grace`}
                                            {` · ${t.memberCount} member${t.memberCount === 1 ? '' : 's'}`}
                                        </span>
                                    </span>
                                    <span className="font-mono tabular-nums text-foreground-secondary">{formatCurrency(t.amount)}</span>
                                    <button
                                        type="button"
                                        onClick={() => startEdit(t)}
                                        className="px-2 py-0.5 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setDeleting(t)}
                                        disabled={isReadonly}
                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                        className="px-2 py-0.5 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                    >
                                        Delete
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="border-t border-border pt-4 space-y-3">
                        <h3 className="text-sm font-semibold text-foreground">
                            {editingId != null ? 'Edit type' : 'New type'}
                        </h3>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div className="col-span-2">
                                <label className={labelClass}>Name *</label>
                                <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputClass} placeholder="e.g. Individual" />
                            </div>
                            <div>
                                <label className={labelClass}>Dues amount</label>
                                <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className={`${inputClass} font-mono`} />
                            </div>
                            <div>
                                <label className={labelClass}>Grace days</label>
                                <input type="number" min="0" step="1" value={form.graceDays} onChange={e => setForm({ ...form, graceDays: e.target.value })} className={`${inputClass} font-mono`} />
                            </div>
                            <div className="col-span-2 sm:col-span-3">
                                <label className={labelClass}>Renewal mode</label>
                                <select value={form.renewalMode} onChange={e => setForm({ ...form, renewalMode: e.target.value as RenewalMode })} className={inputClass}>
                                    {RENEWAL_MODES.map(m => <option key={m} value={m}>{RENEWAL_MODE_LABELS[m]}</option>)}
                                </select>
                            </div>
                            <label className="flex items-center gap-2 text-sm text-foreground-secondary self-end pb-2">
                                <input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} className="accent-primary" />
                                Active
                            </label>
                        </div>
                        <div className="flex justify-end gap-3">
                            {editingId != null && (
                                <button type="button" onClick={resetForm} className="px-3 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors">
                                    Cancel edit
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving || isReadonly || !form.name.trim()}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                            >
                                {saving ? 'Saving...' : editingId != null ? 'Save type' : 'Add type'}
                            </button>
                        </div>
                    </div>
                </div>
            </Modal>

            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title="Delete membership type"
                message={deleting
                    ? `Delete "${deleting.name}"? This is blocked while members or payments still reference it — deactivate instead if it's in use.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </>
    );
}

// ============================================
// Main page component
// ============================================

export function MembershipManager() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [members, setMembers] = useState<MemberListItemDTO[]>([]);
    const [types, setTypes] = useState<MembershipTypeDTO[]>([]);
    const [summary, setSummary] = useState<MembershipSummaryDTO | null>(null);
    const [loading, setLoading] = useState(true);

    const [search, setSearch] = useState('');
    const [duesFilter, setDuesFilter] = useState<'all' | DuesStatus>('all');
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Modal state: 'new' = create; number = member id being viewed/edited.
    const [editing, setEditing] = useState<'new' | number | null>(null);
    const [detail, setDetail] = useState<MemberDetailDTO | null>(null);
    const [form, setForm] = useState<MemberForm>(EMPTY_MEMBER_FORM);
    const [saving, setSaving] = useState(false);
    const [typesOpen, setTypesOpen] = useState(false);
    const [deletingMember, setDeletingMember] = useState<MemberDetailDTO | null>(null);
    const [isDeletingMember, setIsDeletingMember] = useState(false);
    const [deletingPaymentId, setDeletingPaymentId] = useState<number | null>(null);

    const fetchMembers = useCallback(async () => {
        try {
            const res = await fetch('/api/membership/members');
            if (!res.ok) throw new Error('Failed to load members');
            setMembers(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load members');
        } finally {
            setLoading(false);
        }
    }, [error]);

    const fetchTypes = useCallback(async () => {
        try {
            const res = await fetch('/api/membership/types');
            if (res.ok) setTypes(await res.json());
        } catch { /* best-effort */ }
    }, []);

    const fetchSummary = useCallback(async () => {
        try {
            const res = await fetch('/api/membership/summary');
            if (res.ok) setSummary(await res.json());
        } catch { /* best-effort */ }
    }, []);

    const refreshAll = useCallback(() => {
        fetchMembers();
        fetchSummary();
        fetchTypes();
    }, [fetchMembers, fetchSummary, fetchTypes]);

    useEffect(() => { refreshAll(); }, [refreshAll]);

    // '/' focuses search (same convention as other list pages).
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            const isInInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
            if (isInInput && e.key === 'Escape' && e.target === searchInputRef.current) {
                e.preventDefault();
                if (search) setSearch('');
                else searchInputRef.current?.blur();
                return;
            }
            if (!isInInput && e.key === '/') {
                e.preventDefault();
                searchInputRef.current?.focus();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [search]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return members.filter(m => {
            if (duesFilter !== 'all' && m.duesStatus !== duesFilter) return false;
            if (!q) return true;
            return m.name.toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q);
        });
    }, [members, search, duesFilter]);

    const openCreate = () => {
        setForm({ ...EMPTY_MEMBER_FORM, joinedDate: todayIso() });
        setDetail(null);
        setEditing('new');
    };

    const openDetail = useCallback(async (id: number) => {
        setEditing(id);
        setDetail(null);
        try {
            const res = await fetch(`/api/membership/members/${id}`);
            if (!res.ok) throw new Error('Failed to load member');
            const data: MemberDetailDTO = await res.json();
            setDetail(data);
            setForm(memberToForm(data));
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load member');
            setEditing(null);
        }
    }, [error]);

    const refreshDetail = useCallback(async () => {
        if (typeof editing !== 'number') return;
        try {
            const res = await fetch(`/api/membership/members/${editing}`);
            if (res.ok) setDetail(await res.json());
        } catch { /* best-effort */ }
        fetchMembers();
        fetchSummary();
    }, [editing, fetchMembers, fetchSummary]);

    const handleSave = async () => {
        if (!form.name.trim()) {
            error('Name is required');
            return;
        }
        setSaving(true);
        try {
            const isNew = editing === 'new';
            const url = isNew ? '/api/membership/members' : `/api/membership/members/${editing}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formToPayload(form)),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save member');
            }
            success(isNew ? 'Member added' : 'Member updated');
            if (isNew) setEditing(null);
            else setDetail(await res.json());
            fetchMembers();
            fetchSummary();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save member');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteMember = async () => {
        if (!deletingMember) return;
        setIsDeletingMember(true);
        try {
            const res = await fetch(`/api/membership/members/${deletingMember.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete member');
            }
            success(`Deleted ${deletingMember.name}`);
            setDeletingMember(null);
            setEditing(null);
            refreshAll();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete member');
        } finally {
            setIsDeletingMember(false);
        }
    };

    const handleDeletePayment = async (paymentId: number) => {
        setDeletingPaymentId(paymentId);
        try {
            const res = await fetch(`/api/membership/payments/${paymentId}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete payment');
            }
            success('Payment deleted');
            await refreshDetail();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete payment');
        } finally {
            setDeletingPaymentId(null);
        }
    };

    const filterButton = (value: 'all' | DuesStatus, label: string) => (
        <button
            key={value}
            type="button"
            onClick={() => setDuesFilter(value)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                duesFilter === value
                    ? 'bg-primary-light text-primary'
                    : 'text-foreground-secondary hover:text-foreground hover:bg-surface-hover'
            }`}
        >
            {label}
        </button>
    );

    const statCard = (label: string, value: string, sub?: string) => (
        <div className="bg-surface border border-border rounded-lg p-4">
            <p className="text-xs uppercase tracking-widest text-foreground-secondary">{label}</p>
            <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-foreground">{value}</p>
            {sub && <p className="mt-0.5 text-xs text-foreground-muted">{sub}</p>}
        </div>
    );

    const currentOnDues = summary
        ? summary.duesStatusCounts.current + summary.duesStatusCounts.lifetime
        : 0;

    return (
        <div className="space-y-4">
            <PageHeader
                title="Members"
                subtitle="Membership roster, dues levels, and payment tracking."
                actions={
                    <>
                        <button
                            type="button"
                            onClick={() => setTypesOpen(true)}
                            className="px-4 py-2 text-sm bg-surface-hover hover:bg-border text-foreground rounded-lg transition-colors whitespace-nowrap"
                        >
                            Membership types
                        </button>
                        <button
                            type="button"
                            onClick={openCreate}
                            disabled={isReadonly}
                            title={isReadonly ? READONLY_TOOLTIP : 'Add member'}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                        >
                            + Add member
                        </button>
                    </>
                }
                toolbar={
                    <FilterBar
                        primary={
                            <input
                                ref={searchInputRef}
                                type="text"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                placeholder="Search by name or email... ( / )"
                                className={`${inputClass} md:max-w-sm`}
                            />
                        }
                        activeCount={duesFilter !== 'all' ? 1 : 0}
                    >
                        <div className="flex gap-1 flex-wrap">
                            {filterButton('all', 'All')}
                            {filterButton('current', 'Current')}
                            {filterButton('lapsed', 'Lapsed')}
                            {filterButton('unpaid', 'Unpaid')}
                            {filterButton('lifetime', 'Lifetime')}
                            {filterButton('exempt', 'Exempt')}
                        </div>
                    </FilterBar>
                }
            />

            <HouseholdBookBanner />

            {summary && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {statCard('Active members', String(summary.activeMemberCount))}
                    {statCard(
                        'Current on dues',
                        String(currentOnDues),
                        summary.upcomingExpirations.length > 0
                            ? `${summary.upcomingExpirations.length} expiring within 60 days`
                            : undefined
                    )}
                    {statCard('Lapsed', String(summary.duesStatusCounts.lapsed))}
                    {statCard('Dues collected YTD', formatCurrency(summary.duesCollectedYtd))}
                </div>
            )}

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading members...</span>
                    </div>
                ) : members.length === 0 ? (
                    <div className="p-12 text-center space-y-2">
                        <p className="text-foreground-muted">No members yet.</p>
                        <p className="text-sm text-foreground-muted">
                            {types.length === 0
                                ? 'Define a membership type first, then add members.'
                                : 'Add your first member to start tracking dues.'}
                        </p>
                        {types.length === 0 && (
                            <button
                                type="button"
                                onClick={() => setTypesOpen(true)}
                                className="mt-2 px-4 py-2 text-sm bg-surface-hover hover:bg-border text-foreground rounded-lg transition-colors"
                            >
                                Set up membership types
                            </button>
                        )}
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No members match the current search or filter.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Name</th>
                                    <th className="px-4 py-2 font-semibold">Type</th>
                                    <th className="px-4 py-2 font-semibold">Status</th>
                                    <th className="px-4 py-2 font-semibold">Dues</th>
                                    <th className="px-4 py-2 font-semibold">Paid through</th>
                                    <th className="px-4 py-2 font-semibold">Email</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {filtered.map(m => (
                                    <tr
                                        key={m.id}
                                        onClick={() => openDetail(m.id)}
                                        className="hover:bg-surface-hover/50 transition-colors cursor-pointer"
                                    >
                                        <td className="px-4 py-3 text-sm text-foreground">{m.name}</td>
                                        <td className="px-4 py-3 text-sm text-foreground-secondary">
                                            {m.membershipTypeName || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${STATUS_CHIP[m.status]}`}>
                                                {STATUS_LABELS[m.status]}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3"><DuesChip status={m.duesStatus} /></td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-foreground-secondary">
                                            {m.hasLifetime ? 'Lifetime' : m.paidThrough || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-foreground-secondary max-w-xs truncate">
                                            {m.email || <span className="text-foreground-muted">—</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Create / detail modal */}
            <Modal
                isOpen={!!editing}
                onClose={() => setEditing(null)}
                title={editing === 'new' ? 'Add member' : detail?.name ?? 'Member'}
                size="xl"
            >
                <div className="p-6">
                    {editing !== 'new' && !detail ? (
                        <div className="p-8 flex items-center justify-center gap-3">
                            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                            <span className="text-foreground-secondary">Loading member...</span>
                        </div>
                    ) : (
                        <form
                            className="space-y-4"
                            onSubmit={(e) => { e.preventDefault(); handleSave(); }}
                        >
                            {detail && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <DuesChip status={detail.duesStatus} />
                                    <span className="text-xs text-foreground-muted font-mono tabular-nums">
                                        {detail.hasLifetime
                                            ? 'Lifetime member'
                                            : detail.paidThrough
                                                ? `Paid through ${detail.paidThrough}`
                                                : 'No dues payments recorded'}
                                    </span>
                                    <span className="text-xs text-foreground-muted">
                                        · {detail.attendanceCount} meeting{detail.attendanceCount === 1 ? '' : 's'} attended
                                    </span>
                                </div>
                            )}

                            <MemberFields form={form} setForm={setForm} types={types} />

                            <div className="flex justify-end gap-3 pt-2 border-t border-border">
                                {detail && (
                                    <button
                                        type="button"
                                        onClick={() => setDeletingMember(detail)}
                                        disabled={isReadonly}
                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                        className="mr-auto px-3 py-2 text-sm rounded-lg text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                    >
                                        Delete member
                                    </button>
                                )}
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
                                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                                >
                                    {saving ? 'Saving...' : 'Save'}
                                </button>
                            </div>

                            {detail && (
                                <div className="pt-2 border-t border-border space-y-3">
                                    <h3 className="text-sm font-semibold text-foreground">Record payment</h3>
                                    <RecordPaymentForm
                                        key={`${detail.id}-${detail.payments.length}`}
                                        member={detail}
                                        types={types}
                                        onRecorded={refreshDetail}
                                    />

                                    <h3 className="text-sm font-semibold text-foreground pt-2">Payment history</h3>
                                    {detail.payments.length === 0 ? (
                                        <p className="text-sm text-foreground-muted">No payments recorded yet.</p>
                                    ) : (
                                        <ul className="divide-y divide-border border border-border rounded-lg">
                                            {detail.payments.map(p => (
                                                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                                                    <span className="font-mono tabular-nums text-foreground">{p.paidDate}</span>
                                                    <span className="font-mono tabular-nums text-positive">{formatCurrency(p.amount)}</span>
                                                    <span className="text-xs text-foreground-muted">{METHOD_LABELS[p.method]}</span>
                                                    {p.reference && <span className="text-xs text-foreground-muted">#{p.reference}</span>}
                                                    <span className="ml-auto font-mono tabular-nums text-xs text-foreground-secondary">
                                                        {p.periodEnd ? `${p.periodStart} → ${p.periodEnd}` : `${p.periodStart} → lifetime`}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDeletePayment(p.id)}
                                                        disabled={isReadonly || deletingPaymentId === p.id}
                                                        title={isReadonly ? READONLY_TOOLTIP : 'Delete payment'}
                                                        className="px-2 py-0.5 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                                    >
                                                        {deletingPaymentId === p.id ? 'Deleting...' : 'Delete'}
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}

                                    {detail.attendance.length > 0 && (
                                        <>
                                            <h3 className="text-sm font-semibold text-foreground pt-2">Recent meetings</h3>
                                            <ul className="divide-y divide-border border border-border rounded-lg">
                                                {detail.attendance.slice(0, 8).map(a => (
                                                    <li key={a.meetingId} className="flex items-center gap-3 px-3 py-2 text-sm">
                                                        <span className="font-mono tabular-nums text-foreground-secondary">{a.meetingDate}</span>
                                                        <span className="flex-1 truncate text-foreground">{a.meetingTitle}</span>
                                                        <span className={`px-2 py-0.5 text-xs rounded-md ${
                                                            a.status === 'present'
                                                                ? 'bg-positive/10 text-positive'
                                                                : a.status === 'excused'
                                                                    ? 'bg-warning/10 text-warning'
                                                                    : 'bg-surface-hover text-foreground-muted'
                                                        }`}>
                                                            {a.status}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </>
                                    )}
                                </div>
                            )}
                        </form>
                    )}
                </div>
            </Modal>

            <TypesModal
                isOpen={typesOpen}
                onClose={() => setTypesOpen(false)}
                types={types}
                onChanged={refreshAll}
            />

            <ConfirmationDialog
                isOpen={!!deletingMember}
                onConfirm={handleDeleteMember}
                onCancel={() => setDeletingMember(null)}
                title="Delete member"
                message={deletingMember
                    ? `Delete ${deletingMember.name}? All of their payment and attendance records will be deleted too.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeletingMember}
            />
        </div>
    );
}
