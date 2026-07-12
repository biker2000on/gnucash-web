'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { OwnerSelector } from '@/components/business/OwnerSelector';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import type { ContactKind } from '@/lib/business-types';
import type { JobExDTO, JobReport } from '@/lib/business/jobs.service';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

interface JobForm {
    name: string;
    reference: string;
    active: boolean;
    ownerType: ContactKind;
    ownerGuid: string;
    rate: string;
}

const EMPTY_FORM: JobForm = {
    name: '', reference: '', active: true, ownerType: 'customer', ownerGuid: '', rate: '',
};

/** Per-job drill-down: documents referencing the job with totals/paid/due. */
function JobReportPanel({ jobGuid }: { jobGuid: string }) {
    const [report, setReport] = useState<JobReport | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/business/jobs/${jobGuid}/report`)
            .then((res) => (res.ok ? res.json() : Promise.reject()))
            .then((data: { report: JobReport }) => {
                if (!cancelled) setReport(data.report);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => { cancelled = true; };
    }, [jobGuid]);

    if (failed) {
        return <p className="px-9 py-3 text-sm text-error">Failed to load the job report.</p>;
    }
    if (!report) {
        return <p className="px-9 py-3 text-sm text-foreground-muted">Loading job report...</p>;
    }
    if (report.documents.length === 0) {
        return (
            <p className="px-9 py-3 text-sm text-foreground-muted">
                No invoices or bills reference this job yet.
            </p>
        );
    }

    return (
        <div className="px-9 py-3">
            <table className="w-full text-[13px]">
                <thead>
                    <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border/50">
                        <th className="px-2 py-1.5 text-left">#</th>
                        <th className="px-2 py-1.5 text-left">Type</th>
                        <th className="px-2 py-1.5 text-left">Opened</th>
                        <th className="px-2 py-1.5 text-left">Posted</th>
                        <th className="px-2 py-1.5 text-right">Total</th>
                        <th className="px-2 py-1.5 text-right">Paid</th>
                        <th className="px-2 py-1.5 text-right">Balance</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                    {report.documents.map((doc) => (
                        <tr key={doc.guid}>
                            <td className="px-2 py-1.5">
                                <Link
                                    href={`/business/invoices/${doc.guid}`}
                                    className="font-mono text-primary hover:text-primary-hover transition-colors"
                                    style={TNUM}
                                >
                                    {doc.id}
                                </Link>
                            </td>
                            <td className="px-2 py-1.5 text-foreground-secondary capitalize">
                                {doc.posted ? doc.kind : `${doc.kind} (draft)`}
                            </td>
                            <td className="px-2 py-1.5 font-mono text-foreground-secondary" style={TNUM}>{doc.dateOpened ?? '—'}</td>
                            <td className="px-2 py-1.5 font-mono text-foreground-secondary" style={TNUM}>{doc.datePosted ?? '—'}</td>
                            <td className="px-2 py-1.5 text-right font-mono text-foreground" style={TNUM}>{formatCurrency(doc.total, doc.currency)}</td>
                            <td className="px-2 py-1.5 text-right font-mono text-foreground-secondary" style={TNUM}>
                                {doc.posted ? formatCurrency(doc.paid, doc.currency) : '—'}
                            </td>
                            <td className={`px-2 py-1.5 text-right font-mono ${doc.due > 0.005 ? 'text-foreground' : 'text-foreground-muted'}`} style={TNUM}>
                                {doc.posted ? formatCurrency(doc.due, doc.currency) : '—'}
                            </td>
                        </tr>
                    ))}
                </tbody>
                <tfoot>
                    <tr className="border-t border-border/50 font-medium">
                        <td colSpan={4} className="px-2 py-1.5 text-foreground text-xs">
                            {report.postedCount} posted
                            {report.draftCount > 0 && (
                                <span className="ml-2 font-normal text-foreground-muted">
                                    + {report.draftCount} draft ({formatCurrency(report.totals.draftTotal)})
                                </span>
                            )}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-foreground" style={TNUM}>{formatCurrency(report.totals.invoiced)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-foreground-secondary" style={TNUM}>{formatCurrency(report.totals.paid)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-foreground" style={TNUM}>{formatCurrency(report.totals.due)}</td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

export default function JobsPage() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [jobs, setJobs] = useState<JobExDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('active');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    // Modal state: null = closed, 'new' = create, otherwise editing that job.
    const [editing, setEditing] = useState<'new' | JobExDTO | null>(null);
    const [form, setForm] = useState<JobForm>(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const fetchJobs = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (search.trim()) params.set('search', search.trim());
            params.set('active', activeFilter);
            const res = await fetch(`/api/business/jobs?${params}`);
            if (!res.ok) throw new Error('Failed to load jobs');
            setJobs(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load jobs');
        } finally {
            setLoading(false);
        }
    }, [search, activeFilter, error]);

    // Debounced refetch on search/filter changes.
    useEffect(() => {
        const t = setTimeout(fetchJobs, 250);
        return () => clearTimeout(t);
    }, [fetchJobs]);

    const openCreate = useCallback(() => {
        setForm(EMPTY_FORM);
        setEditing('new');
    }, []);

    // 'n' shortcut repurposed as "new job" (same approach as ContactManager).
    useEffect(() => {
        const handler = () => {
            if (!isReadonly) openCreate();
        };
        window.addEventListener('open-new-transaction', handler);
        return () => window.removeEventListener('open-new-transaction', handler);
    }, [openCreate, isReadonly]);

    // '/' focuses search; Escape clears then blurs.
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

    const openEdit = (job: JobExDTO) => {
        setForm({
            name: job.name,
            reference: job.reference,
            active: job.active,
            ownerType: job.ownerType ?? 'customer',
            ownerGuid: job.ownerGuid ?? '',
            rate: job.rate != null ? String(job.rate) : '',
        });
        setEditing(job);
    };

    const handleSave = async () => {
        if (!form.name.trim()) {
            error('Name is required');
            return;
        }
        if (!form.ownerGuid) {
            error(`Select a ${form.ownerType}`);
            return;
        }
        setSaving(true);
        try {
            const isNew = editing === 'new';
            const payload = {
                name: form.name.trim(),
                reference: form.reference,
                active: form.active,
                ownerType: form.ownerType,
                ownerGuid: form.ownerGuid,
                rate: form.rate.trim() === '' ? null : parseFloat(form.rate) || 0,
            };
            const res = await fetch(
                isNew ? '/api/business/jobs' : `/api/business/jobs/${(editing as JobExDTO).guid}`,
                {
                    method: isNew ? 'POST' : 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save job');
            }
            success(isNew ? 'Job created' : 'Job updated');
            setEditing(null);
            await fetchJobs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save job');
        } finally {
            setSaving(false);
        }
    };

    const handleToggleActive = async (job: JobExDTO) => {
        try {
            const res = await fetch(`/api/business/jobs/${job.guid}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: !job.active }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to update job');
            }
            success(job.active ? `Deactivated ${job.name}` : `Activated ${job.name}`);
            await fetchJobs();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update job');
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
                title="Jobs"
                subtitle="Projects grouping invoices and bills per customer or vendor."
                actions={
                    <button
                        type="button"
                        onClick={openCreate}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : 'New Job (n)'}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        + New Job
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
                                placeholder="Search by name, id, or reference... ( / )"
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
                        <span className="text-foreground-secondary">Loading jobs...</span>
                    </div>
                ) : jobs.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No jobs found. Create one to get started.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Name</th>
                                    <th className="px-4 py-2 font-semibold">ID</th>
                                    <th className="px-4 py-2 font-semibold">Owner</th>
                                    <th className="px-4 py-2 font-semibold">Reference</th>
                                    <th className="px-4 py-2 font-semibold text-right">Rate</th>
                                    <th className="px-4 py-2 font-semibold">Status</th>
                                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {jobs.map((job) => {
                                    const isOpen = expanded.has(job.guid);
                                    return (
                                        <Fragment key={job.guid}>
                                            <tr
                                                onClick={() => toggleExpanded(job.guid)}
                                                className="hover:bg-surface-hover/50 transition-colors cursor-pointer"
                                            >
                                                <td className="px-4 py-2.5 text-foreground">
                                                    <span className="mr-2 inline-block w-3 text-foreground-muted">
                                                        {isOpen ? '▾' : '▸'}
                                                    </span>
                                                    {job.name}
                                                </td>
                                                <td className="px-4 py-2.5 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{job.id}</td>
                                                <td className="px-4 py-2.5 text-foreground-secondary">
                                                    {job.ownerName ?? '—'}
                                                    {job.ownerType && (
                                                        <span className="ml-2 inline-block px-1.5 py-0.5 text-[11px] rounded bg-surface-hover text-foreground-muted capitalize">
                                                            {job.ownerType}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2.5 text-foreground-secondary max-w-xs truncate">
                                                    {job.reference || <span className="text-foreground-muted">—</span>}
                                                </td>
                                                <td className="px-4 py-2.5 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                                    {job.rate != null ? formatCurrency(job.rate) : <span className="text-foreground-muted">—</span>}
                                                </td>
                                                <td className="px-4 py-2.5">
                                                    {job.active ? (
                                                        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-positive/10 text-positive">Active</span>
                                                    ) : (
                                                        <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-surface-hover text-foreground-muted">Inactive</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                                    <button
                                                        type="button"
                                                        onClick={() => openEdit(job)}
                                                        className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleToggleActive(job)}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                        className="ml-1 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                                                    >
                                                        {job.active ? 'Deactivate' : 'Activate'}
                                                    </button>
                                                </td>
                                            </tr>
                                            {isOpen && (
                                                <tr className="bg-background-tertiary/30">
                                                    <td colSpan={7} className="p-0">
                                                        <JobReportPanel jobGuid={job.guid} />
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
                title={editing === 'new' ? 'New Job' : 'Edit Job'}
                size="md"
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSave();
                    }}
                >
                    {editing !== 'new' && editing && (
                        <p className="text-xs text-foreground-muted font-mono tabular-nums">Job #{editing.id}</p>
                    )}
                    <div>
                        <label className={labelClass}>Name *</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            className={inputClass}
                            placeholder="Job name"
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Owner type</label>
                            <div className="flex rounded-lg border border-border p-0.5">
                                {(['customer', 'vendor'] as const).map((k) => (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => setForm({ ...form, ownerType: k, ownerGuid: '' })}
                                        className={`flex-1 rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${
                                            form.ownerType === k
                                                ? 'bg-primary text-primary-foreground'
                                                : 'text-foreground-secondary hover:text-foreground'
                                        }`}
                                    >
                                        {k}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className={labelClass}>
                                {form.ownerType === 'customer' ? 'Customer' : 'Vendor'} *
                            </label>
                            <OwnerSelector
                                key={form.ownerType}
                                kind={form.ownerType}
                                value={form.ownerGuid}
                                onChange={(guid) => setForm((f) => ({ ...f, ownerGuid: guid }))}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Reference</label>
                            <input
                                type="text"
                                value={form.reference}
                                onChange={(e) => setForm({ ...form, reference: e.target.value })}
                                className={inputClass}
                                placeholder="PO / order number"
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Rate</label>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={form.rate}
                                onChange={(e) => setForm({ ...form, rate: e.target.value })}
                                className={`${inputClass} font-mono`}
                                placeholder="Default rate (optional)"
                            />
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
        </div>
    );
}
