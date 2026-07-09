'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { InvoiceView, PaymentResult } from '@/lib/business/invoice-engine';
import {
    allocationsToPayload,
    allocationsTotal,
    fifoAllocations,
    parseAmount,
    roundCents,
    todayIso,
    validatePayment,
    type OpenInvoiceLite,
} from '@/components/business/invoice-ui';

/** Account types offered as the transfer (deposit/funding) side of a payment. */
const TRANSFER_ACCOUNT_TYPES = ['BANK', 'CASH', 'ASSET', 'CREDIT'];

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

interface PaymentModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** End owner of the documents being paid (jobs resolve to their owner). */
    ownerType: 'customer' | 'vendor';
    ownerGuid: string;
    ownerName: string;
    /** Currency mnemonic for display (documents share the owner currency). */
    currency?: string;
    /** When set, the amount defaults to this invoice's amount due. */
    focusInvoiceGuid?: string;
    onSuccess?: (result: PaymentResult) => void;
}

/**
 * Record a customer or vendor payment: transfer account, amount, date, and an
 * editable per-invoice allocation table seeded with the engine's FIFO
 * (oldest-first) default. Shared by the invoice detail page and the payment
 * center.
 */
export function PaymentModal({
    isOpen,
    onClose,
    ownerType,
    ownerGuid,
    ownerName,
    currency = 'USD',
    focusInvoiceGuid,
    onSuccess,
}: PaymentModalProps) {
    const { success, error } = useToast();
    const docWord = ownerType === 'customer' ? 'invoice' : 'bill';

    const [openInvoices, setOpenInvoices] = useState<OpenInvoiceLite[]>([]);
    const [loading, setLoading] = useState(false);
    const [accountGuid, setAccountGuid] = useState('');
    const [amount, setAmount] = useState('');
    const [date, setDate] = useState(todayIso());
    const [num, setNum] = useState('');
    const [memo, setMemo] = useState('');
    const [allocations, setAllocations] = useState<Record<string, string>>({});
    /** Once the user edits an allocation cell we stop re-running FIFO. */
    const [allocationsTouched, setAllocationsTouched] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const totalDue = useMemo(
        () => roundCents(openInvoices.reduce((s, i) => s + i.amountDue, 0)),
        [openInvoices],
    );

    const applyFifo = useCallback((invoices: OpenInvoiceLite[], amt: number) => {
        const fifo = fifoAllocations(invoices, amt);
        const next: Record<string, string> = {};
        for (const inv of invoices) {
            next[inv.guid] = fifo[inv.guid] ? fifo[inv.guid].toFixed(2) : '';
        }
        setAllocations(next);
    }, []);

    // Load open documents and seed defaults each time the modal opens.
    useEffect(() => {
        if (!isOpen || !ownerGuid) return;
        let cancelled = false;
        setLoading(true);
        const type = ownerType === 'customer' ? 'invoice' : 'bill';
        fetch(`/api/business/invoices?type=${type}&ownerGuid=${ownerGuid}`)
            .then((res) => (res.ok ? res.json() : { invoices: [] }))
            .then((data: { invoices: InvoiceView[] }) => {
                if (cancelled) return;
                const open = (data.invoices ?? [])
                    .filter((i) => i.posted && i.amountDue > 0.005)
                    .map((i) => ({
                        guid: i.guid,
                        id: i.id,
                        datePosted: i.datePosted,
                        dueDate: i.dueDate,
                        amountDue: i.amountDue,
                    }));
                setOpenInvoices(open);
                const focused = focusInvoiceGuid ? open.find((i) => i.guid === focusInvoiceGuid) : null;
                const defaultAmount = focused
                    ? focused.amountDue
                    : roundCents(open.reduce((s, i) => s + i.amountDue, 0));
                setAmount(defaultAmount > 0 ? defaultAmount.toFixed(2) : '');
                if (focused) {
                    const next: Record<string, string> = {};
                    for (const inv of open) next[inv.guid] = inv.guid === focused.guid ? focused.amountDue.toFixed(2) : '';
                    setAllocations(next);
                    setAllocationsTouched(true);
                } else {
                    setAllocationsTouched(false);
                    const fifo = fifoAllocations(open, defaultAmount);
                    const next: Record<string, string> = {};
                    for (const inv of open) next[inv.guid] = fifo[inv.guid] ? fifo[inv.guid].toFixed(2) : '';
                    setAllocations(next);
                }
            })
            .catch(() => {
                if (!cancelled) setOpenInvoices([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen, ownerGuid, ownerType, focusInvoiceGuid]);

    // Reset transient fields when closing.
    useEffect(() => {
        if (!isOpen) {
            setAccountGuid('');
            setNum('');
            setMemo('');
            setDate(todayIso());
        }
    }, [isOpen]);

    const handleAmountChange = (value: string) => {
        setAmount(value);
        if (!allocationsTouched) applyFifo(openInvoices, parseAmount(value));
    };

    const handleAllocationChange = (guid: string, value: string) => {
        setAllocationsTouched(true);
        setAllocations((prev) => ({ ...prev, [guid]: value }));
    };

    const resetToFifo = () => {
        setAllocationsTouched(false);
        applyFifo(openInvoices, parseAmount(amount));
    };

    const allocated = allocationsTotal(allocations);
    const amountNum = parseAmount(amount);
    const unallocated = roundCents(amountNum - allocated);
    const validationError =
        !accountGuid ? 'Select a transfer account'
        : !date ? 'Date is required'
        : validatePayment(amountNum, allocations, openInvoices);

    const handleSubmit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (validationError) {
            error(validationError);
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch('/api/business/payments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ownerType,
                    ownerGuid,
                    transferAccountGuid: accountGuid,
                    amount: amountNum,
                    date,
                    num: num || undefined,
                    memo: memo || undefined,
                    allocations: allocationsToPayload(allocations),
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to record payment');
            }
            const result: PaymentResult = data.result;
            const paidCount = result.fullyPaidInvoiceGuids?.length ?? 0;
            success(
                paidCount > 0
                    ? `Payment recorded — ${paidCount} ${docWord}${paidCount === 1 ? '' : 's'} fully paid`
                    : 'Payment recorded',
            );
            onSuccess?.(result);
            onClose();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to record payment');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={submitting ? () => {} : onClose}
            title={ownerType === 'customer' ? 'Record Payment' : 'Pay Bill'}
            size="lg"
        >
            <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
                <p className="text-sm text-foreground-secondary">
                    {ownerType === 'customer' ? 'Payment from' : 'Payment to'}{' '}
                    <span className="text-foreground font-medium">{ownerName}</span>
                    {totalDue > 0 && (
                        <span className="ml-2 font-mono tabular-nums text-foreground-muted" style={TNUM}>
                            ({formatCurrency(totalDue, currency)} outstanding)
                        </span>
                    )}
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                        <label className={labelClass}>Transfer account *</label>
                        <AccountSelector
                            value={accountGuid}
                            onChange={(guid) => setAccountGuid(guid)}
                            accountTypes={TRANSFER_ACCOUNT_TYPES}
                            placeholder={ownerType === 'customer' ? 'Deposit to account...' : 'Pay from account...'}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Amount *</label>
                        <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={amount}
                            onChange={(e) => handleAmountChange(e.target.value)}
                            className={`${inputClass} font-mono text-right`}
                            style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Date *</label>
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Num / check #</label>
                        <input
                            type="text"
                            value={num}
                            onChange={(e) => setNum(e.target.value)}
                            className={`${inputClass} font-mono`}
                            placeholder="Optional"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Memo</label>
                        <input
                            type="text"
                            value={memo}
                            onChange={(e) => setMemo(e.target.value)}
                            className={inputClass}
                            placeholder="Optional"
                        />
                    </div>
                </div>

                <div>
                    <div className="flex items-center justify-between mb-1">
                        <label className={`${labelClass} mb-0`}>
                            Apply to open {docWord}s
                        </label>
                        <button
                            type="button"
                            onClick={resetToFifo}
                            disabled={openInvoices.length === 0}
                            className="text-xs text-primary hover:text-primary-hover transition-colors disabled:opacity-50"
                        >
                            Auto-apply oldest first
                        </button>
                    </div>
                    <div className="border border-border rounded-lg overflow-hidden">
                        {loading ? (
                            <p className="px-3 py-4 text-sm text-foreground-muted text-center">Loading open {docWord}s...</p>
                        ) : openInvoices.length === 0 ? (
                            <p className="px-3 py-4 text-sm text-foreground-muted text-center">No open {docWord}s for this {ownerType}.</p>
                        ) : (
                            <table className="w-full text-left text-[13px]">
                                <thead>
                                    <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                        <th className="px-3 py-1.5 font-semibold">#</th>
                                        <th className="px-3 py-1.5 font-semibold">Posted</th>
                                        <th className="px-3 py-1.5 font-semibold">Due</th>
                                        <th className="px-3 py-1.5 font-semibold text-right">Amount due</th>
                                        <th className="px-3 py-1.5 font-semibold text-right w-32">Apply</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {openInvoices.map((inv) => (
                                        <tr key={inv.guid} className={inv.guid === focusInvoiceGuid ? 'bg-primary/5' : ''}>
                                            <td className="px-3 py-1.5 font-mono tabular-nums text-foreground" style={TNUM}>{inv.id}</td>
                                            <td className="px-3 py-1.5 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{inv.datePosted ?? '—'}</td>
                                            <td className="px-3 py-1.5 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{inv.dueDate ?? '—'}</td>
                                            <td className="px-3 py-1.5 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                                {formatCurrency(inv.amountDue, currency)}
                                            </td>
                                            <td className="px-2 py-1 text-right">
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    value={allocations[inv.guid] ?? ''}
                                                    onChange={(e) => handleAllocationChange(inv.guid, e.target.value)}
                                                    className="w-28 bg-input-bg border border-border rounded-md px-2 py-1 text-[13px] font-mono text-right text-foreground focus:outline-none focus:border-primary/50 transition-all"
                                                    style={TNUM}
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t border-border text-xs">
                                        <td colSpan={3} className="px-3 py-1.5 text-foreground-muted">
                                            Allocated
                                        </td>
                                        <td className="px-3 py-1.5 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                            {formatCurrency(allocated, currency)}
                                        </td>
                                        <td className={`px-3 py-1.5 font-mono tabular-nums text-right ${Math.abs(unallocated) > 0.005 ? 'text-negative' : 'text-foreground-muted'}`} style={TNUM}>
                                            {Math.abs(unallocated) > 0.005 ? `${unallocated > 0 ? '+' : ''}${unallocated.toFixed(2)}` : 'balanced'}
                                        </td>
                                    </tr>
                                </tfoot>
                            </table>
                        )}
                    </div>
                </div>

                <div className="flex justify-end gap-3 pt-2 border-t border-border">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={submitting}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={submitting || !!validationError || openInvoices.length === 0}
                        title={validationError ?? undefined}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                    >
                        {submitting ? 'Recording...' : 'Record Payment'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
