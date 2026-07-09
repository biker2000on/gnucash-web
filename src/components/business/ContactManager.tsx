'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import type {
    ContactKind,
    CustomerDTO,
    VendorDTO,
    JobDTO,
    BilltermDTO,
    TaxtableDTO,
    AddressDTO,
} from '@/lib/business-types';

type ContactDTO = CustomerDTO | VendorDTO;

interface ContactManagerProps {
    kind: ContactKind;
}

interface AddressForm {
    name: string;
    addr1: string;
    addr2: string;
    addr3: string;
    addr4: string;
    phone: string;
    fax: string;
    email: string;
}

interface ContactForm {
    name: string;
    notes: string;
    active: boolean;
    currency: string;
    discount: string;
    credit: string;
    terms: string;
    taxtable: string;
    address: AddressForm;
    shipAddress: AddressForm;
}

const EMPTY_ADDRESS: AddressForm = {
    name: '', addr1: '', addr2: '', addr3: '', addr4: '', phone: '', fax: '', email: '',
};

const EMPTY_FORM: ContactForm = {
    name: '',
    notes: '',
    active: true,
    currency: 'USD',
    discount: '0',
    credit: '0',
    terms: '',
    taxtable: '',
    address: { ...EMPTY_ADDRESS },
    shipAddress: { ...EMPTY_ADDRESS },
};

function addressToForm(address: AddressDTO | undefined): AddressForm {
    return {
        name: address?.name ?? '',
        addr1: address?.addr1 ?? '',
        addr2: address?.addr2 ?? '',
        addr3: address?.addr3 ?? '',
        addr4: address?.addr4 ?? '',
        phone: address?.phone ?? '',
        fax: address?.fax ?? '',
        email: address?.email ?? '',
    };
}

function formToAddress(form: AddressForm) {
    return {
        name: form.name || null,
        addr1: form.addr1 || null,
        addr2: form.addr2 || null,
        addr3: form.addr3 || null,
        addr4: form.addr4 || null,
        phone: form.phone || null,
        fax: form.fax || null,
        email: form.email || null,
    };
}

function contactToForm(contact: ContactDTO, kind: ContactKind): ContactForm {
    return {
        name: contact.name,
        notes: contact.notes,
        active: contact.active,
        currency: contact.currency,
        discount: kind === 'customer' ? String((contact as CustomerDTO).discount) : '0',
        credit: kind === 'customer' ? String((contact as CustomerDTO).credit) : '0',
        terms: contact.terms ?? '',
        taxtable: contact.taxtable ?? '',
        address: addressToForm(contact.address),
        shipAddress: kind === 'customer'
            ? addressToForm((contact as CustomerDTO).shipAddress)
            : { ...EMPTY_ADDRESS },
    };
}

function formToPayload(form: ContactForm, kind: ContactKind) {
    return {
        name: form.name.trim(),
        notes: form.notes,
        active: form.active,
        currency: form.currency,
        terms: form.terms || null,
        taxtable: form.taxtable || null,
        address: formToAddress(form.address),
        ...(kind === 'customer' ? {
            discount: parseFloat(form.discount) || 0,
            credit: parseFloat(form.credit) || 0,
            shipAddress: formToAddress(form.shipAddress),
        } : {}),
    };
}

/** Payload that flips only the active flag, preserving everything else. */
function contactToTogglePayload(contact: ContactDTO, kind: ContactKind) {
    const form = contactToForm(contact, kind);
    return { ...formToPayload(form, kind), active: !contact.active };
}

const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

function AddressFields({ value, onChange, disabled }: {
    value: AddressForm;
    onChange: (next: AddressForm) => void;
    disabled?: boolean;
}) {
    const set = (field: keyof AddressForm) =>
        (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [field]: e.target.value });

    return (
        <div className="space-y-2">
            <div>
                <label className={labelClass}>Contact name</label>
                <input type="text" value={value.name} onChange={set('name')} disabled={disabled} className={inputClass} placeholder="Attention / contact person" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input type="text" value={value.addr1} onChange={set('addr1')} disabled={disabled} className={inputClass} placeholder="Address line 1" />
                <input type="text" value={value.addr2} onChange={set('addr2')} disabled={disabled} className={inputClass} placeholder="Address line 2" />
                <input type="text" value={value.addr3} onChange={set('addr3')} disabled={disabled} className={inputClass} placeholder="Address line 3" />
                <input type="text" value={value.addr4} onChange={set('addr4')} disabled={disabled} className={inputClass} placeholder="Address line 4" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                    <label className={labelClass}>Phone</label>
                    <input type="text" value={value.phone} onChange={set('phone')} disabled={disabled} className={inputClass} />
                </div>
                <div>
                    <label className={labelClass}>Fax</label>
                    <input type="text" value={value.fax} onChange={set('fax')} disabled={disabled} className={inputClass} />
                </div>
                <div>
                    <label className={labelClass}>Email</label>
                    <input type="email" value={value.email} onChange={set('email')} disabled={disabled} className={inputClass} />
                </div>
            </div>
        </div>
    );
}

/** Inline jobs list + add form shown while editing an existing contact. */
function JobsSection({ ownerGuid, kind }: { ownerGuid: string; kind: ContactKind }) {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const [jobs, setJobs] = useState<JobDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [newName, setNewName] = useState('');
    const [newReference, setNewReference] = useState('');
    const [busy, setBusy] = useState(false);

    const fetchJobs = useCallback(async () => {
        try {
            const res = await fetch(`/api/business/jobs?owner=${ownerGuid}`);
            if (!res.ok) throw new Error('Failed to load jobs');
            setJobs(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load jobs');
        } finally {
            setLoading(false);
        }
    }, [ownerGuid, error]);

    useEffect(() => { fetchJobs(); }, [fetchJobs]);

    // Enter in the job inputs adds the job instead of submitting the
    // surrounding contact form.
    const handleAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            handleAdd();
        }
    };

    const handleAdd = async () => {
        if (!newName.trim()) return;
        setBusy(true);
        try {
            const res = await fetch('/api/business/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newName.trim(),
                    reference: newReference.trim(),
                    ownerType: kind,
                    ownerGuid,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to create job');
            }
            setNewName('');
            setNewReference('');
            success('Job created');
            await fetchJobs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to create job');
        } finally {
            setBusy(false);
        }
    };

    const handleToggle = async (job: JobDTO) => {
        setBusy(true);
        try {
            const res = await fetch(`/api/business/jobs/${job.guid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: job.name,
                    reference: job.reference,
                    active: !job.active,
                    ownerType: kind,
                    ownerGuid,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to update job');
            }
            await fetchJobs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update job');
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (job: JobDTO) => {
        setBusy(true);
        try {
            const res = await fetch(`/api/business/jobs/${job.guid}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete job');
            }
            const result = await res.json();
            success(result.deleted ? `Deleted job "${job.name}"` : `Job "${job.name}" is referenced by invoices — deactivated instead`);
            await fetchJobs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete job');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-2">
            {loading ? (
                <p className="text-sm text-foreground-muted">Loading jobs...</p>
            ) : jobs.length === 0 ? (
                <p className="text-sm text-foreground-muted">No jobs yet.</p>
            ) : (
                <ul className="divide-y divide-border border border-border rounded-lg">
                    {jobs.map(job => (
                        <li key={job.guid} className="flex items-center gap-3 px-3 py-2 text-sm">
                            <span className="font-mono tabular-nums text-xs text-foreground-muted">{job.id}</span>
                            <span className={`flex-1 truncate ${job.active ? 'text-foreground' : 'text-foreground-muted line-through'}`}>
                                {job.name}
                                {job.reference && <span className="ml-2 text-foreground-muted">({job.reference})</span>}
                            </span>
                            <button
                                type="button"
                                onClick={() => handleToggle(job)}
                                disabled={busy || isReadonly}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                className="px-2 py-0.5 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                            >
                                {job.active ? 'Deactivate' : 'Activate'}
                            </button>
                            <button
                                type="button"
                                onClick={() => handleDelete(job)}
                                disabled={busy || isReadonly}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                className="px-2 py-0.5 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                            >
                                Delete
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex gap-2">
                <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={handleAddKeyDown}
                    placeholder="New job name..."
                    disabled={isReadonly}
                    className={inputClass}
                />
                <input
                    type="text"
                    value={newReference}
                    onChange={(e) => setNewReference(e.target.value)}
                    onKeyDown={handleAddKeyDown}
                    placeholder="Reference (optional)"
                    disabled={isReadonly}
                    className={inputClass}
                />
                <button
                    type="button"
                    onClick={handleAdd}
                    disabled={busy || !newName.trim() || isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className="px-3 py-2 text-sm bg-surface-hover hover:bg-border text-foreground rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
                >
                    + Add Job
                </button>
            </div>
        </div>
    );
}

export function ContactManager({ kind }: ContactManagerProps) {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const singular = kind === 'customer' ? 'Customer' : 'Vendor';
    const plural = kind === 'customer' ? 'Customers' : 'Vendors';
    const apiBase = `/api/business/${kind}s`;

    const [contacts, setContacts] = useState<ContactDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('active');

    const [billterms, setBillterms] = useState<BilltermDTO[]>([]);
    const [taxtables, setTaxtables] = useState<TaxtableDTO[]>([]);
    const [currencies, setCurrencies] = useState<string[]>(['USD']);

    // Modal state: null = closed, 'new' = create, otherwise editing that contact.
    const [editing, setEditing] = useState<'new' | ContactDTO | null>(null);
    const [form, setForm] = useState<ContactForm>(EMPTY_FORM);
    const [showShipping, setShowShipping] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState<ContactDTO | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const fetchContacts = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (search.trim()) params.set('search', search.trim());
            params.set('active', activeFilter);
            const res = await fetch(`${apiBase}?${params}`);
            if (!res.ok) throw new Error(`Failed to load ${plural.toLowerCase()}`);
            setContacts(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : `Failed to load ${plural.toLowerCase()}`);
        } finally {
            setLoading(false);
        }
    }, [apiBase, search, activeFilter, plural, error]);

    // Debounced refetch on search/filter changes.
    useEffect(() => {
        const t = setTimeout(fetchContacts, 250);
        return () => clearTimeout(t);
    }, [fetchContacts]);

    // Reference data for the form selects (best-effort).
    useEffect(() => {
        fetch('/api/business/billterms')
            .then(res => (res.ok ? res.json() : []))
            .then(setBillterms)
            .catch(() => {});
        fetch('/api/business/taxtables')
            .then(res => (res.ok ? res.json() : []))
            .then(setTaxtables)
            .catch(() => {});
        fetch('/api/commodities?type=CURRENCY')
            .then(res => (res.ok ? res.json() : []))
            .then((rows: Array<{ mnemonic: string }>) => {
                const mnemonics = rows.map(r => r.mnemonic).filter(Boolean);
                if (mnemonics.length > 0) setCurrencies(mnemonics);
            })
            .catch(() => {});
    }, []);

    const openCreate = useCallback(() => {
        setForm({ ...EMPTY_FORM, currency: currencies.includes('USD') ? 'USD' : currencies[0] ?? 'USD' });
        setShowShipping(false);
        setEditing('new');
    }, [currencies]);

    // The global 'n' shortcut dispatches 'open-new-transaction'; no ledger is
    // mounted on business pages, so repurpose it here for "new contact"
    // without clobbering the transaction shortcut elsewhere.
    useEffect(() => {
        const handler = () => {
            if (!isReadonly) openCreate();
        };
        window.addEventListener('open-new-transaction', handler);
        return () => window.removeEventListener('open-new-transaction', handler);
    }, [openCreate, isReadonly]);

    // '/' focuses the search input; Escape in the search clears then blurs
    // (same pattern as TransactionJournal).
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            const isInInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

            if (isInInput && e.key === 'Escape' && e.target === searchInputRef.current) {
                e.preventDefault();
                if (search) {
                    setSearch('');
                } else {
                    searchInputRef.current?.blur();
                }
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

    const openEdit = (contact: ContactDTO) => {
        setForm(contactToForm(contact, kind));
        setShowShipping(false);
        setEditing(contact);
    };

    const handleSave = async () => {
        if (!form.name.trim()) {
            error('Name is required');
            return;
        }
        setSaving(true);
        try {
            const isNew = editing === 'new';
            const url = isNew ? apiBase : `${apiBase}/${(editing as ContactDTO).guid}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formToPayload(form, kind)),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || `Failed to save ${singular.toLowerCase()}`);
            }
            success(isNew ? `${singular} created` : `${singular} updated`);
            setEditing(null);
            await fetchContacts();
        } catch (err) {
            error(err instanceof Error ? err.message : `Failed to save ${singular.toLowerCase()}`);
        } finally {
            setSaving(false);
        }
    };

    const handleToggleActive = async (contact: ContactDTO) => {
        try {
            const res = await fetch(`${apiBase}/${contact.guid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(contactToTogglePayload(contact, kind)),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || `Failed to update ${singular.toLowerCase()}`);
            }
            success(contact.active ? `Deactivated ${contact.name}` : `Activated ${contact.name}`);
            await fetchContacts();
        } catch (err) {
            error(err instanceof Error ? err.message : `Failed to update ${singular.toLowerCase()}`);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`${apiBase}/${deleting.guid}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || `Failed to delete ${singular.toLowerCase()}`);
            }
            const result = await res.json();
            success(result.deleted
                ? `Deleted ${deleting.name}`
                : `${deleting.name} is referenced by jobs or invoices — deactivated instead`);
            setDeleting(null);
            await fetchContacts();
        } catch (err) {
            error(err instanceof Error ? err.message : `Failed to delete ${singular.toLowerCase()}`);
        } finally {
            setIsDeleting(false);
        }
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

    const emailOrPhone = (contact: ContactDTO) =>
        contact.address.email || contact.address.phone || null;

    const modalTitle = editing === 'new' ? `New ${singular}` : `Edit ${singular}`;

    return (
        <div className="space-y-4">
            <PageHeader
                title={plural}
                subtitle={kind === 'customer'
                    ? 'People and companies you invoice.'
                    : 'People and companies that bill you.'}
                actions={
                    <button
                        type="button"
                        onClick={openCreate}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : `New ${singular} (n)`}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        + New {singular}
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
                                placeholder="Search by name, id, or email... ( / )"
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
                        <span className="text-foreground-secondary">Loading {plural.toLowerCase()}...</span>
                    </div>
                ) : contacts.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No {plural.toLowerCase()} found. Create one to get started.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Name</th>
                                    <th className="px-4 py-2 font-semibold">ID</th>
                                    <th className="px-4 py-2 font-semibold">Email / Phone</th>
                                    <th className="px-4 py-2 font-semibold">Terms</th>
                                    <th className="px-4 py-2 font-semibold text-right">Jobs</th>
                                    <th className="px-4 py-2 font-semibold">Status</th>
                                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {contacts.map(contact => (
                                    <tr key={contact.guid} className="hover:bg-surface-hover/50 transition-colors">
                                        <td className="px-4 py-3 text-sm text-foreground">{contact.name}</td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-foreground-secondary">{contact.id}</td>
                                        <td className="px-4 py-3 text-sm text-foreground-secondary max-w-xs truncate">
                                            {emailOrPhone(contact) || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-foreground-secondary">
                                            {contact.termsName || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-foreground-secondary">
                                            {contact.jobCount}
                                        </td>
                                        <td className="px-4 py-3">
                                            {contact.active ? (
                                                <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-positive/10 text-positive">Active</span>
                                            ) : (
                                                <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-surface-hover text-foreground-muted">Inactive</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-right whitespace-nowrap">
                                            <button
                                                type="button"
                                                onClick={() => openEdit(contact)}
                                                className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleToggleActive(contact)}
                                                disabled={isReadonly}
                                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                className="ml-1 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                                            >
                                                {contact.active ? 'Deactivate' : 'Activate'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setDeleting(contact)}
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

            {/* Create / edit modal */}
            <Modal isOpen={!!editing} onClose={() => setEditing(null)} title={modalTitle} size="lg">
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSave();
                    }}
                >
                    {editing !== 'new' && editing && (
                        <p className="text-xs text-foreground-muted font-mono tabular-nums">
                            {singular} #{editing.id}
                        </p>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="sm:col-span-2">
                            <label className={labelClass}>Name *</label>
                            <input
                                type="text"
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                className={inputClass}
                                placeholder={`${singular} name`}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Currency</label>
                            <select
                                value={form.currency}
                                onChange={(e) => setForm({ ...form, currency: e.target.value })}
                                className={inputClass}
                            >
                                {currencies.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>Bill terms</label>
                            <select
                                value={form.terms}
                                onChange={(e) => setForm({ ...form, terms: e.target.value })}
                                className={inputClass}
                            >
                                <option value="">None</option>
                                {billterms.map(t => (
                                    <option key={t.guid} value={t.guid}>{t.name} (net {t.dueDays})</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>Tax table</label>
                            <select
                                value={form.taxtable}
                                onChange={(e) => setForm({ ...form, taxtable: e.target.value })}
                                className={inputClass}
                            >
                                <option value="">None</option>
                                {taxtables.map(t => (
                                    <option key={t.guid} value={t.guid}>{t.name}</option>
                                ))}
                            </select>
                        </div>
                        {kind === 'customer' && (
                            <>
                                <div>
                                    <label className={labelClass}>Credit limit</label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={form.credit}
                                        onChange={(e) => setForm({ ...form, credit: e.target.value })}
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
                                        value={form.discount}
                                        onChange={(e) => setForm({ ...form, discount: e.target.value })}
                                        className={`${inputClass} font-mono`}
                                    />
                                </div>
                            </>
                        )}
                    </div>

                    <div>
                        <h3 className="text-sm font-semibold text-foreground mb-2">Billing address</h3>
                        <AddressFields value={form.address} onChange={(address) => setForm({ ...form, address })} />
                    </div>

                    {kind === 'customer' && (
                        <div>
                            <button
                                type="button"
                                onClick={() => setShowShipping(!showShipping)}
                                className="text-sm text-primary hover:text-primary-hover transition-colors"
                            >
                                {showShipping ? '− Hide shipping address' : '+ Shipping address'}
                            </button>
                            {showShipping && (
                                <div className="mt-2">
                                    <AddressFields value={form.shipAddress} onChange={(shipAddress) => setForm({ ...form, shipAddress })} />
                                </div>
                            )}
                        </div>
                    )}

                    <div>
                        <label className={labelClass}>Notes</label>
                        <textarea
                            value={form.notes}
                            onChange={(e) => setForm({ ...form, notes: e.target.value })}
                            rows={2}
                            className={`${inputClass} resize-none`}
                            placeholder="Optional notes..."
                        />
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

                    {editing !== 'new' && editing && (
                        <div className="pt-2 border-t border-border">
                            <h3 className="text-sm font-semibold text-foreground mb-2">Jobs</h3>
                            <JobsSection ownerGuid={editing.guid} kind={kind} />
                        </div>
                    )}

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

            {/* Delete confirmation */}
            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title={`Delete ${singular}`}
                message={deleting
                    ? `Delete ${deleting.name}? If this ${singular.toLowerCase()} is referenced by jobs or invoices it will be deactivated instead of deleted.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
