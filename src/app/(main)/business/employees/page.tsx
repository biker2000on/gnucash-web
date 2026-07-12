'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import type { EmployeeDTO, EmployeeVoucherSummary } from '@/lib/business/employees.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

interface EmployeeForm {
    username: string;
    name: string;
    language: string;
    active: boolean;
    currency: string;
    workday: string;
    rate: string;
    addr1: string;
    addr2: string;
    phone: string;
    email: string;
}

const EMPTY_FORM: EmployeeForm = {
    username: '', name: '', language: '', active: true, currency: 'USD',
    workday: '8', rate: '', addr1: '', addr2: '', phone: '', email: '',
};

function employeeToForm(e: EmployeeDTO): EmployeeForm {
    return {
        username: e.username,
        name: e.name ?? '',
        language: e.language,
        active: e.active,
        currency: e.currency,
        workday: String(e.workday),
        rate: String(e.rate),
        addr1: e.address.addr1 ?? '',
        addr2: e.address.addr2 ?? '',
        phone: e.address.phone ?? '',
        email: e.address.email ?? '',
    };
}

function formToPayload(form: EmployeeForm) {
    return {
        username: form.username.trim(),
        language: form.language,
        active: form.active,
        currency: form.currency,
        workday: parseFloat(form.workday) || 0,
        rate: parseFloat(form.rate) || 0,
        address: {
            name: form.name.trim() || null,
            addr1: form.addr1 || null,
            addr2: form.addr2 || null,
            phone: form.phone || null,
            email: form.email || null,
        },
    };
}

/** Employee Report panel: voucher totals + per-month breakdown. */
function EmployeeReportPanel({ employeeGuid }: { employeeGuid: string }) {
    const [summary, setSummary] = useState<EmployeeVoucherSummary | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/business/employees/${employeeGuid}/report`)
            .then((res) => (res.ok ? res.json() : Promise.reject()))
            .then((data: { summary: EmployeeVoucherSummary }) => {
                if (!cancelled) setSummary(data.summary);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => { cancelled = true; };
    }, [employeeGuid]);

    if (failed) {
        return <p className="px-9 py-3 text-sm text-error">Failed to load the employee report.</p>;
    }
    if (!summary) {
        return <p className="px-9 py-3 text-sm text-foreground-muted">Loading voucher summary...</p>;
    }
    if (summary.voucherCount === 0 && summary.draftCount === 0) {
        return (
            <p className="px-9 py-3 text-sm text-foreground-muted">
                No expense vouchers for this employee yet.{' '}
                <Link href="/business/vouchers" className="text-primary hover:text-primary-hover transition-colors">
                    Create one →
                </Link>
            </p>
        );
    }

    return (
        <div className="px-9 py-3 space-y-2">
            <div className="flex flex-wrap gap-x-8 gap-y-1 text-[13px]">
                <span className="text-foreground-secondary">
                    Vouchers: <span className="font-mono text-foreground" style={TNUM}>{summary.voucherCount} posted</span>
                    {summary.draftCount > 0 && (
                        <span className="font-mono text-foreground-muted" style={TNUM}> + {summary.draftCount} draft</span>
                    )}
                </span>
                <span className="text-foreground-secondary">
                    Total: <span className="font-mono text-foreground" style={TNUM}>{formatCurrency(summary.totalPosted)}</span>
                </span>
                <span className="text-foreground-secondary">
                    Reimbursed: <span className="font-mono text-foreground" style={TNUM}>{formatCurrency(summary.paid)}</span>
                </span>
                <span className="text-foreground-secondary">
                    Outstanding:{' '}
                    <span className={`font-mono ${summary.outstanding > 0.005 ? 'text-negative' : 'text-foreground'}`} style={TNUM}>
                        {formatCurrency(summary.outstanding)}
                    </span>
                </span>
            </div>
            {summary.byMonth.length > 0 && (
                <table className="text-[13px]">
                    <thead>
                        <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border/50">
                            <th className="pr-6 py-1 text-left">Month</th>
                            <th className="pr-6 py-1 text-right">Vouchered</th>
                            <th className="py-1 text-right">Outstanding</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                        {summary.byMonth.map((m) => (
                            <tr key={m.month}>
                                <td className="pr-6 py-1 font-mono text-foreground-secondary" style={TNUM}>{m.month}</td>
                                <td className="pr-6 py-1 text-right font-mono text-foreground" style={TNUM}>{formatCurrency(m.total)}</td>
                                <td className={`py-1 text-right font-mono ${m.outstanding > 0.005 ? 'text-foreground' : 'text-foreground-muted'}`} style={TNUM}>
                                    {formatCurrency(m.outstanding)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

export default function EmployeesPage() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [employees, setEmployees] = useState<EmployeeDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('active');
    const [currencies, setCurrencies] = useState<string[]>(['USD']);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const [editing, setEditing] = useState<'new' | EmployeeDTO | null>(null);
    const [form, setForm] = useState<EmployeeForm>(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState<EmployeeDTO | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const fetchEmployees = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (search.trim()) params.set('search', search.trim());
            params.set('active', activeFilter);
            const res = await fetch(`/api/business/employees?${params}`);
            if (!res.ok) throw new Error('Failed to load employees');
            setEmployees(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load employees');
        } finally {
            setLoading(false);
        }
    }, [search, activeFilter, error]);

    useEffect(() => {
        const t = setTimeout(fetchEmployees, 250);
        return () => clearTimeout(t);
    }, [fetchEmployees]);

    useEffect(() => {
        fetch('/api/commodities?type=CURRENCY')
            .then((res) => (res.ok ? res.json() : []))
            .then((rows: Array<{ mnemonic: string }>) => {
                const mnemonics = rows.map((r) => r.mnemonic).filter(Boolean);
                if (mnemonics.length > 0) setCurrencies(mnemonics);
            })
            .catch(() => {});
    }, []);

    const openCreate = useCallback(() => {
        setForm({ ...EMPTY_FORM, currency: currencies.includes('USD') ? 'USD' : currencies[0] ?? 'USD' });
        setEditing('new');
    }, [currencies]);

    useEffect(() => {
        const handler = () => {
            if (!isReadonly) openCreate();
        };
        window.addEventListener('open-new-transaction', handler);
        return () => window.removeEventListener('open-new-transaction', handler);
    }, [openCreate, isReadonly]);

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

    const handleSave = async () => {
        if (!form.username.trim()) {
            error('Username is required');
            return;
        }
        setSaving(true);
        try {
            const isNew = editing === 'new';
            const res = await fetch(
                isNew ? '/api/business/employees' : `/api/business/employees/${(editing as EmployeeDTO).guid}`,
                {
                    method: isNew ? 'POST' : 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(formToPayload(form)),
                },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save employee');
            }
            success(isNew ? 'Employee created' : 'Employee updated');
            setEditing(null);
            await fetchEmployees();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save employee');
        } finally {
            setSaving(false);
        }
    };

    const handleToggleActive = async (employee: EmployeeDTO) => {
        try {
            const payload = { ...formToPayload(employeeToForm(employee)), active: !employee.active };
            const res = await fetch(`/api/business/employees/${employee.guid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to update employee');
            }
            success(employee.active ? `Deactivated ${employee.username}` : `Activated ${employee.username}`);
            await fetchEmployees();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update employee');
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/business/employees/${deleting.guid}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete employee');
            }
            const result = await res.json();
            success(result.deleted
                ? `Deleted ${deleting.username}`
                : `${deleting.username} has vouchers — deactivated instead`);
            setDeleting(null);
            await fetchEmployees();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete employee');
        } finally {
            setIsDeleting(false);
        }
    };

    const toggleExpanded = (guid: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(guid)) next.delete(guid);
            else next.add(guid);
            return next;
        });
    };

    const filterButton = (value: 'all' | 'active' | 'inactive', label: string) => (
        <button
            type="button"
            onClick={() => setActiveFilter(value)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                activeFilter === value
                    ? 'bg-primary-light text-primary'
                    : 'text-foreground-secondary hover:text-foreground hover:bg-surface-hover'
            }`}
        >
            {label}
        </button>
    );

    return (
        <div className="space-y-4">
            <PageHeader
                title="Employees"
                subtitle="People whose expenses you reimburse through expense vouchers."
                actions={
                    <button
                        type="button"
                        onClick={openCreate}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : 'New Employee (n)'}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        + New Employee
                    </button>
                }
                toolbar={
                    <FilterBar
                        primary={
                            <input
                                ref={searchInputRef}
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search by username, id, name, or email... ( / )"
                                className={`${inputClass} md:max-w-sm`}
                            />
                        }
                        activeCount={activeFilter !== 'active' ? 1 : 0}
                    >
                        <div className="flex gap-1">
                            {filterButton('active', 'Active')}
                            {filterButton('inactive', 'Inactive')}
                            {filterButton('all', 'All')}
                        </div>
                    </FilterBar>
                }
            />

            <HouseholdBookBanner />

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading employees...</span>
                    </div>
                ) : employees.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No employees found. Create one to get started.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Username</th>
                                    <th className="px-4 py-2 font-semibold">Name</th>
                                    <th className="px-4 py-2 font-semibold">ID</th>
                                    <th className="px-4 py-2 font-semibold">Email / Phone</th>
                                    <th className="px-4 py-2 font-semibold text-right">Rate</th>
                                    <th className="px-4 py-2 font-semibold text-right">Vouchers</th>
                                    <th className="px-4 py-2 font-semibold">Status</th>
                                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {employees.map((employee) => {
                                    const isOpen = expanded.has(employee.guid);
                                    return (
                                        <Fragment key={employee.guid}>
                                            <tr
                                                onClick={() => toggleExpanded(employee.guid)}
                                                className="hover:bg-surface-hover/50 transition-colors cursor-pointer"
                                            >
                                                <td className="px-4 py-2.5 text-foreground">
                                                    <span className="mr-2 inline-block w-3 text-foreground-muted">
                                                        {isOpen ? '▾' : '▸'}
                                                    </span>
                                                    {employee.username}
                                                </td>
                                                <td className="px-4 py-2.5 text-foreground-secondary">
                                                    {employee.name || <span className="text-foreground-muted">—</span>}
                                                </td>
                                                <td className="px-4 py-2.5 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{employee.id}</td>
                                                <td className="px-4 py-2.5 text-foreground-secondary max-w-xs truncate">
                                                    {employee.address.email || employee.address.phone || <span className="text-foreground-muted">—</span>}
                                                </td>
                                                <td className="px-4 py-2.5 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                                    {employee.rate > 0 ? formatCurrency(employee.rate, employee.currency) : <span className="text-foreground-muted">—</span>}
                                                </td>
                                                <td className="px-4 py-2.5 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                                    {employee.voucherCount}
                                                </td>
                                                <td className="px-4 py-2.5">
                                                    {employee.active ? (
                                                        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-positive/10 text-positive">Active</span>
                                                    ) : (
                                                        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-surface-hover text-foreground-muted">Inactive</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setForm(employeeToForm(employee));
                                                            setEditing(employee);
                                                        }}
                                                        className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleToggleActive(employee)}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                        className="ml-1 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                                                    >
                                                        {employee.active ? 'Deactivate' : 'Activate'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setDeleting(employee)}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                        className="ml-1 px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                                    >
                                                        Delete
                                                    </button>
                                                </td>
                                            </tr>
                                            {isOpen && (
                                                <tr className="bg-background-tertiary/30">
                                                    <td colSpan={8} className="p-0">
                                                        <EmployeeReportPanel employeeGuid={employee.guid} />
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Create / edit modal */}
            <Modal
                isOpen={!!editing}
                onClose={() => setEditing(null)}
                title={editing === 'new' ? 'New Employee' : 'Edit Employee'}
                size="lg"
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSave();
                    }}
                >
                    {editing !== 'new' && editing && (
                        <p className="text-xs text-foreground-muted font-mono tabular-nums">Employee #{editing.id}</p>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Username *</label>
                            <input
                                type="text"
                                value={form.username}
                                onChange={(e) => setForm({ ...form, username: e.target.value })}
                                className={inputClass}
                                placeholder="Login / short name"
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Name</label>
                            <input
                                type="text"
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                className={inputClass}
                                placeholder="Full name"
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Currency</label>
                            <select
                                value={form.currency}
                                onChange={(e) => setForm({ ...form, currency: e.target.value })}
                                className={inputClass}
                            >
                                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>Language</label>
                            <input
                                type="text"
                                value={form.language}
                                onChange={(e) => setForm({ ...form, language: e.target.value })}
                                className={inputClass}
                                placeholder="Optional"
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Workday (hours)</label>
                            <input
                                type="number"
                                min="0"
                                step="0.25"
                                value={form.workday}
                                onChange={(e) => setForm({ ...form, workday: e.target.value })}
                                className={`${inputClass} font-mono`}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Default rate</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={form.rate}
                                onChange={(e) => setForm({ ...form, rate: e.target.value })}
                                className={`${inputClass} font-mono`}
                                placeholder="0.00"
                            />
                        </div>
                    </div>

                    <div>
                        <h3 className="text-sm font-semibold text-foreground mb-2">Address</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <input type="text" value={form.addr1} onChange={(e) => setForm({ ...form, addr1: e.target.value })} className={inputClass} placeholder="Address line 1" />
                            <input type="text" value={form.addr2} onChange={(e) => setForm({ ...form, addr2: e.target.value })} className={inputClass} placeholder="Address line 2" />
                            <input type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass} placeholder="Phone" />
                            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} placeholder="Email" />
                        </div>
                    </div>

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
                </form>
            </Modal>

            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title="Delete Employee"
                message={deleting
                    ? `Delete ${deleting.username}? If this employee has expense vouchers they will be deactivated instead of deleted.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
