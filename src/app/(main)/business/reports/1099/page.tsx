'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import Link from 'next/link';
import type {
    Vendor1099Summary,
    Vendor1099Row,
    Vendor1099Status,
} from '@/lib/business/vendor-1099.service';
import { daysUntilFilingDue, filingDueDate } from '@/lib/business/vendor-1099-compliance';
import { formatCurrency } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { useToast } from '@/contexts/ToastContext';
import { LinkedDocumentsPanel } from '@/components/documents/LinkedDocumentsPanel';
import { Tip } from '@/components/ui/Tooltip';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const CLASSIFICATION_OPTIONS = [
    { value: '', label: '— not set —' },
    { value: 'individual/sole_prop', label: 'Individual / sole proprietor' },
    { value: 'llc', label: 'LLC' },
    { value: 'partnership', label: 'Partnership' },
    { value: 'c_corp', label: 'C corporation' },
    { value: 's_corp', label: 'S corporation' },
    { value: 'other', label: 'Other' },
] as const;

const STATUS_META: Record<Vendor1099Status, { label: string; className: string }> = {
    ready: { label: 'Ready', className: 'bg-positive/10 text-positive border-positive/30' },
    missing_w9: { label: 'Missing W-9', className: 'bg-warning/10 text-warning border-warning/30' },
    exempt: { label: 'Exempt', className: 'bg-background-tertiary text-foreground-secondary border-border' },
    below_threshold: {
        label: 'Below threshold',
        className: 'bg-background-tertiary text-foreground-muted border-border',
    },
};

const VENDOR_DOCUMENT_ROLES = [
    { value: 'w9', label: 'W-9' },
    { value: 'form_1099_nec', label: '1099-NEC form' },
    { value: 'filing_proof', label: 'Filing proof' },
    { value: 'correspondence', label: 'Correspondence' },
] as const;

function Chip({ label, className }: { label: string; className: string }) {
    return (
        <span
            className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${className}`}
        >
            {label}
        </span>
    );
}

interface EditFormState {
    legalName: string;
    taxClassification: string;
    tinLast4: string;
    w9Received: boolean;
    w9ReceivedDate: string;
    w9RequestedDate: string;
    exemptFrom1099: boolean;
    exemptFrom1099Override: boolean | null;
    attorneyOrMedicalPayments: boolean;
    address: string;
}

function formFromRow(row: Vendor1099Row): EditFormState {
    return {
        legalName: row.taxInfo?.legalName ?? '',
        taxClassification: row.taxInfo?.taxClassification ?? '',
        tinLast4: '',
        w9Received: row.taxInfo?.w9Received ?? false,
        w9ReceivedDate: row.taxInfo?.w9ReceivedDate ?? '',
        w9RequestedDate: row.taxInfo?.w9RequestedDate ?? '',
        exemptFrom1099: row.taxInfo?.exemptFrom1099 ?? false,
        exemptFrom1099Override: row.taxInfo?.exemptFrom1099Override ?? null,
        attorneyOrMedicalPayments: row.taxInfo?.attorneyOrMedicalPayments ?? false,
        address: row.taxInfo?.address ?? '',
    };
}

const inputClass =
    'w-full rounded-lg border border-border bg-input-bg px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-primary/50 focus:outline-none';
const labelClass = 'block text-xs text-foreground-secondary mb-1';

export default function Nec1099Page() {
    const currentYear = new Date().getUTCFullYear();
    const newestVerifiedYear = 2026;
    const toast = useToast();
    // Deep links from the Action Center / Timeline carry ?year=<taxYear>.
    const [year, setYear] = useState(() => {
        if (typeof window !== 'undefined') {
            const fromUrl = parseInt(
                new URLSearchParams(window.location.search).get('year') ?? '',
                10,
            );
            if (Number.isInteger(fromUrl) && fromUrl >= 1990 && fromUrl <= 2100) return fromUrl;
        }
        return Math.min(currentYear, newestVerifiedYear);
    });
    const years = Array.from(
        new Set([year, ...Array.from({ length: 6 }, (_, i) => currentYear - i)]),
    ).sort((a, b) => b - a);
    const [summary, setSummary] = useState<Vendor1099Summary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [form, setForm] = useState<EditFormState | null>(null);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async (y: number, signal?: { cancelled: boolean }) => {
        try {
            const res = await fetch(`/api/business/1099?year=${y}`);
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? `Request failed (${res.status})`);
            }
            const json: Vendor1099Summary = await res.json();
            if (!signal?.cancelled) setSummary(json);
        } catch (err) {
            if (!signal?.cancelled) setError(err instanceof Error ? err.message : 'Failed to load the 1099 summary.');
        }
    }, []);

    useEffect(() => {
        const signal = { cancelled: false };
        setLoading(true);
        setError(null);
        setExpanded(null);
        setForm(null);
        load(year, signal).finally(() => {
            if (!signal.cancelled) setLoading(false);
        });
        return () => {
            signal.cancelled = true;
        };
    }, [year, load]);

    const toggleExpand = (row: Vendor1099Row) => {
        if (expanded === row.vendorGuid) {
            setExpanded(null);
            setForm(null);
        } else {
            setExpanded(row.vendorGuid);
            setForm(formFromRow(row));
        }
    };

    const saveTaxInfo = async (vendorGuid: string, body: Record<string, unknown>) => {
        const res = await fetch(`/api/business/1099/vendor/${vendorGuid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const json = await res.json().catch(() => null);
            throw new Error(json?.error ?? 'Save failed');
        }
    };

    const handleSave = async (vendorGuid: string) => {
        if (!form) return;
        if (form.tinLast4 && !/^\d{4}$/.test(form.tinLast4)) {
            toast.error('TIN must be exactly the last 4 digits');
            return;
        }
        setSaving(true);
        try {
            await saveTaxInfo(vendorGuid, {
                legalName: form.legalName.trim() || null,
                taxClassification: form.taxClassification || null,
                ...(form.tinLast4 ? { tinLast4: form.tinLast4 } : {}),
                w9Received: form.w9Received,
                w9ReceivedDate: form.w9Received && form.w9ReceivedDate ? form.w9ReceivedDate : null,
                w9RequestedDate: form.w9RequestedDate || null,
                exemptFrom1099Override: form.exemptFrom1099Override,
                attorneyOrMedicalPayments: form.attorneyOrMedicalPayments,
                address: form.address.trim() || null,
            });
            toast.success('Vendor tax info saved');
            setExpanded(null);
            setForm(null);
            await load(year);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save vendor tax info');
        } finally {
            setSaving(false);
        }
    };

    const handleExemptToggle = async (row: Vendor1099Row) => {
        try {
            await saveTaxInfo(row.vendorGuid, {
                exemptFrom1099Override: !(row.taxInfo?.exemptFrom1099 ?? false),
            });
            await load(year);
        } catch {
            toast.error('Failed to update exempt flag');
        }
    };

    const handleFilingToggle = async (row: Vendor1099Row) => {
        const marking = row.filedDate === null;
        try {
            const res = await fetch(`/api/business/1099/vendor/${row.vendorGuid}/filing`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taxYear: year,
                    filedDate: marking ? new Date().toISOString().slice(0, 10) : null,
                }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error ?? 'Save failed');
            }
            toast.success(marking ? `1099-NEC marked filed for ${year}` : 'Filing status cleared');
            await load(year);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update filing status');
        }
    };

    const isCorp = form?.taxClassification === 'c_corp' || form?.taxClassification === 's_corp';

    const dueDate = filingDueDate(year);
    const daysLeft = daysUntilFilingDue(year);
    const reportableRows = (summary?.vendors ?? []).filter(
        (row) => row.crosses600 && row.status !== 'exempt',
    );
    const unfiledCount = reportableRows.filter((row) => !row.filedDate).length;
    const filedCount = reportableRows.length - unfiledCount;

    return (
        <div className="space-y-6">
            <PageHeader
                title="1099-NEC Tracker"
                subtitle="Cash paid to vendors per calendar year, the $600 reporting threshold, and W-9 / TIN readiness for January filing."
                actions={
                    <>
                        <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                            Tax year
                            <select
                                value={year}
                                onChange={(e) => setYear(parseInt(e.target.value, 10))}
                                className="rounded-lg border border-border bg-input-bg px-2 py-1.5 text-sm text-foreground focus:border-primary/50 focus:outline-none"
                            >
                                {years.map((y) => (
                                    <option key={y} value={y}>
                                        {y}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <a
                            href={`/api/business/1099/export?year=${year}`}
                            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors"
                        >
                            Download CSV
                        </a>
                    </>
                }
            />

            <div
                className={`rounded-lg border px-4 py-3 text-sm text-foreground-secondary ${
                    unfiledCount > 0 && daysLeft < 0
                        ? 'border-error/30 bg-surface/30'
                        : 'border-secondary/30 bg-secondary-light'
                }`}
            >
                <span className="font-medium text-foreground">
                    January 31, {year + 1} deadline
                    {daysLeft >= 0
                        ? ` — ${daysLeft} day${daysLeft === 1 ? '' : 's'} away:`
                        : ` — ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} past:`}
                </span>{' '}
                1099-NEC forms are due to both recipients and the IRS.{' '}
                {!loading && summary && reportableRows.length > 0 && (
                    <span className={unfiledCount > 0 && daysLeft < 0 ? 'text-error' : undefined}>
                        {filedCount} of {reportableRows.length} reportable vendor
                        {reportableRows.length === 1 ? '' : 's'} filed.{' '}
                    </span>
                )}
                Collect W-9s before year-end —{' '}
                <Link href="/taxes/compliance" className="text-primary hover:text-primary-hover transition-colors">
                    see the compliance calendar
                </Link>
                .
            </div>

            <div className="rounded-lg border border-warning/30 bg-surface/30 px-4 py-3 text-sm text-foreground-secondary">
                <span className="font-medium text-foreground">Corporate-payment review required.</span>{' '}
                Corporations are generally exempt, but attorneys&apos; fees and medical/health-care payments can still be reportable. This tracker cannot detect either payment type; explicitly set each vendor&apos;s Exempt checkbox after review.
            </div>

            {loading && (
                <div className="flex items-center justify-center py-12">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading...</span>
                    </div>
                </div>
            )}

            {!loading && error && (
                <div className="border border-error/30 bg-surface/30 rounded-lg p-4">
                    <p className="text-sm text-error">{error}</p>
                </div>
            )}

            {!loading && !error && summary && (
                <>
                    <StatGrid cols={4}>
                        <StatCard
                            label={`Vendors ≥ $${summary.threshold.toLocaleString()} in ${summary.year}`}
                            value={summary.totals.reportableCount}
                            size="compact"
                        />
                        <StatCard
                            label="Missing W-9"
                            value={summary.totals.missingW9Count}
                            tone={summary.totals.missingW9Count > 0 ? 'warning' : 'default'}
                            size="compact"
                        />
                        <StatCard
                            label="Total reportable"
                            value={formatCurrency(summary.totals.reportableTotal)}
                            size="compact"
                        />
                        <StatCard
                            label={`1099s filed (due ${dueDate})`}
                            value={`${filedCount} / ${reportableRows.length}`}
                            tone={
                                unfiledCount > 0 && daysLeft < 0
                                    ? 'negative'
                                    : unfiledCount > 0 && daysLeft <= 60
                                        ? 'warning'
                                        : 'default'
                            }
                            size="compact"
                        />
                    </StatGrid>

                    {summary.vendors.length === 0 ? (
                        <div className="bg-background-secondary/30 border border-border rounded-lg p-8 text-center">
                            <p className="text-sm text-foreground-secondary">
                                No vendors with posted bills in this book yet. Post vendor bills and
                                payments and they&apos;ll show up here with their {summary.year} totals.
                            </p>
                        </div>
                    ) : (
                        <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-lg overflow-hidden">
                            <div className="overflow-x-auto">
                                <table className="w-full min-w-[840px] text-sm">
                                    <thead>
                                        <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                            <th className="px-4 py-3 text-left">Vendor</th>
                                            <th className="px-4 py-3 text-right">Paid in {summary.year}</th>
                                            <th className="px-4 py-3 text-left">Threshold</th>
                                            <th className="px-4 py-3 text-left">W-9</th>
                                            <th className="px-4 py-3 text-left">Status</th>
                                            <th className="px-4 py-3 text-left">Filed</th>
                                            <th className="px-4 py-3 text-center">Exempt</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {summary.vendors.map((row) => {
                                            const isOpen = expanded === row.vendorGuid;
                                            const status = STATUS_META[row.status];
                                            return (
                                                <Fragment key={row.vendorGuid}>
                                                    <tr
                                                        className="border-b border-border/30 cursor-pointer hover:bg-background-secondary/20 transition-colors"
                                                        onClick={() => toggleExpand(row)}
                                                    >
                                                        <td className="px-4 py-2.5 text-foreground">
                                                            <span className="mr-2 inline-block w-3 text-foreground-muted">
                                                                {isOpen ? '▾' : '▸'}
                                                            </span>
                                                            {row.name}
                                                            {row.taxInfo?.legalName &&
                                                                row.taxInfo.legalName !== row.name && (
                                                                    <span className="ml-2 text-xs text-foreground-muted">
                                                                        ({row.taxInfo.legalName})
                                                                    </span>
                                                                )}
                                                        </td>
                                                        <td className="px-4 py-2.5 text-right font-mono text-foreground" style={TNUM}>
                                                            {formatCurrency(row.totalPaid)}
                                                        </td>
                                                        <td className="px-4 py-2.5">
                                                            {row.crosses600 ? (
                                                                <Chip label={`≥ $${summary.threshold.toLocaleString()}`} className="bg-primary-light text-primary border-primary/30" />
                                                            ) : (
                                                                <Chip label="Below" className="bg-background-tertiary text-foreground-muted border-border" />
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2.5">
                                                            {row.taxInfo?.w9Received ? (
                                                                <Chip label="Received" className="bg-positive/10 text-positive border-positive/30" />
                                                            ) : (
                                                                <Chip
                                                                    label="Missing"
                                                                    className={
                                                                        row.crosses600 && row.status !== 'exempt'
                                                                            ? 'bg-warning/10 text-warning border-warning/30'
                                                                            : 'bg-background-tertiary text-foreground-muted border-border'
                                                                    }
                                                                />
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2.5">
                                                            <Chip label={status.label} className={status.className} />
                                                        </td>
                                                        <td
                                                            className="px-4 py-2.5"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            {row.filedDate ? (
                                                                <Tip content="Clear filing status">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleFilingToggle(row)}
                                                                    className="font-mono text-xs text-positive hover:text-foreground transition-colors"
                                                                    style={TNUM}
                                                                >
                                                                    ✓ {row.filedDate}
                                                                </button>
                                                                </Tip>
                                                            ) : row.crosses600 && row.status !== 'exempt' ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleFilingToggle(row)}
                                                                    className="rounded-lg border border-border px-2 py-0.5 text-xs text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                                                                >
                                                                    Mark filed
                                                                </button>
                                                            ) : (
                                                                <span className="text-xs text-foreground-muted">—</span>
                                                            )}
                                                        </td>
                                                        <td
                                                            className="px-4 py-2.5 text-center"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={row.taxInfo?.exemptFrom1099 ?? false}
                                                                onChange={() => handleExemptToggle(row)}
                                                                className="accent-[var(--primary)] cursor-pointer"
                                                                aria-label={`Exempt ${row.name} from 1099`}
                                                            />
                                                        </td>
                                                    </tr>
                                                    {isOpen && form && (
                                                        <tr className="border-b border-border/30 bg-background-tertiary/30">
                                                            <td colSpan={7} className="px-6 py-4">
                                                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                                                    <div>
                                                                        <label className={labelClass}>Legal name (as on W-9)</label>
                                                                        <input
                                                                            type="text"
                                                                            value={form.legalName}
                                                                            onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                                                                            placeholder={row.name}
                                                                            className={inputClass}
                                                                        />
                                                                    </div>
                                                                    <div>
                                                                        <label className={labelClass}>Tax classification</label>
                                                                        <select
                                                                            value={form.taxClassification}
                                                                            onChange={(e) => {
                                                                                const v = e.target.value;
                                                                                const corp = v === 'c_corp' || v === 's_corp';
                                                                                setForm({
                                                                                    ...form,
                                                                                    taxClassification: v,
                                                                                    // Classification supplies the default only; preserve an explicit choice.
                                                                                    exemptFrom1099: form.exemptFrom1099Override ?? corp,
                                                                                });
                                                                            }}
                                                                            className={inputClass}
                                                                        >
                                                                            {CLASSIFICATION_OPTIONS.map((o) => (
                                                                                <option key={o.value} value={o.value}>
                                                                                    {o.label}
                                                                                </option>
                                                                            ))}
                                                                        </select>
                                                                        {isCorp && (
                                                                            <p className="mt-1 text-[11px] text-foreground-muted">
                                                                                Corporations are generally exempt from 1099-NEC
                                                                                Attorney and medical / health-care payments are notable exceptions.
                                                                            </p>
                                                                        )}
                                                                    </div>
                                                                    <div>
                                                                        <label className={labelClass}>
                                                                            TIN — last 4 digits only
                                                                            {row.taxInfo?.taxIdMasked && (
                                                                                <span className="ml-2 font-mono text-foreground-muted" style={TNUM}>
                                                                                    on file: {row.taxInfo.taxIdMasked}
                                                                                </span>
                                                                            )}
                                                                        </label>
                                                                        <input
                                                                            type="text"
                                                                            inputMode="numeric"
                                                                            maxLength={4}
                                                                            pattern="\d{4}"
                                                                            value={form.tinLast4}
                                                                            onChange={(e) =>
                                                                                setForm({
                                                                                    ...form,
                                                                                    tinLast4: e.target.value.replace(/\D/g, '').slice(0, 4),
                                                                                })
                                                                            }
                                                                            placeholder="1234"
                                                                            className={`${inputClass} font-mono`}
                                                                        />
                                                                        <p className="mt-1 text-[11px] text-foreground-muted">
                                                                            Only a masked form is stored — never enter the full TIN.
                                                                        </p>
                                                                    </div>
                                                                    <div>
                                                                        <label className={labelClass}>W-9 requested date</label>
                                                                        <input
                                                                            type="date"
                                                                            value={form.w9RequestedDate}
                                                                            onChange={(e) =>
                                                                                setForm({ ...form, w9RequestedDate: e.target.value })
                                                                            }
                                                                            className={`${inputClass} font-mono`}
                                                                        />
                                                                        <p className="mt-1 text-[11px] text-foreground-muted">
                                                                            When you asked the vendor for a W-9 (leave blank if not yet requested).
                                                                        </p>
                                                                    </div>
                                                                    <div className="flex items-end gap-4">
                                                                        <label className="flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer pb-1.5">
                                                                            <input
                                                                                type="checkbox"
                                                                                checked={form.w9Received}
                                                                                onChange={(e) =>
                                                                                    setForm({ ...form, w9Received: e.target.checked })
                                                                                }
                                                                                className="accent-[var(--primary)]"
                                                                            />
                                                                            W-9 received
                                                                        </label>
                                                                        {form.w9Received && (
                                                                            <div className="flex-1">
                                                                                <label className={labelClass}>Received date</label>
                                                                                <input
                                                                                    type="date"
                                                                                    value={form.w9ReceivedDate}
                                                                                    onChange={(e) =>
                                                                                        setForm({ ...form, w9ReceivedDate: e.target.value })
                                                                                    }
                                                                                    className={`${inputClass} font-mono`}
                                                                                />
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    <div className="sm:col-span-2">
                                                                        <label className={labelClass}>Address (for the 1099 form)</label>
                                                                        <textarea
                                                                            value={form.address}
                                                                            onChange={(e) => setForm({ ...form, address: e.target.value })}
                                                                            rows={2}
                                                                            className={inputClass}
                                                                        />
                                                                    </div>
                                                                </div>
                                                                <LinkedDocumentsPanel
                                                                    className="mt-4"
                                                                    targetType="vendor_1099"
                                                                    targetId={`${row.vendorGuid}:${year}`}
                                                                    roles={VENDOR_DOCUMENT_ROLES}
                                                                    title={`${year} vendor documents`}
                                                                />
                                                                <div className="mt-4 flex items-center gap-3">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleSave(row.vendorGuid)}
                                                                        disabled={saving}
                                                                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                                                                    >
                                                                        {saving ? 'Saving…' : 'Save'}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => {
                                                                            setExpanded(null);
                                                                            setForm(null);
                                                                        }}
                                                                        className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                                                                    >
                                                                        Cancel
                                                                    </button>
                                                                    <label className="ml-auto flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={form.exemptFrom1099}
                                                                            onChange={(e) =>
                                                                                setForm({ ...form, exemptFrom1099: e.target.checked, exemptFrom1099Override: e.target.checked })
                                                                            }
                                                                            className="accent-[var(--primary)]"
                                                                        />
                                                                        Exempt from 1099
                                                                    </label>
                                                                    <label className="flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={form.attorneyOrMedicalPayments}
                                                                            onChange={(e) => setForm({ ...form, attorneyOrMedicalPayments: e.target.checked })}
                                                                            className="accent-[var(--primary)]"
                                                                        />
                                                                        Attorney or medical / health-care payments
                                                                    </label>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    )}
                                                </Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    <p className="text-xs text-foreground-muted">
                        Totals are CASH PAID during {summary.year} — payments applied to each vendor&apos;s
                        posted bills (1099-NEC is cash basis), not amounts billed. Card and third-party-network
                        payments are excluded only when their funding account is marked in Account settings. Credit-note applications
                        net against payments. Attorney and medical / health-care vendors must be marked so corporate payees remain reportable.
                        The CSV total is a cash-paid worksheet total, not a payment-type classification: review goods, materials,
                        rent, and any payments not applied to posted A/P bills before selecting a form box. The CSV is a prep worksheet, not an official IRS form; file
                        with your tax software or the IRS IRIS portal.
                    </p>
                </>
            )}
        </div>
    );
}
