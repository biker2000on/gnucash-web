'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { OwnerSelector, type OwnerDTO } from '@/components/business/OwnerSelector';
import { PaymentModal } from '@/components/business/PaymentModal';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import { STATUS_META, roundCents } from '@/components/business/invoice-ui';
import type { InvoiceView, PaymentView } from '@/lib/business/invoice-engine';
import type { ContactKind } from '@/lib/business-types';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

export default function PaymentsPage() {
    const router = useRouter();
    const { error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [ownerType, setOwnerType] = useState<ContactKind>('customer');
    const [ownerGuid, setOwnerGuid] = useState('');
    const [owner, setOwner] = useState<OwnerDTO | null>(null);
    const [invoices, setInvoices] = useState<InvoiceView[]>([]);
    const [payments, setPayments] = useState<PaymentView[]>([]);
    const [loading, setLoading] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);

    const docWord = ownerType === 'customer' ? 'invoice' : 'bill';
    const currency = owner?.currency ?? 'USD';

    const fetchData = useCallback(async () => {
        if (!ownerGuid) {
            setInvoices([]);
            setPayments([]);
            return;
        }
        setLoading(true);
        try {
            const type = ownerType === 'customer' ? 'invoice' : 'bill';
            const [invRes, payRes] = await Promise.all([
                fetch(`/api/business/invoices?type=${type}&ownerGuid=${ownerGuid}`),
                fetch(`/api/business/payments?ownerType=${ownerType}&ownerGuid=${ownerGuid}`),
            ]);
            const invData = await invRes.json().catch(() => null);
            const payData = await payRes.json().catch(() => null);
            if (!invRes.ok) throw new Error(invData?.error || `Failed to load ${docWord}s`);
            setInvoices((invData.invoices as InvoiceView[]).filter((i) => i.posted && i.amountDue > 0.005));
            setPayments(payRes.ok ? (payData.payments ?? []) : []);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load payment data');
        } finally {
            setLoading(false);
        }
    }, [ownerGuid, ownerType, docWord, error]);

    useEffect(() => { fetchData(); }, [fetchData]);

    const handleTypeChange = (next: ContactKind) => {
        if (next === ownerType) return;
        setOwnerType(next);
        setOwnerGuid('');
        setOwner(null);
        setInvoices([]);
        setPayments([]);
    };

    const totalDue = roundCents(invoices.reduce((s, i) => s + i.amountDue, 0));

    const typeButton = (value: ContactKind, label: string) => (
        <button
            type="button"
            onClick={() => handleTypeChange(value)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                ownerType === value
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
                title="Payments"
                subtitle="Receive customer payments and pay vendor bills."
                actions={
                    <button
                        type="button"
                        onClick={() => setModalOpen(true)}
                        disabled={isReadonly || !ownerGuid || invoices.length === 0}
                        title={isReadonly ? READONLY_TOOLTIP : !ownerGuid ? `Select a ${ownerType} first` : undefined}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        Record Payment
                    </button>
                }
                toolbar={
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex gap-1">
                            {typeButton('customer', 'Customers')}
                            {typeButton('vendor', 'Vendors')}
                        </div>
                        <OwnerSelector
                            key={ownerType}
                            kind={ownerType}
                            value={ownerGuid}
                            onChange={(guid, dto) => {
                                setOwnerGuid(guid);
                                setOwner(dto);
                            }}
                            className="w-full md:w-80"
                        />
                    </div>
                }
            />

            {!ownerGuid ? (
                <div className="bg-surface border border-border rounded-lg p-12 text-center text-foreground-muted">
                    Select a {ownerType} to see open {docWord}s and payment history.
                </div>
            ) : loading ? (
                <div className="bg-surface border border-border rounded-lg p-12 flex items-center justify-center gap-3">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading...</span>
                </div>
            ) : (
                <>
                    <div className="bg-surface border border-border rounded-lg overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
                            <h2 className="text-sm font-semibold text-foreground">
                                Open {docWord}s
                            </h2>
                            {totalDue > 0 && (
                                <span className="text-sm font-mono tabular-nums text-foreground-secondary" style={TNUM}>
                                    {formatCurrency(totalDue, currency)} due
                                </span>
                            )}
                        </div>
                        {invoices.length === 0 ? (
                            <p className="px-4 py-6 text-sm text-foreground-muted text-center">
                                Nothing outstanding for {owner?.name ?? `this ${ownerType}`}.
                            </p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-[13px]">
                                    <thead>
                                        <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                            <th className="px-4 py-2 font-semibold">#</th>
                                            <th className="px-4 py-2 font-semibold">Posted</th>
                                            <th className="px-4 py-2 font-semibold">Due</th>
                                            <th className="px-4 py-2 font-semibold text-right">Total</th>
                                            <th className="px-4 py-2 font-semibold text-right">Amount due</th>
                                            <th className="px-4 py-2 font-semibold">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                        {invoices.map((inv) => (
                                            <tr
                                                key={inv.guid}
                                                onClick={() => router.push(`/business/invoices/${inv.guid}`)}
                                                className="hover:bg-surface-hover/50 transition-colors cursor-pointer"
                                            >
                                                <td className="px-4 py-2 font-mono tabular-nums text-foreground" style={TNUM}>{inv.id}</td>
                                                <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{inv.datePosted ?? '—'}</td>
                                                <td className={`px-4 py-2 font-mono tabular-nums ${inv.status === 'overdue' ? 'text-negative' : 'text-foreground-secondary'}`} style={TNUM}>
                                                    {inv.dueDate ?? '—'}
                                                </td>
                                                <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                                    {formatCurrency(inv.totals.total, currency)}
                                                </td>
                                                <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                                    {formatCurrency(inv.amountDue, currency)}
                                                </td>
                                                <td className="px-4 py-2">
                                                    <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${STATUS_META[inv.status].className}`}>
                                                        {STATUS_META[inv.status].label}
                                                    </span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    <div className="bg-surface border border-border rounded-lg overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-border">
                            <h2 className="text-sm font-semibold text-foreground">Payment history</h2>
                        </div>
                        {payments.length === 0 ? (
                            <p className="px-4 py-6 text-sm text-foreground-muted text-center">No payments recorded yet.</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-[13px]">
                                    <thead>
                                        <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                            <th className="px-4 py-2 font-semibold">Date</th>
                                            <th className="px-4 py-2 font-semibold">Num</th>
                                            <th className="px-4 py-2 font-semibold">Description</th>
                                            <th className="px-4 py-2 font-semibold">Applied to</th>
                                            <th className="px-4 py-2 font-semibold text-right">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                        {payments.map((p) => (
                                            <tr key={p.transactionGuid} className="hover:bg-surface-hover/50 transition-colors">
                                                <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{p.date ?? '—'}</td>
                                                <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{p.num || '—'}</td>
                                                <td className="px-4 py-2 text-foreground-secondary max-w-xs truncate">{p.description}</td>
                                                <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>
                                                    {p.allocations.length === 0
                                                        ? '—'
                                                        : p.allocations.map((a) => a.invoiceId).join(', ')}
                                                </td>
                                                <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                                    {formatCurrency(p.amount, currency)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </>
            )}

            {owner && (
                <PaymentModal
                    isOpen={modalOpen}
                    onClose={() => setModalOpen(false)}
                    ownerType={ownerType}
                    ownerGuid={ownerGuid}
                    ownerName={owner.name}
                    currency={currency}
                    onSuccess={fetchData}
                />
            )}
        </div>
    );
}
