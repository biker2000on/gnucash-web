'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import { STATUS_META, type InvoiceKind, type InvoiceStatus } from '@/components/business/invoice-ui';
import type { InvoiceView } from '@/lib/business/invoice-engine';
import type { EmailBill } from '@/lib/business/bill-capture';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';

const STATUS_FILTERS: Array<'all' | InvoiceStatus> = ['all', 'draft', 'open', 'paid', 'overdue'];

function StatusBadge({ status }: { status: InvoiceStatus }) {
    const meta = STATUS_META[status];
    return (
        <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${meta.className}`}>
            {meta.label}
        </span>
    );
}

function FromEmailBadge() {
    return (
        <span
            className="inline-block ml-2 px-1.5 py-0.5 text-[10px] rounded bg-secondary-light text-secondary whitespace-nowrap align-middle"
            title="Created from an emailed bill"
        >
            from email
        </span>
    );
}

/** Review queue for email-captured bills that couldn't be drafted automatically. */
function EmailBillReviewPanel({
    bills,
    vendors,
    isReadonly,
    onResolve,
    onDismiss,
}: {
    bills: EmailBill[];
    vendors: Array<{ guid: string; name: string }>;
    isReadonly: boolean;
    onResolve: (bill: EmailBill, vendorGuid: string, amount: number | null) => Promise<void>;
    onDismiss: (bill: EmailBill) => Promise<void>;
}) {
    const [selections, setSelections] = useState<Record<number, string>>({});
    const [amounts, setAmounts] = useState<Record<number, string>>({});
    const [busyId, setBusyId] = useState<number | null>(null);

    if (bills.length === 0) return null;

    return (
        <div className="bg-surface border border-warning/40 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
                <h2 className="text-sm font-semibold text-foreground">
                    Emailed bills needing review
                    <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-warning/15 text-warning">
                        {bills.length}
                    </span>
                </h2>
                <p className="text-xs text-foreground-muted mt-0.5">
                    These arrived by email but no vendor matched (vendors are never created
                    automatically). Pick the vendor to create the draft bill, or dismiss.
                </p>
            </div>
            <div className="divide-y divide-border">
                {bills.map((bill) => {
                    const vendorGuid = selections[bill.id] ?? '';
                    const amountStr = amounts[bill.id] ?? (bill.amount !== null ? String(bill.amount) : '');
                    const amountNum = parseFloat(amountStr);
                    const canResolve = !isReadonly && vendorGuid !== '' && Number.isFinite(amountNum) && amountNum > 0;
                    const busy = busyId === bill.id;
                    return (
                        <div key={bill.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="text-sm text-foreground truncate">
                                    {bill.subject || bill.filename || `Capture #${bill.id}`}
                                </div>
                                <div className="text-xs text-foreground-muted mt-0.5">
                                    {bill.vendorName ? `Extracted vendor: ${bill.vendorName}` : 'No vendor extracted'}
                                    {bill.docDate ? ` · ${bill.docDate}` : ''}
                                    {bill.status === 'pending_extraction'
                                        ? ' · still extracting…'
                                        : bill.detail ? ` · ${bill.detail}` : ''}
                                </div>
                            </div>
                            <select
                                className={`${inputClass} w-52`}
                                value={vendorGuid}
                                disabled={isReadonly || busy}
                                onChange={(e) => setSelections((prev) => ({ ...prev, [bill.id]: e.target.value }))}
                            >
                                <option value="">Select vendor…</option>
                                {vendors.map((v) => (
                                    <option key={v.guid} value={v.guid}>{v.name}</option>
                                ))}
                            </select>
                            <input
                                type="number"
                                className={`${inputClass} w-28 font-mono`}
                                style={TNUM}
                                placeholder="Amount"
                                min={0}
                                step={0.01}
                                value={amountStr}
                                disabled={isReadonly || busy}
                                onChange={(e) => setAmounts((prev) => ({ ...prev, [bill.id]: e.target.value }))}
                            />
                            <button
                                type="button"
                                disabled={!canResolve || busy}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                onClick={async () => {
                                    setBusyId(bill.id);
                                    try {
                                        await onResolve(bill, vendorGuid, Number.isFinite(amountNum) ? amountNum : null);
                                    } finally {
                                        setBusyId(null);
                                    }
                                }}
                                className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover disabled:bg-primary/40 disabled:cursor-not-allowed text-primary-foreground rounded-md transition-colors"
                            >
                                {busy ? 'Creating…' : 'Create draft'}
                            </button>
                            <button
                                type="button"
                                disabled={isReadonly || busy}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                onClick={async () => {
                                    setBusyId(bill.id);
                                    try {
                                        await onDismiss(bill);
                                    } finally {
                                        setBusyId(null);
                                    }
                                }}
                                className="px-3 py-1.5 text-xs text-foreground-secondary hover:text-foreground hover:bg-surface-hover rounded-md transition-colors"
                            >
                                Dismiss
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function InvoicesContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const type: InvoiceKind = searchParams.get('type') === 'bill' ? 'bill' : 'invoice';
    const singular = type === 'invoice' ? 'Invoice' : 'Bill';

    const [invoices, setInvoices] = useState<InvoiceView[]>([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<'all' | InvoiceStatus>('all');
    const [search, setSearch] = useState('');
    const [currencyByGuid, setCurrencyByGuid] = useState<Record<string, string>>({});
    const [emailBills, setEmailBills] = useState<EmailBill[]>([]);
    const [vendors, setVendors] = useState<Array<{ guid: string; name: string }>>([]);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const setType = (next: InvoiceKind) => {
        const params = new URLSearchParams(searchParams.toString());
        if (next === 'bill') params.set('type', 'bill');
        else params.delete('type');
        router.replace(`/business/invoices${params.size ? `?${params}` : ''}`);
    };

    const fetchInvoices = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ type, limit: '500' });
            if (status !== 'all') params.set('status', status);
            const res = await fetch(`/api/business/invoices?${params}`);
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || `Failed to load ${singular.toLowerCase()}s`);
            setInvoices(data.invoices ?? []);
        } catch (err) {
            error(err instanceof Error ? err.message : `Failed to load ${singular.toLowerCase()}s`);
        } finally {
            setLoading(false);
        }
    }, [type, status, singular, error]);

    useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

    // Email-captured bill drafts (badge + review queue) — bills view only.
    const fetchEmailBills = useCallback(async () => {
        if (type !== 'bill') {
            setEmailBills([]);
            return;
        }
        try {
            const res = await fetch('/api/business/bill-drafts');
            const data = await res.json().catch(() => null);
            if (res.ok) setEmailBills(data?.bills ?? []);
        } catch {
            // Non-fatal: the bills list works without the email metadata.
        }
    }, [type]);

    useEffect(() => { fetchEmailBills(); }, [fetchEmailBills]);

    useEffect(() => {
        if (type !== 'bill') return;
        fetch('/api/business/vendors')
            .then((res) => (res.ok ? res.json() : []))
            .then((rows: Array<{ guid: string; name: string }>) => {
                setVendors(Array.isArray(rows) ? rows.map((r) => ({ guid: r.guid, name: r.name })) : []);
            })
            .catch(() => {});
    }, [type]);

    const emailDraftInvoiceGuids = useMemo(
        () => new Set(emailBills.filter((b) => b.invoiceGuid).map((b) => b.invoiceGuid as string)),
        [emailBills],
    );
    const reviewQueue = useMemo(
        () => emailBills.filter((b) => b.status === 'needs_review' || b.status === 'error' || b.status === 'pending_extraction'),
        [emailBills],
    );

    const handleResolveEmailBill = useCallback(
        async (bill: EmailBill, vendorGuid: string, amount: number | null) => {
            try {
                const res = await fetch(`/api/business/bill-drafts/${bill.id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ vendorGuid, amount }),
                });
                const data = await res.json().catch(() => null);
                if (!res.ok) throw new Error(data?.error || 'Failed to create the draft bill');
                success('Draft bill created');
                await Promise.all([fetchInvoices(), fetchEmailBills()]);
            } catch (err) {
                error(err instanceof Error ? err.message : 'Failed to create the draft bill');
            }
        },
        [success, error, fetchInvoices, fetchEmailBills],
    );

    const handleDismissEmailBill = useCallback(
        async (bill: EmailBill) => {
            try {
                const res = await fetch(`/api/business/bill-drafts/${bill.id}`, { method: 'DELETE' });
                const data = await res.json().catch(() => null);
                if (!res.ok) throw new Error(data?.error || 'Failed to dismiss');
                await fetchEmailBills();
            } catch (err) {
                error(err instanceof Error ? err.message : 'Failed to dismiss');
            }
        },
        [error, fetchEmailBills],
    );

    // Currency guid -> mnemonic for amount formatting.
    useEffect(() => {
        fetch('/api/commodities?type=CURRENCY')
            .then((res) => (res.ok ? res.json() : []))
            .then((rows: Array<{ guid: string; mnemonic: string }>) => {
                const map: Record<string, string> = {};
                for (const r of rows) map[r.guid] = r.mnemonic;
                setCurrencyByGuid(map);
            })
            .catch(() => {});
    }, []);

    const openNew = useCallback(() => {
        router.push(`/business/invoices/new?type=${type}`);
    }, [router, type]);

    // The global 'n' shortcut dispatches 'open-new-transaction'; no ledger is
    // mounted on business routes, so repurpose it as "new invoice/bill" (same
    // approach as ContactManager).
    useEffect(() => {
        const handler = () => {
            if (!isReadonly) openNew();
        };
        window.addEventListener('open-new-transaction', handler);
        return () => window.removeEventListener('open-new-transaction', handler);
    }, [openNew, isReadonly]);

    // '/' focuses search; Escape in the search clears then blurs.
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
        if (!q) return invoices;
        return invoices.filter(
            (i) => i.id.toLowerCase().includes(q) || i.ownerName.toLowerCase().includes(q),
        );
    }, [invoices, search]);

    const currencyOf = (inv: InvoiceView) => currencyByGuid[inv.currencyGuid] ?? 'USD';

    const typeButton = (value: InvoiceKind, label: string) => (
        <button
            type="button"
            onClick={() => setType(value)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                type === value
                    ? 'bg-primary-light text-primary'
                    : 'text-foreground-secondary hover:text-foreground hover:bg-surface-hover'
            }`}
        >
            {label}
        </button>
    );

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
                title={type === 'invoice' ? 'Invoices' : 'Bills'}
                subtitle={type === 'invoice'
                    ? 'Customer invoices — accounts receivable.'
                    : 'Vendor bills — accounts payable.'}
                actions={
                    <button
                        type="button"
                        onClick={openNew}
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
                                placeholder={`Search by id or ${type === 'invoice' ? 'customer' : 'vendor'}... ( / )`}
                                className={`${inputClass} md:max-w-sm`}
                            />
                        }
                        activeCount={status !== 'all' ? 1 : 0}
                    >
                        <div className="flex gap-1">
                            {typeButton('invoice', 'Invoices')}
                            {typeButton('bill', 'Bills')}
                        </div>
                        <div className="hidden md:block w-px h-5 bg-border" />
                        <div className="flex gap-1">
                            {STATUS_FILTERS.map(statusButton)}
                        </div>
                    </FilterBar>
                }
            />

            {type === 'bill' && (
                <EmailBillReviewPanel
                    bills={reviewQueue}
                    vendors={vendors}
                    isReadonly={isReadonly}
                    onResolve={handleResolveEmailBill}
                    onDismiss={handleDismissEmailBill}
                />
            )}

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading {singular.toLowerCase()}s...</span>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No {singular.toLowerCase()}s found. Create one to get started.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">#</th>
                                    <th className="px-4 py-2 font-semibold">{type === 'invoice' ? 'Customer' : 'Vendor'}</th>
                                    <th className="px-4 py-2 font-semibold">Opened</th>
                                    <th className="px-4 py-2 font-semibold">Posted</th>
                                    <th className="px-4 py-2 font-semibold">Due</th>
                                    <th className="px-4 py-2 font-semibold text-right">Total</th>
                                    <th className="px-4 py-2 font-semibold text-right">Amount due</th>
                                    <th className="px-4 py-2 font-semibold">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {filtered.map((inv) => (
                                    <tr
                                        key={inv.guid}
                                        onClick={() => router.push(`/business/invoices/${inv.guid}`)}
                                        className="hover:bg-surface-hover/50 transition-colors cursor-pointer"
                                    >
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground whitespace-nowrap" style={TNUM}>
                                            {inv.id}
                                            {emailDraftInvoiceGuids.has(inv.guid) && <FromEmailBadge />}
                                        </td>
                                        <td className="px-4 py-2 text-foreground max-w-xs truncate">{inv.ownerName}</td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{inv.dateOpened ?? '—'}</td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{inv.datePosted ?? '—'}</td>
                                        <td className={`px-4 py-2 font-mono tabular-nums ${inv.status === 'overdue' ? 'text-negative' : 'text-foreground-secondary'}`} style={TNUM}>
                                            {inv.dueDate ?? '—'}
                                        </td>
                                        <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                            {formatCurrency(inv.totals.total, currencyOf(inv))}
                                        </td>
                                        <td className={`px-4 py-2 font-mono tabular-nums text-right ${inv.amountDue > 0.005 ? 'text-foreground' : 'text-foreground-muted'}`} style={TNUM}>
                                            {inv.posted ? formatCurrency(inv.amountDue, currencyOf(inv)) : '—'}
                                        </td>
                                        <td className="px-4 py-2">
                                            <StatusBadge status={inv.status} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function InvoicesPage() {
    return (
        <Suspense
            fallback={
                <div className="p-12 flex items-center justify-center gap-3">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading...</span>
                </div>
            }
        >
            <InvoicesContent />
        </Suspense>
    );
}
