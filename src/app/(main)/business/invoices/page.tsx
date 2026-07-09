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

function InvoicesContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { error } = useToast();
    const { isReadonly } = useCurrentUser();

    const type: InvoiceKind = searchParams.get('type') === 'bill' ? 'bill' : 'invoice';
    const singular = type === 'invoice' ? 'Invoice' : 'Bill';

    const [invoices, setInvoices] = useState<InvoiceView[]>([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<'all' | InvoiceStatus>('all');
    const [search, setSearch] = useState('');
    const [currencyByGuid, setCurrencyByGuid] = useState<Record<string, string>>({});
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
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground" style={TNUM}>{inv.id}</td>
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
