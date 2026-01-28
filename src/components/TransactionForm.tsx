'use client';

import { useState, useEffect } from 'react';
import { SplitFormData, TransactionFormData, CreateTransactionRequest, Transaction } from '@/lib/types';
import { SplitRow } from './SplitRow';
import { toNumDenom } from '@/lib/validation';
import { AccountSelector } from './ui/AccountSelector';

interface TransactionFormProps {
    transaction?: Transaction | null;
    onSave: (data: CreateTransactionRequest) => Promise<void>;
    onCancel: () => void;
    defaultCurrencyGuid?: string;
    simpleMode?: boolean;
    defaultFromAccount?: string;
    defaultToAccount?: string;
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
    simpleMode = true,
    defaultFromAccount = '',
    defaultToAccount = '',
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
    const [isSimpleMode, setIsSimpleMode] = useState(simpleMode);
    const [simpleData, setSimpleData] = useState({
        amount: '',
        fromAccountGuid: defaultFromAccount,
        toAccountGuid: defaultToAccount,
    });

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

            // If editing a transaction with more than 2 splits, use advanced mode
            if (splits.length > 2) {
                setIsSimpleMode(false);
            } else if (splits.length === 2) {
                // If editing a 2-split transaction, populate simple mode data
                const debitSplit = splits.find(s => parseFloat(s.debit) > 0);
                const creditSplit = splits.find(s => parseFloat(s.credit) > 0);
                if (debitSplit && creditSplit) {
                    setSimpleData({
                        amount: debitSplit.debit,
                        fromAccountGuid: creditSplit.account_guid,
                        toAccountGuid: debitSplit.account_guid,
                    });
                }
            }
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

    const switchToAdvanced = () => {
        // Convert simple data to splits format
        if (simpleData.amount && simpleData.fromAccountGuid && simpleData.toAccountGuid) {
            const amount = parseFloat(simpleData.amount);
            setFormData(prev => ({
                ...prev,
                splits: [
                    {
                        id: crypto.randomUUID(),
                        account_guid: simpleData.fromAccountGuid,
                        account_name: '',
                        debit: '',
                        credit: amount.toFixed(2),
                        memo: '',
                        reconcile_state: 'n',
                    },
                    {
                        id: crypto.randomUUID(),
                        account_guid: simpleData.toAccountGuid,
                        account_name: '',
                        debit: amount.toFixed(2),
                        credit: '',
                        memo: '',
                        reconcile_state: 'n',
                    },
                ],
            }));
        }
        setIsSimpleMode(false);
    };

    const switchToSimple = () => {
        // Try to extract simple data from splits if it's a 2-split transaction
        if (formData.splits.length === 2) {
            const debitSplit = formData.splits.find(s => parseFloat(s.debit) > 0);
            const creditSplit = formData.splits.find(s => parseFloat(s.credit) > 0);
            if (debitSplit && creditSplit) {
                setSimpleData({
                    amount: debitSplit.debit,
                    fromAccountGuid: creditSplit.account_guid,
                    toAccountGuid: debitSplit.account_guid,
                });
            }
        }
        setIsSimpleMode(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrors([]);

        // Prepare splits - either from simple mode or advanced mode
        let submissionSplits: SplitFormData[];

        if (isSimpleMode) {
            // Validate simple mode
            const validationErrors: string[] = [];
            if (!formData.description.trim()) {
                validationErrors.push('Description is required');
            }
            if (!formData.post_date) {
                validationErrors.push('Post date is required');
            }
            if (!simpleData.amount || parseFloat(simpleData.amount) <= 0) {
                validationErrors.push('Amount must be greater than zero');
            }
            if (!simpleData.fromAccountGuid) {
                validationErrors.push('From account is required');
            }
            if (!simpleData.toAccountGuid) {
                validationErrors.push('To account is required');
            }
            if (simpleData.fromAccountGuid === simpleData.toAccountGuid) {
                validationErrors.push('From and To accounts must be different');
            }

            if (validationErrors.length > 0) {
                setErrors(validationErrors);
                return;
            }

            // Generate splits from simple data
            const amount = parseFloat(simpleData.amount);
            submissionSplits = [
                {
                    id: crypto.randomUUID(),
                    account_guid: simpleData.fromAccountGuid,
                    account_name: '',
                    debit: '',
                    credit: amount.toFixed(2),
                    memo: '',
                    reconcile_state: 'n',
                },
                {
                    id: crypto.randomUUID(),
                    account_guid: simpleData.toAccountGuid,
                    account_name: '',
                    debit: amount.toFixed(2),
                    credit: '',
                    memo: '',
                    reconcile_state: 'n',
                },
            ];
        } else {
            // Validate advanced mode
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

            submissionSplits = formData.splits;
        }

        // Convert form data to API format
        const apiData: CreateTransactionRequest = {
            currency_guid: formData.currency_guid,
            num: formData.num || undefined,
            post_date: formData.post_date,
            description: formData.description,
            splits: submissionSplits
                .filter(split => split.account_guid)
                .map(split => {
                    const debit = parseFloat(split.debit) || 0;
                    const credit = parseFloat(split.credit) || 0;
                    const netValue = debit - credit;
                    const { num: valueNum, denom: valueDenom } = toNumDenom(netValue);

                    // Calculate quantity if exchange rate is provided
                    let quantityNum = valueNum;
                    let quantityDenom = valueDenom;

                    if (split.exchange_rate) {
                        const rate = parseFloat(split.exchange_rate);
                        if (!isNaN(rate) && rate > 0) {
                            // quantity = value × exchange_rate (for account commodity)
                            const quantityValue = netValue * rate;
                            const { num: qNum, denom: qDenom } = toNumDenom(quantityValue);
                            quantityNum = qNum;
                            quantityDenom = qDenom;
                        }
                    }

                    return {
                        account_guid: split.account_guid,
                        value_num: valueNum,
                        value_denom: valueDenom,
                        quantity_num: quantityNum,
                        quantity_denom: quantityDenom,
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

            {/* Mode Toggle and Content */}
            {isSimpleMode ? (
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <label className="text-xs text-neutral-500 uppercase tracking-wider">
                            Simple Transfer
                        </label>
                        <button
                            type="button"
                            onClick={switchToAdvanced}
                            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                        >
                            Switch to Advanced (Multiple Splits)
                        </button>
                    </div>

                    {/* Amount */}
                    <div>
                        <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                            Amount
                        </label>
                        <input
                            type="number"
                            step="0.01"
                            value={simpleData.amount}
                            onChange={(e) => setSimpleData(prev => ({ ...prev, amount: e.target.value }))}
                            placeholder="0.00"
                            className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-cyan-500/50"
                        />
                    </div>

                    {/* From/To accounts */}
                    <div className="flex items-center gap-4">
                        <div className="flex-1">
                            <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                                From Account
                            </label>
                            <AccountSelector
                                value={simpleData.fromAccountGuid}
                                onChange={(guid) => setSimpleData(prev => ({ ...prev, fromAccountGuid: guid }))}
                                placeholder="Select source account..."
                            />
                        </div>
                        <div className="flex items-center justify-center pt-5">
                            <svg className="w-6 h-6 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                            </svg>
                        </div>
                        <div className="flex-1">
                            <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                                To Account
                            </label>
                            <AccountSelector
                                value={simpleData.toAccountGuid}
                                onChange={(guid) => setSimpleData(prev => ({ ...prev, toAccountGuid: guid }))}
                                placeholder="Select destination account..."
                            />
                        </div>
                    </div>
                </div>
            ) : (
                <div>
                    <div className="flex items-center justify-between mb-3">
                        <label className="text-xs text-neutral-500 uppercase tracking-wider">
                            Splits (Advanced)
                        </label>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={switchToSimple}
                                className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                            >
                                Switch to Simple Mode
                            </button>
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
                                transactionCurrencyGuid={formData.currency_guid}
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
            )}

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
