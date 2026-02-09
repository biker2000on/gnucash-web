'use client';

import { useState, useEffect, useMemo } from 'react';
import { Account, CreateTransactionRequest } from '@/lib/types';
import { toNumDenom } from '@/lib/validation';
import { useAccounts } from '@/lib/hooks/useAccounts';

type InvestmentAction = 'Buy' | 'Sell' | 'Dividend' | 'ReturnOfCapital' | 'Split';

// Helper to strip "Root Account:" prefix from account paths
function formatAccountPath(fullname: string | undefined, name: string): string {
    const path = fullname || name;
    if (path.startsWith('Root Account:')) {
        return path.substring('Root Account:'.length);
    }
    return path;
}

interface InvestmentTransactionFormProps {
    accountGuid: string;
    accountName: string;
    accountCommodityGuid: string;
    commoditySymbol: string;
    onSave: () => void;
    onCancel: () => void;
}

interface FormState {
    action: InvestmentAction;
    date: string;
    shares: string;
    pricePerShare: string;
    total: string;
    amount: string;
    commission: string;
    cashAccountGuid: string;
    cashAccountName: string;
    incomeAccountGuid: string;
    incomeAccountName: string;
    expenseAccountGuid: string;
    expenseAccountName: string;
    memo: string;
    splitRatio: string;
}

const INITIAL_FORM_STATE: FormState = {
    action: 'Buy',
    date: new Date().toISOString().split('T')[0],
    shares: '',
    pricePerShare: '',
    total: '',
    amount: '',
    commission: '',
    cashAccountGuid: '',
    cashAccountName: '',
    incomeAccountGuid: '',
    incomeAccountName: '',
    expenseAccountGuid: '',
    expenseAccountName: '',
    memo: '',
    splitRatio: '',
};

const ACTION_OPTIONS: { value: InvestmentAction; label: string; description: string }[] = [
    { value: 'Buy', label: 'Buy', description: 'Purchase shares' },
    { value: 'Sell', label: 'Sell', description: 'Sell shares' },
    { value: 'Dividend', label: 'Dividend', description: 'Cash dividend received' },
    { value: 'ReturnOfCapital', label: 'Return of Capital', description: 'Reduce cost basis' },
    { value: 'Split', label: 'Stock Split', description: 'Add shares from split' },
];

export function InvestmentTransactionForm({
    accountGuid,
    accountName,
    accountCommodityGuid,
    commoditySymbol,
    onSave,
    onCancel,
}: InvestmentTransactionFormProps) {
    const [form, setForm] = useState<FormState>(INITIAL_FORM_STATE);
    const [errors, setErrors] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [currencyGuid, setCurrencyGuid] = useState<string>('');

    // Track which fields have been edited for auto-calculation
    type EditedField = 'shares' | 'price' | 'total';
    const [editHistory, setEditHistory] = useState<EditedField[]>([]);

    const recordEdit = (field: EditedField) => {
        setEditHistory(prev => {
            const filtered = prev.filter(f => f !== field);
            const updated = [field, ...filtered];
            return updated.slice(0, 2);
        });
    };

    const getCalculatedField = (): EditedField | null => {
        if (editHistory.length < 2) return null;
        const editedSet = new Set(editHistory);
        if (!editedSet.has('shares')) return 'shares';
        if (!editedSet.has('price')) return 'price';
        if (!editedSet.has('total')) return 'total';
        return null;
    };

    // Fetch all accounts for selectors
    const { data: accounts = [], isLoading: loadingAccounts } = useAccounts({ flat: true });

    // Filter accounts by type for selectors
    const cashAccounts = useMemo(() =>
        accounts.filter(a => ['BANK', 'ASSET', 'CASH'].includes(a.account_type)),
        [accounts]
    );

    const incomeAccounts = useMemo(() =>
        accounts.filter(a => a.account_type === 'INCOME'),
        [accounts]
    );

    const expenseAccounts = useMemo(() =>
        accounts.filter(a => a.account_type === 'EXPENSE'),
        [accounts]
    );

    // Fetch USD currency GUID
    useEffect(() => {
        fetch('/api/commodities?type=CURRENCY')
            .then(res => res.json())
            .then(data => {
                const usd = data.find((c: { mnemonic: string }) => c.mnemonic === 'USD');
                if (usd) setCurrencyGuid(usd.guid);
                else if (data.length > 0) setCurrencyGuid(data[0].guid);
            })
            .catch(console.error);
    }, []);

    // Auto-select default accounts based on common patterns
    useEffect(() => {
        if (accounts.length > 0) {
            // Find default dividend income account
            const dividendIncome = accounts.find(a =>
                a.account_type === 'INCOME' &&
                (a.fullname?.toLowerCase().includes('dividend') || a.name.toLowerCase().includes('dividend'))
            );
            if (dividendIncome && !form.incomeAccountGuid) {
                setForm(f => ({
                    ...f,
                    incomeAccountGuid: dividendIncome.guid,
                    incomeAccountName: dividendIncome.fullname || dividendIncome.name,
                }));
            }

            // Find default expense account for commissions
            const commissionExpense = accounts.find(a =>
                a.account_type === 'EXPENSE' &&
                (a.fullname?.toLowerCase().includes('commission') ||
                 a.fullname?.toLowerCase().includes('fee') ||
                 a.name.toLowerCase().includes('commission') ||
                 a.name.toLowerCase().includes('fee'))
            );
            if (commissionExpense && !form.expenseAccountGuid) {
                setForm(f => ({
                    ...f,
                    expenseAccountGuid: commissionExpense.guid,
                    expenseAccountName: commissionExpense.fullname || commissionExpense.name,
                }));
            }
        }
    }, [accounts, form.incomeAccountGuid, form.expenseAccountGuid]);

    // Calculate derived value based on which field should be auto-calculated
    useEffect(() => {
        const calculatedField = getCalculatedField();
        if (!calculatedField) return;

        const shares = parseFloat(form.shares) || 0;
        const price = parseFloat(form.pricePerShare) || 0;
        const total = parseFloat(form.total) || 0;

        let newValue: number | null = null;
        let targetField: string | null = null;

        switch (calculatedField) {
            case 'total':
                newValue = shares * price;
                targetField = 'total';
                break;
            case 'price':
                if (shares > 0) {
                    newValue = total / shares;
                    targetField = 'pricePerShare';
                }
                break;
            case 'shares':
                if (price > 0) {
                    newValue = total / price;
                    targetField = 'shares';
                }
                break;
        }

        if (newValue !== null && targetField) {
            const decimals = targetField === 'shares' ? 4 : 2;
            const formatted = newValue > 0 ? newValue.toFixed(decimals) : '';
            const currentValue = form[targetField as keyof typeof form];
            if (currentValue !== formatted) {
                setForm(prev => ({ ...prev, [targetField!]: formatted }));
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form.shares, form.pricePerShare, form.total, editHistory]);

    // Calculate total for summary display (using form.total when available, else computed)
    const calculatedTotal = useMemo(() => {
        const totalFromForm = parseFloat(form.total);
        if (!isNaN(totalFromForm) && totalFromForm > 0) {
            return totalFromForm;
        }
        const shares = parseFloat(form.shares) || 0;
        const price = parseFloat(form.pricePerShare) || 0;
        return shares * price;
    }, [form.shares, form.pricePerShare, form.total]);

    const handleChange = (field: keyof FormState, value: string) => {
        setForm(prev => ({ ...prev, [field]: value }));
        // Reset edit history when action changes
        if (field === 'action') {
            setEditHistory([]);
        }
    };

    const handleNumericFieldChange = (
        field: 'shares' | 'pricePerShare' | 'total',
        value: string
    ) => {
        const fieldMap: Record<string, EditedField> = {
            shares: 'shares',
            pricePerShare: 'price',
            total: 'total',
        };

        setForm(prev => ({ ...prev, [field]: value }));

        if (value.trim() !== '') {
            recordEdit(fieldMap[field]);
        } else {
            setEditHistory(prev => prev.filter(f => f !== fieldMap[field]));
        }
    };

    const handleAccountSelect = (
        field: 'cashAccountGuid' | 'incomeAccountGuid' | 'expenseAccountGuid',
        nameField: 'cashAccountName' | 'incomeAccountName' | 'expenseAccountName',
        account: Account
    ) => {
        setForm(prev => ({
            ...prev,
            [field]: account.guid,
            [nameField]: account.fullname || account.name,
        }));
    };

    const validateForm = (): string[] => {
        const errs: string[] = [];

        if (!form.date) errs.push('Date is required');

        switch (form.action) {
            case 'Buy':
            case 'Sell': {
                if (!form.shares || parseFloat(form.shares) <= 0) {
                    errs.push('Shares must be a positive number');
                }
                if (!form.pricePerShare || parseFloat(form.pricePerShare) <= 0) {
                    errs.push('Price per share must be a positive number');
                }
                const total = parseFloat(form.total) || 0;
                if (total <= 0) {
                    errs.push('Total must be a positive number');
                }
                if (!form.cashAccountGuid) {
                    errs.push('Cash account is required');
                }
                break;
            }

            case 'Dividend':
                if (!form.amount || parseFloat(form.amount) <= 0) {
                    errs.push('Dividend amount must be a positive number');
                }
                if (!form.cashAccountGuid) {
                    errs.push('Cash account is required');
                }
                if (!form.incomeAccountGuid) {
                    errs.push('Income account is required');
                }
                break;

            case 'ReturnOfCapital':
                if (!form.amount || parseFloat(form.amount) <= 0) {
                    errs.push('Amount must be a positive number');
                }
                if (!form.cashAccountGuid) {
                    errs.push('Cash account is required');
                }
                break;

            case 'Split':
                if (!form.shares || parseFloat(form.shares) <= 0) {
                    errs.push('New shares must be a positive number');
                }
                break;
        }

        return errs;
    };

    const buildSplits = (): CreateTransactionRequest['splits'] => {
        const splits: CreateTransactionRequest['splits'] = [];

        switch (form.action) {
            case 'Buy': {
                const shares = parseFloat(form.shares);
                const total = parseFloat(form.total);
                const commission = parseFloat(form.commission) || 0;
                const totalWithCommission = total + commission;

                // Investment account: +shares, -value (cost basis as negative)
                const { num: valueNum, denom: valueDenom } = toNumDenom(total);
                splits.push({
                    account_guid: accountGuid,
                    action: 'Buy',
                    // Shares as quantity with denom 1 for whole shares, or higher for fractional
                    quantity_num: Math.round(shares * 10000),
                    quantity_denom: 10000,
                    value_num: -valueNum, // Negative because money flows out
                    value_denom: valueDenom,
                    memo: form.memo || undefined,
                });

                // Cash account: -(total + commission)
                const { num: cashNum, denom: cashDenom } = toNumDenom(totalWithCommission);
                splits.push({
                    account_guid: form.cashAccountGuid,
                    action: '',
                    quantity_num: -cashNum,
                    quantity_denom: cashDenom,
                    value_num: -cashNum,
                    value_denom: cashDenom,
                });

                // Commission expense if applicable
                if (commission > 0 && form.expenseAccountGuid) {
                    const { num: commNum, denom: commDenom } = toNumDenom(commission);
                    splits.push({
                        account_guid: form.expenseAccountGuid,
                        action: '',
                        quantity_num: commNum,
                        quantity_denom: commDenom,
                        value_num: commNum,
                        value_denom: commDenom,
                    });
                }
                break;
            }

            case 'Sell': {
                const shares = parseFloat(form.shares);
                const total = parseFloat(form.total);
                const commission = parseFloat(form.commission) || 0;
                const netProceeds = total - commission;

                // Investment account: -shares, +value (proceeds as positive)
                const { num: valueNum, denom: valueDenom } = toNumDenom(total);
                splits.push({
                    account_guid: accountGuid,
                    action: 'Sell',
                    quantity_num: -Math.round(shares * 10000), // Negative for selling
                    quantity_denom: 10000,
                    value_num: valueNum, // Positive because money flows in
                    value_denom: valueDenom,
                    memo: form.memo || undefined,
                });

                // Cash account: +(total - commission)
                const { num: cashNum, denom: cashDenom } = toNumDenom(netProceeds);
                splits.push({
                    account_guid: form.cashAccountGuid,
                    action: '',
                    quantity_num: cashNum,
                    quantity_denom: cashDenom,
                    value_num: cashNum,
                    value_denom: cashDenom,
                });

                // Commission expense if applicable
                if (commission > 0 && form.expenseAccountGuid) {
                    const { num: commNum, denom: commDenom } = toNumDenom(commission);
                    splits.push({
                        account_guid: form.expenseAccountGuid,
                        action: '',
                        quantity_num: commNum,
                        quantity_denom: commDenom,
                        value_num: commNum,
                        value_denom: commDenom,
                    });
                }
                break;
            }

            case 'Dividend': {
                const amount = parseFloat(form.amount);
                const { num: amtNum, denom: amtDenom } = toNumDenom(amount);

                // Cash account: +amount
                splits.push({
                    account_guid: form.cashAccountGuid,
                    action: '',
                    quantity_num: amtNum,
                    quantity_denom: amtDenom,
                    value_num: amtNum,
                    value_denom: amtDenom,
                });

                // Income account: -amount (credit to income)
                splits.push({
                    account_guid: form.incomeAccountGuid,
                    action: '',
                    quantity_num: -amtNum,
                    quantity_denom: amtDenom,
                    value_num: -amtNum,
                    value_denom: amtDenom,
                    memo: `Dividend: ${commoditySymbol}`,
                });
                break;
            }

            case 'ReturnOfCapital': {
                const amount = parseFloat(form.amount);
                const { num: amtNum, denom: amtDenom } = toNumDenom(amount);

                // Investment account: reduce basis (negative value, zero quantity)
                splits.push({
                    account_guid: accountGuid,
                    action: 'Return of Capital',
                    quantity_num: 0,
                    quantity_denom: 1,
                    value_num: amtNum, // Positive to reduce basis
                    value_denom: amtDenom,
                    memo: form.memo || 'Return of Capital',
                });

                // Cash account: +amount
                splits.push({
                    account_guid: form.cashAccountGuid,
                    action: '',
                    quantity_num: amtNum,
                    quantity_denom: amtDenom,
                    value_num: amtNum,
                    value_denom: amtDenom,
                });
                break;
            }

            case 'Split': {
                const newShares = parseFloat(form.shares);

                // Investment account: +shares, zero value
                splits.push({
                    account_guid: accountGuid,
                    action: 'Split',
                    quantity_num: Math.round(newShares * 10000),
                    quantity_denom: 10000,
                    value_num: 0,
                    value_denom: 100,
                    memo: form.memo || `Stock split: +${newShares} shares`,
                });

                // Need a balancing split with zero value for GnuCash
                // This is typically handled differently, but we need balanced transaction
                // For stock splits, GnuCash uses a special handling
                // We'll add a zero-value split to the same account
                splits.push({
                    account_guid: accountGuid,
                    action: '',
                    quantity_num: 0,
                    quantity_denom: 1,
                    value_num: 0,
                    value_denom: 100,
                });
                break;
            }
        }

        return splits;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrors([]);

        const validationErrors = validateForm();
        if (validationErrors.length > 0) {
            setErrors(validationErrors);
            return;
        }

        if (!currencyGuid) {
            setErrors(['Currency not loaded. Please try again.']);
            return;
        }

        const splits = buildSplits();

        // Build description
        let description = '';
        switch (form.action) {
            case 'Buy':
                description = `Buy ${form.shares} ${commoditySymbol} @ ${form.pricePerShare}`;
                break;
            case 'Sell':
                description = `Sell ${form.shares} ${commoditySymbol} @ ${form.pricePerShare}`;
                break;
            case 'Dividend':
                description = `Dividend: ${commoditySymbol}`;
                break;
            case 'ReturnOfCapital':
                description = `Return of Capital: ${commoditySymbol}`;
                break;
            case 'Split':
                description = `Stock Split: ${commoditySymbol} (+${form.shares} shares)`;
                break;
        }

        const request: CreateTransactionRequest = {
            currency_guid: currencyGuid,
            post_date: form.date,
            description,
            splits,
        };

        setSaving(true);
        try {
            const res = await fetch('/api/transactions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || err.errors?.[0]?.message || 'Failed to create transaction');
            }

            onSave();
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

    const renderAccountSelector = (
        label: string,
        accounts: Account[],
        selectedGuid: string,
        selectedName: string,
        onSelect: (account: Account) => void,
        placeholder: string
    ) => (
        <div>
            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                {label}
            </label>
            <select
                value={selectedGuid}
                onChange={(e) => {
                    const account = accounts.find(a => a.guid === e.target.value);
                    if (account) onSelect(account);
                }}
                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
            >
                <option value="">{placeholder}</option>
                {accounts.map(account => (
                    <option key={account.guid} value={account.guid}>
                        {formatAccountPath(account.fullname, account.name)}
                    </option>
                ))}
            </select>
        </div>
    );

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-border">
                <div>
                    <h3 className="text-lg font-semibold text-foreground">Investment Transaction</h3>
                    <p className="text-sm text-foreground-muted">{accountName} ({commoditySymbol})</p>
                </div>
            </div>

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

            {/* Action Selector */}
            <div>
                <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
                    Transaction Type
                </label>
                <div className="grid grid-cols-5 gap-2">
                    {ACTION_OPTIONS.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => handleChange('action', option.value)}
                            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                form.action === option.value
                                    ? 'bg-cyan-600 text-white'
                                    : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover hover:text-foreground'
                            }`}
                            title={option.description}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Date */}
            <div>
                <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                    Date
                </label>
                <input
                    type="date"
                    value={form.date}
                    onChange={(e) => handleChange('date', e.target.value)}
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                />
            </div>

            {/* Buy/Sell Fields */}
            {(form.action === 'Buy' || form.action === 'Sell') && (
                <>
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <label className={`block text-xs uppercase tracking-wider mb-1 ${
                                getCalculatedField() === 'shares'
                                    ? 'text-cyan-400'
                                    : 'text-foreground-muted'
                            }`}>
                                Shares {getCalculatedField() === 'shares' && '(auto)'}
                            </label>
                            <input
                                type="number"
                                step="any"
                                min="0"
                                value={form.shares}
                                onChange={(e) => handleNumericFieldChange('shares', e.target.value)}
                                placeholder="0"
                                className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none ${
                                    getCalculatedField() === 'shares'
                                        ? 'bg-cyan-950/30 border-cyan-800/50 text-cyan-200'
                                        : 'bg-input-bg border-border text-foreground'
                                } focus:border-cyan-500/50`}
                            />
                        </div>
                        <div>
                            <label className={`block text-xs uppercase tracking-wider mb-1 ${
                                getCalculatedField() === 'price'
                                    ? 'text-cyan-400'
                                    : 'text-foreground-muted'
                            }`}>
                                Price per Share {getCalculatedField() === 'price' && '(auto)'}
                            </label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={form.pricePerShare}
                                onChange={(e) => handleNumericFieldChange('pricePerShare', e.target.value)}
                                placeholder="0.00"
                                className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none ${
                                    getCalculatedField() === 'price'
                                        ? 'bg-cyan-950/30 border-cyan-800/50 text-cyan-200'
                                        : 'bg-input-bg border-border text-foreground'
                                } focus:border-cyan-500/50`}
                            />
                        </div>
                        <div>
                            <label className={`block text-xs uppercase tracking-wider mb-1 ${
                                getCalculatedField() === 'total'
                                    ? 'text-cyan-400'
                                    : 'text-foreground-muted'
                            }`}>
                                Total {getCalculatedField() === 'total' && '(auto)'}
                            </label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={form.total}
                                onChange={(e) => handleNumericFieldChange('total', e.target.value)}
                                placeholder="0.00"
                                className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none ${
                                    getCalculatedField() === 'total'
                                        ? 'bg-cyan-950/30 border-cyan-800/50 text-cyan-200'
                                        : 'bg-input-bg border-border text-foreground'
                                } focus:border-cyan-500/50`}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Commission/Fees (optional)
                            </label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={form.commission}
                                onChange={(e) => handleChange('commission', e.target.value)}
                                placeholder="0.00"
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                            />
                        </div>
                        {renderAccountSelector(
                            'Expense Account (for fees)',
                            expenseAccounts,
                            form.expenseAccountGuid,
                            form.expenseAccountName,
                            (a) => handleAccountSelect('expenseAccountGuid', 'expenseAccountName', a),
                            'Select expense account...'
                        )}
                    </div>

                    {renderAccountSelector(
                        'Cash Account',
                        cashAccounts,
                        form.cashAccountGuid,
                        form.cashAccountName,
                        (a) => handleAccountSelect('cashAccountGuid', 'cashAccountName', a),
                        'Select cash/bank account...'
                    )}
                </>
            )}

            {/* Dividend Fields */}
            {form.action === 'Dividend' && (
                <>
                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                            Dividend Amount
                        </label>
                        <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={form.amount}
                            onChange={(e) => handleChange('amount', e.target.value)}
                            placeholder="0.00"
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        {renderAccountSelector(
                            'Cash Account',
                            cashAccounts,
                            form.cashAccountGuid,
                            form.cashAccountName,
                            (a) => handleAccountSelect('cashAccountGuid', 'cashAccountName', a),
                            'Select cash/bank account...'
                        )}
                        {renderAccountSelector(
                            'Income Account',
                            incomeAccounts,
                            form.incomeAccountGuid,
                            form.incomeAccountName,
                            (a) => handleAccountSelect('incomeAccountGuid', 'incomeAccountName', a),
                            'Select income account...'
                        )}
                    </div>
                </>
            )}

            {/* Return of Capital Fields */}
            {form.action === 'ReturnOfCapital' && (
                <>
                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                            Amount
                        </label>
                        <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={form.amount}
                            onChange={(e) => handleChange('amount', e.target.value)}
                            placeholder="0.00"
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                        />
                    </div>

                    {renderAccountSelector(
                        'Cash Account',
                        cashAccounts,
                        form.cashAccountGuid,
                        form.cashAccountName,
                        (a) => handleAccountSelect('cashAccountGuid', 'cashAccountName', a),
                        'Select cash/bank account...'
                    )}
                </>
            )}

            {/* Stock Split Fields */}
            {form.action === 'Split' && (
                <>
                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                            New Shares to Add
                        </label>
                        <input
                            type="number"
                            step="any"
                            min="0"
                            value={form.shares}
                            onChange={(e) => handleChange('shares', e.target.value)}
                            placeholder="0"
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                        />
                        <p className="text-xs text-foreground-muted mt-1">
                            Enter the number of additional shares you receive from the split.
                            For example, in a 2-for-1 split where you had 100 shares, enter 100 (you receive 100 new shares).
                        </p>
                    </div>

                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                            Split Ratio (informational)
                        </label>
                        <input
                            type="text"
                            value={form.splitRatio}
                            onChange={(e) => handleChange('splitRatio', e.target.value)}
                            placeholder="e.g., 2-for-1"
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                        />
                    </div>
                </>
            )}

            {/* Memo (always shown) */}
            <div>
                <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                    Memo (optional)
                </label>
                <input
                    type="text"
                    value={form.memo}
                    onChange={(e) => handleChange('memo', e.target.value)}
                    placeholder="Additional notes..."
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50"
                />
            </div>

            {/* Summary for Buy/Sell */}
            {(form.action === 'Buy' || form.action === 'Sell') && calculatedTotal > 0 && (
                <div className="bg-surface/50 border border-border rounded-lg p-4">
                    <div className="text-xs text-foreground-muted uppercase tracking-wider mb-2">Summary</div>
                    <div className="space-y-1 text-sm">
                        <div className="flex justify-between">
                            <span className="text-foreground-secondary">
                                {form.action === 'Buy' ? 'Cost' : 'Proceeds'}:
                            </span>
                            <span className="font-mono text-foreground">${calculatedTotal.toFixed(2)}</span>
                        </div>
                        {parseFloat(form.commission) > 0 && (
                            <div className="flex justify-between">
                                <span className="text-foreground-secondary">Commission:</span>
                                <span className="font-mono text-foreground">${parseFloat(form.commission).toFixed(2)}</span>
                            </div>
                        )}
                        <div className="flex justify-between pt-1 border-t border-border-hover">
                            <span className="text-foreground-secondary font-medium">
                                {form.action === 'Buy' ? 'Total Cash Out' : 'Net Cash In'}:
                            </span>
                            <span className="font-mono text-foreground font-medium">
                                ${(form.action === 'Buy'
                                    ? calculatedTotal + (parseFloat(form.commission) || 0)
                                    : calculatedTotal - (parseFloat(form.commission) || 0)
                                ).toFixed(2)}
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4 border-t border-border">
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={saving}
                    className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={saving || loadingAccounts}
                    className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-lg transition-colors flex items-center gap-2"
                >
                    {saving ? (
                        <>
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Saving...
                        </>
                    ) : (
                        `Record ${form.action === 'ReturnOfCapital' ? 'Return of Capital' : form.action}`
                    )}
                </button>
            </div>
        </form>
    );
}
