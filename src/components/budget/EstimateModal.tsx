'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { formatCurrency, applyBalanceReversal, BalanceReversal } from '@/lib/format';
// Type-only: keep the server-side estimate lib (prisma) out of the client bundle.
import type { EstimateMethod, BudgetEstimateResult } from '@/lib/budget-estimate';
import { useToast } from '@/contexts/ToastContext';

interface EstimateAccount {
    guid: string;
    name: string;
    type: string;
    mnemonic: string;
}

interface EstimateModalProps {
    isOpen: boolean;
    onClose: () => void;
    budgetGuid: string;
    account: EstimateAccount | null;
    /** Human label per period (index = period_num). */
    periodLabels: string[];
    balanceReversal: BalanceReversal;
    onApplied: () => void | Promise<void>;
}

const METHODS: Array<{ id: EstimateMethod; label: string; detail: string }> = [
    {
        id: 'average',
        label: 'Average',
        detail: 'Trailing average, same amount every period.',
    },
    {
        id: 'median',
        label: 'Median',
        detail: 'Typical month — resists one-off spikes.',
    },
    {
        id: 'seasonal',
        label: 'Seasonal',
        detail: 'Same period last year — utilities, holidays, anything cyclical.',
    },
];

export function EstimateModal({
    isOpen,
    onClose,
    budgetGuid,
    account,
    periodLabels,
    balanceReversal,
    onApplied,
}: EstimateModalProps) {
    const toast = useToast();
    const [method, setMethod] = useState<EstimateMethod>('average');
    const [months, setMonths] = useState(12);
    const [preview, setPreview] = useState<BudgetEstimateResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Load a preview whenever the modal opens or the method/window changes.
    useEffect(() => {
        if (!isOpen || !account) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        const params = new URLSearchParams({
            account_guid: account.guid,
            method,
            months: String(months),
        });
        fetch(`/api/budgets/${budgetGuid}/estimate?${params}`)
            .then(res => {
                if (!res.ok) throw new Error('Failed to compute estimate');
                return res.json();
            })
            .then((data: BudgetEstimateResult) => {
                if (!cancelled) setPreview(data);
            })
            .catch(() => {
                if (!cancelled) {
                    setPreview(null);
                    setError('Failed to compute estimate');
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen, account, budgetGuid, method, months]);

    // Fresh defaults each time the modal opens.
    useEffect(() => {
        if (isOpen) {
            setMethod('average');
            setMonths(12);
            setPreview(null);
            setError(null);
        }
    }, [isOpen]);

    if (!account) return null;

    const display = (raw: number) => applyBalanceReversal(raw, account.type, balanceReversal);

    const handleApply = async () => {
        if (!preview || applying) return;
        setApplying(true);
        setError(null);
        try {
            const res = await fetch(`/api/budgets/${budgetGuid}/amounts/all-periods`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account_guid: account.guid,
                    amounts: preview.periodAmounts,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to apply estimate');
            }
            toast.success(`Estimate applied to ${account.name}`);
            await onApplied();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to apply estimate');
        } finally {
            setApplying(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Estimate from history — ${account.name}`} size="md">
            <div className="p-6 space-y-4">
                {/* Method picker */}
                <div className="space-y-2">
                    {METHODS.map(m => (
                        <label
                            key={m.id}
                            className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                                method === m.id
                                    ? 'border-primary/60 bg-primary-light'
                                    : 'border-border hover:border-border-hover'
                            }`}
                        >
                            <input
                                type="radio"
                                name="estimate-method"
                                checked={method === m.id}
                                onChange={() => setMethod(m.id)}
                                className="mt-0.5 accent-teal-500"
                            />
                            <span>
                                <span className="block text-sm font-medium text-foreground">{m.label}</span>
                                <span className="block text-xs text-foreground-secondary mt-0.5">{m.detail}</span>
                            </span>
                        </label>
                    ))}
                </div>

                {/* Lookback window (average/median only) */}
                {method !== 'seasonal' && (
                    <label className="flex items-center gap-2">
                        <span className="text-xs text-foreground-secondary uppercase tracking-wider">Lookback</span>
                        <select
                            value={months}
                            onChange={e => setMonths(parseInt(e.target.value, 10))}
                            className="px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm"
                        >
                            <option value={6}>6 months</option>
                            <option value={12}>12 months</option>
                            <option value={24}>24 months</option>
                        </select>
                    </label>
                )}

                {error && (
                    <div className="p-3 bg-rose-900/30 text-rose-400 border border-rose-800/50 rounded-md text-sm">
                        {error}
                    </div>
                )}

                {/* Preview */}
                <div className="border border-border rounded-md">
                    {loading ? (
                        <div className="p-4 flex items-center gap-2 text-sm text-foreground-secondary">
                            <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                            Computing…
                        </div>
                    ) : preview ? (
                        <>
                            <div className="max-h-48 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 p-3">
                                {preview.periodAmounts.map((raw, i) => (
                                    <div key={i} className="flex items-baseline justify-between gap-2 text-sm">
                                        <span className="text-foreground-muted text-xs">{periodLabels[i] ?? `P${i + 1}`}</span>
                                        <span className="font-mono tabular-nums text-foreground">
                                            {formatCurrency(display(raw), account.mnemonic)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex items-center justify-between px-3 py-2 border-t border-border text-sm">
                                <span className="text-xs text-foreground-muted">
                                    {preview.transactionCount} transactions in window
                                </span>
                                <span className="font-mono tabular-nums font-semibold text-foreground">
                                    Total {formatCurrency(display(preview.total), account.mnemonic)}
                                </span>
                            </div>
                        </>
                    ) : (
                        <div className="p-4 text-sm text-foreground-muted">No preview available.</div>
                    )}
                </div>

                <div className="flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:bg-surface-hover rounded-md transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleApply}
                        disabled={!preview || loading || applying}
                        className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary-hover transition-colors disabled:opacity-50"
                    >
                        {applying ? 'Applying…' : 'Apply to budget'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
