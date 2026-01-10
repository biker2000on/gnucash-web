'use client';

import { useState, useEffect } from 'react';
import { SplitFormData, TransactionFormData, CreateTransactionRequest, Transaction } from '@/lib/types';
import { SplitRow } from './SplitRow';
import { toNumDenom } from '@/lib/validation';

interface TransactionFormProps {
    transaction?: Transaction | null;
    onSave: (data: CreateTransactionRequest) => Promise<void>;
    onCancel: () => void;
    defaultCurrencyGuid?: string;
}

const createEmptySplit = (): SplitFormData => ({
    id: crypto.randomUUID(),
    account_guid: '',
    account_name: '',
    debit: '',
    credit: '',
    memo: '',
    reconcile_state: 'n',
});

export function TransactionForm({
    transaction,
    onSave,
    onCancel,
    defaultCurrencyGuid,
}: TransactionFormProps) {
    const [formData, setFormData] = useState<TransactionFormData>({
        post_date: new Date().toISOString().split('T')[0],
        description: '',
        num: '',
        currency_guid: defaultCurrencyGuid || '',
        splits: [createEmptySplit(), createEmptySplit()],
    });
    const [errors, setErrors] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);

    // Load transaction data for editing
    useEffect(() => {
        if (transaction) {
            const splits: SplitFormData[] = transaction.splits?.map(split => {
                const value = parseFloat(split.quantity_decimal || '0');
                return {
                    id: split.guid,
                    account_guid: split.account_guid,
                    account_name: split.account_name || '',
                    debit: value > 0 ? value.toFixed(2) : '',
                    credit: value < 0 ? Math.abs(value).toFixed(2) : '',
                    memo: split.memo || '',
                    reconcile_state: split.reconcile_state as 'n' | 'c' | 'y' || 'n',
                };
            }) || [createEmptySplit(), createEmptySplit()];

            setFormData({
                post_date: new Date(transaction.post_date).toISOString().split('T')[0],
                description: transaction.description,
                num: transaction.num || '',
                currency_guid: transaction.currency_guid,
                splits,
            });
        }
    }, [transaction]);

    // Fetch default currency if not provided
    useEffect(() => {
        if (!defaultCurrencyGuid && !transaction) {
            fetch('/api/commodities?type=CURRENCY')
                .then(res => res.json())
                .then(data => {
                    if (data.length > 0) {
                        // Try to find USD, else use first currency
                        const usd = data.find((c: { mnemonic: string }) => c.mnemonic === 'USD');
                        setFormData(f => ({
                            ...f,
                            currency_guid: (usd || data[0]).guid,
                        }));
                    }
                })
                .catch(console.error);
        }
    }, [defaultCurrencyGuid, transaction]);

    const handleSplitChange = (index: number, field: keyof SplitFormData, value: string) => {
        setFormData(prev => {
            const newSplits = [...prev.splits];
            newSplits[index] = { ...newSplits[index], [field]: value };
            return { ...prev, splits: newSplits };
        });
    };

    const handleAddSplit = () => {
        setFormData(prev => ({
            ...prev,
            splits: [...prev.splits, createEmptySplit()],
        }));
    };

    const handleRemoveSplit = (index: number) => {
        setFormData(prev => ({
            ...prev,
            splits: prev.splits.filter((_, i) => i !== index),
        }));
    };

    const calculateBalance = () => {
        let totalDebit = 0;
        let totalCredit = 0;
        formData.splits.forEach(split => {
            totalDebit += parseFloat(split.debit) || 0;
            totalCredit += parseFloat(split.credit) || 0;
        });
        return { totalDebit, totalCredit, difference: totalDebit - totalCredit };
    };

    const autoBalanceLastSplit = () => {
        const { difference } = calculateBalance();
        if (Math.abs(difference) < 0.01) return;

        setFormData(prev => {
            const newSplits = [...prev.splits];
            const lastIndex = newSplits.length - 1;
            const lastSplit = newSplits[lastIndex];

            if (difference > 0) {
                // Need more credit
                newSplits[lastIndex] = {
                    ...lastSplit,
                    credit: (parseFloat(lastSplit.credit) || 0 + difference).toFixed(2),
                    debit: '',
                };
            } else {
                // Need more debit
                newSplits[lastIndex] = {
                    ...lastSplit,
                    debit: (parseFloat(lastSplit.debit) || 0 + Math.abs(difference)).toFixed(2),
                    credit: '',
                };
            }
            return { ...prev, splits: newSplits };
        });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrors([]);

        // Validate
        const validationErrors: string[] = [];
        if (!formData.description.trim()) {
            validationErrors.push('Description is required');
        }
        if (!formData.post_date) {
            validationErrors.push('Post date is required');
        }
        if (formData.splits.filter(s => s.account_guid).length < 2) {
            validationErrors.push('At least 2 accounts must be selected');
        }

        const { difference } = calculateBalance();
        if (Math.abs(difference) > 0.01) {
            validationErrors.push(`Transaction is unbalanced by ${difference.toFixed(2)}. Debits must equal credits.`);
        }

        if (validationErrors.length > 0) {
            setErrors(validationErrors);
            return;
        }

        // Convert form data to API format
        const apiData: CreateTransactionRequest = {
            currency_guid: formData.currency_guid,
            num: formData.num || undefined,
            post_date: formData.post_date,
            description: formData.description,
            splits: formData.splits
                .filter(split => split.account_guid)
                .map(split => {
                    const debit = parseFloat(split.debit) || 0;
                    const credit = parseFloat(split.credit) || 0;
                    const netValue = debit - credit;
                    const { num, denom } = toNumDenom(netValue);
                    return {
                        account_guid: split.account_guid,
                        value_num: num,
                        value_denom: denom,
                        memo: split.memo || undefined,
                        reconcile_state: split.reconcile_state,
                    };
                }),
        };

        setSaving(true);
        try {
            await onSave(apiData);
        } catch (error) {
            if (error instanceof Error) {
                setErrors([error.message]);
            } else {
                setErrors(['An error occurred while saving']);
            }
        } finally {
            setSaving(false);
        }
    };

    const { totalDebit, totalCredit, difference } = calculateBalance();

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            {/* Error Messages */}
            {errors.length > 0 && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4">
                    <ul className="list-disc list-inside text-sm text-rose-400 space-y-1">
                        {errors.map((error, i) => (
                            <li key={i}>{error}</li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Header Fields */}
            <div className="grid grid-cols-3 gap-4">
                <div>
                    <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                        Date
                    </label>
                    <input
                        type="date"
                        value={formData.post_date}
                        onChange={(e) => setFormData(f => ({ ...f, post_date: e.target.value }))}
                        className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                    />
                </div>
                <div className="col-span-2">
                    <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                        Description
                    </label>
                    <input
                        type="text"
                        value={formData.description}
                        onChange={(e) => setFormData(f => ({ ...f, description: e.target.value }))}
                        placeholder="Enter description..."
                        className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-cyan-500/50"
                    />
                </div>
            </div>

            <div>
                <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                    Number/Reference
                </label>
                <input
                    type="text"
                    value={formData.num}
                    onChange={(e) => setFormData(f => ({ ...f, num: e.target.value }))}
                    placeholder="Check #, reference, etc."
                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-cyan-500/50"
                />
            </div>

            {/* Splits Section */}
            <div>
                <div className="flex items-center justify-between mb-3">
                    <label className="text-xs text-neutral-500 uppercase tracking-wider">
                        Splits
                    </label>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={autoBalanceLastSplit}
                            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                        >
                            Auto-balance
                        </button>
                        <button
                            type="button"
                            onClick={handleAddSplit}
                            className="text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-3 py-1 rounded-lg transition-colors"
                        >
                            + Add Split
                        </button>
                    </div>
                </div>

                {/* Column Headers */}
                <div className="grid grid-cols-12 gap-2 text-xs text-neutral-500 uppercase tracking-wider py-2 border-b border-neutral-700">
                    <div className="col-span-5">Account</div>
                    <div className="col-span-2 text-right">Debit</div>
                    <div className="col-span-2 text-right">Credit</div>
                    <div className="col-span-2">Memo</div>
                    <div className="col-span-1"></div>
                </div>

                {/* Split Rows */}
                <div className="bg-neutral-950/30 rounded-lg">
                    {formData.splits.map((split, index) => (
                        <SplitRow
                            key={split.id}
                            split={split}
                            index={index}
                            onChange={handleSplitChange}
                            onRemove={handleRemoveSplit}
                            canRemove={formData.splits.length > 2}
                        />
                    ))}
                </div>

                {/* Totals */}
                <div className="grid grid-cols-12 gap-2 text-sm font-mono py-3 border-t border-neutral-700 mt-2">
                    <div className="col-span-5 text-neutral-400 text-right pr-2">Totals:</div>
                    <div className="col-span-2 text-right text-emerald-400">
                        {totalDebit.toFixed(2)}
                    </div>
                    <div className="col-span-2 text-right text-rose-400">
                        {totalCredit.toFixed(2)}
                    </div>
                    <div className="col-span-3 text-right">
                        {Math.abs(difference) > 0.01 ? (
                            <span className="text-amber-400">
                                Difference: {difference.toFixed(2)}
                            </span>
                        ) : (
                            <span className="text-emerald-400">Balanced</span>
                        )}
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4 border-t border-neutral-800">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-lg transition-colors flex items-center gap-2"
                >
                    {saving ? (
                        <>
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Saving...
                        </>
                    ) : (
                        transaction ? 'Update Transaction' : 'Create Transaction'
                    )}
                </button>
            </div>
        </form>
    );
}
