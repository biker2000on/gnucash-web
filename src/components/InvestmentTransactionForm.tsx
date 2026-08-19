'use client';

import { useState, useEffect, useMemo } from 'react';
import { CreateTransactionRequest } from '@/lib/types';
import { toNumDenom } from '@/lib/validation';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useDateShortcuts } from '@/lib/hooks/useDateShortcuts';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { toLocalDateString } from '@/lib/datePresets';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { FieldGrid } from '@/components/ui/form';
import { ErrorLiveRegion } from '@/components/a11y/LiveRegion';
import { extractErrorMessage } from '@/lib/api-error';

export type InvestmentAction = 'Buy' | 'Sell' | 'Dividend' | 'ReturnOfCapital' | 'Split';

export interface InvestmentSplitInput {
    action: InvestmentAction;
    accountGuid: string;
    commodityFraction: number;
    shares: number;
    total: number;
    amount: number;
    commission: number;
    cashAccountGuid: string;
    incomeAccountGuid: string;
    expenseAccountGuid: string;
    memo: string;
    commoditySymbol: string;
}

interface InvestmentTransactionFormProps {
    accountGuid: string;
    accountName: string;
    accountCommodityGuid: string;
    commoditySymbol: string;
    commodityFraction?: number;
    currentShares?: number;
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
    date: toLocalDateString(new Date()),
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

/**
 * Build GnuCash-compatible investment splits.
 *
 * Value signs follow double-entry accounting independently from quantity:
 * buying increases the security asset and decreases cash; selling decreases
 * the security asset and increases cash.
 */
export function buildInvestmentSplits(input: InvestmentSplitInput): CreateTransactionRequest['splits'] {
    const {
        action,
        accountGuid,
        commodityFraction,
        shares,
        total,
        amount,
        commission,
        cashAccountGuid,
        incomeAccountGuid,
        expenseAccountGuid,
        memo,
        commoditySymbol,
    } = input;
    const splits: CreateTransactionRequest['splits'] = [];

    switch (action) {
        case 'Buy': {
            const totalWithCommission = total + commission;
            const { num: valueNum, denom: valueDenom } = toNumDenom(total);
            splits.push({
                account_guid: accountGuid,
                action: 'Buy',
                quantity_num: Math.round(shares * commodityFraction),
                quantity_denom: commodityFraction,
                value_num: valueNum,
                value_denom: valueDenom,
                memo: memo || undefined,
            });

            const { num: cashNum, denom: cashDenom } = toNumDenom(totalWithCommission);
            splits.push({
                account_guid: cashAccountGuid,
                action: '',
                quantity_num: -cashNum,
                quantity_denom: cashDenom,
                value_num: -cashNum,
                value_denom: cashDenom,
            });

            if (commission > 0 && expenseAccountGuid) {
                const { num: commNum, denom: commDenom } = toNumDenom(commission);
                splits.push({
                    account_guid: expenseAccountGuid,
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
            const netProceeds = total - commission;
            const { num: valueNum, denom: valueDenom } = toNumDenom(total);
            splits.push({
                account_guid: accountGuid,
                action: 'Sell',
                quantity_num: -Math.round(shares * commodityFraction),
                quantity_denom: commodityFraction,
                value_num: -valueNum,
                value_denom: valueDenom,
                memo: memo || undefined,
            });

            const { num: cashNum, denom: cashDenom } = toNumDenom(netProceeds);
            splits.push({
                account_guid: cashAccountGuid,
                action: '',
                quantity_num: cashNum,
                quantity_denom: cashDenom,
                value_num: cashNum,
                value_denom: cashDenom,
            });

            if (commission > 0 && expenseAccountGuid) {
                const { num: commNum, denom: commDenom } = toNumDenom(commission);
                splits.push({
                    account_guid: expenseAccountGuid,
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
            const { num: amtNum, denom: amtDenom } = toNumDenom(amount);
            splits.push({
                account_guid: cashAccountGuid,
                action: '',
                quantity_num: amtNum,
                quantity_denom: amtDenom,
                value_num: amtNum,
                value_denom: amtDenom,
            });
            splits.push({
                account_guid: incomeAccountGuid,
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
            const { num: amtNum, denom: amtDenom } = toNumDenom(amount);
            splits.push({
                account_guid: accountGuid,
                action: 'Return of Capital',
                quantity_num: 0,
                quantity_denom: 1,
                value_num: -amtNum,
                value_denom: amtDenom,
                memo: memo || 'Return of Capital',
            });
            splits.push({
                account_guid: cashAccountGuid,
                action: '',
                quantity_num: amtNum,
                quantity_denom: amtDenom,
                value_num: amtNum,
                value_denom: amtDenom,
            });
            break;
        }

        case 'Split': {
            splits.push({
                account_guid: accountGuid,
                action: 'Split',
                quantity_num: Math.round(shares * commodityFraction),
                quantity_denom: commodityFraction,
                value_num: 0,
                value_denom: 100,
                memo: memo || `Stock split: +${shares} shares`,
            });
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
}

export function InvestmentTransactionForm({
    accountGuid,
    accountName,
    commoditySymbol,
    commodityFraction = 10000,
    currentShares = 0,
    onSave,
    onCancel,
}: InvestmentTransactionFormProps) {
    const sharePrecision = commodityFraction > 0
        ? Math.max(0, Math.round(Math.log10(commodityFraction)))
        : 4;
    const { dateFormat } = useUserPreferences();
    const [form, setForm] = useState<FormState>(INITIAL_FORM_STATE);
    const [dateDisplay, setDateDisplay] = useState(() => formatDateForDisplay(INITIAL_FORM_STATE.date, dateFormat));
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
            const decimals = targetField === 'shares' ? sharePrecision : 2;
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

    const { handleDateKeyDown } = useDateShortcuts(form.date, (newDate) => {
        handleChange('date', newDate);
        setDateDisplay(formatDateForDisplay(newDate, dateFormat));
    });

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
        accountGuid: string,
        accountName: string,
    ) => {
        setForm(prev => ({
            ...prev,
            [field]: accountGuid,
            [nameField]: accountName,
        }));
    };

    const validateForm = (): string[] => {
        const errs: string[] = [];

        if (!form.date) errs.push('Date is required');

        switch (form.action) {
            case 'Buy':
            case 'Sell': {
                const shares = parseFloat(form.shares);
                if (!form.shares || shares <= 0) {
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
                if ((parseFloat(form.commission) || 0) > 0 && !form.expenseAccountGuid) {
                    errs.push('An expense account is required when commission or fees are entered');
                }
                if (
                    form.action === 'Sell'
                    && shares > Math.max(0, currentShares) + (0.5 / commodityFraction)
                ) {
                    errs.push(
                        `Cannot sell ${shares.toFixed(sharePrecision)} shares; `
                        + `${Math.max(0, currentShares).toFixed(sharePrecision)} are available`,
                    );
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

    const buildSplits = (): CreateTransactionRequest['splits'] => buildInvestmentSplits({
        action: form.action,
        accountGuid,
        commodityFraction,
        shares: parseFloat(form.shares) || 0,
        total: parseFloat(form.total) || 0,
        amount: parseFloat(form.amount) || 0,
        commission: parseFloat(form.commission) || 0,
        cashAccountGuid: form.cashAccountGuid,
        incomeAccountGuid: form.incomeAccountGuid,
        expenseAccountGuid: form.expenseAccountGuid,
        memo: form.memo,
        commoditySymbol,
    });

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
                throw new Error(extractErrorMessage(err, 'Failed to create transaction'));
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

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-border">
                <div>
                    <h3 className="text-lg font-semibold text-foreground">Investment Transaction</h3>
                    <p className="text-sm text-foreground-muted">{accountName} ({commoditySymbol})</p>
                </div>
                <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wider text-foreground-muted">Current position</p>
                    <p className={`font-mono text-sm tabular-nums ${currentShares < 0 ? 'text-negative' : 'text-foreground'}`}>
                        {currentShares.toFixed(sharePrecision)} shares
                    </p>
                </div>
            </div>

            {currentShares < -(0.5 / commodityFraction) && (
                <div className="border border-negative/30 bg-negative/10 rounded-lg p-3 text-sm text-negative">
                    This account has a negative share position. Record a correcting Buy or revise the
                    overselling transaction before entering another Sell.
                </div>
            )}

            {/* Error Messages */}
            <ErrorLiveRegion message={errors.join('. ')} />
            {errors.length > 0 && (
                <div className="bg-negative/10 border border-negative/30 rounded-lg p-4">
                    <ul className="list-disc list-inside text-sm text-negative space-y-1">
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
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {ACTION_OPTIONS.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => handleChange('action', option.value)}
                            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                form.action === option.value
                                    ? 'bg-primary text-primary-foreground'
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
                    type="text"
                    value={dateDisplay}
                    onChange={(e) => setDateDisplay(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={handleDateKeyDown}
                    onBlur={() => {
                        const parsed = parseDateInput(dateDisplay);
                        if (parsed) {
                            handleChange('date', parsed);
                            setDateDisplay(formatDateForDisplay(parsed, dateFormat));
                        } else {
                            setDateDisplay(formatDateForDisplay(form.date, dateFormat));
                        }
                    }}
                    placeholder="MM/DD/YYYY"
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                />
            </div>

            {/* Buy/Sell Fields */}
            {(form.action === 'Buy' || form.action === 'Sell') && (
                <>
                    <FieldGrid>
                        <div>
                            <label className={`block text-xs uppercase tracking-wider mb-1 ${
                                getCalculatedField() === 'shares'
                                    ? 'text-primary'
                                    : 'text-foreground-muted'
                            }`}>
                                Shares {getCalculatedField() === 'shares' && '(auto)'}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="number"
                                    step={1 / commodityFraction}
                                    min="0"
                                    value={form.shares}
                                    onChange={(e) => handleNumericFieldChange('shares', e.target.value)}
                                    placeholder="0"
                                    className={`min-w-0 flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none ${
                                        getCalculatedField() === 'shares'
                                            ? 'bg-primary/10 border-primary/30 text-primary'
                                            : 'bg-input-bg border-border text-foreground'
                                    } focus:border-primary/50`}
                                />
                                {form.action === 'Sell' && currentShares > (0.5 / commodityFraction) && (
                                    <button
                                        type="button"
                                        onClick={() => handleNumericFieldChange(
                                            'shares',
                                            currentShares.toFixed(sharePrecision),
                                        )}
                                        className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs text-foreground-secondary hover:border-border-hover hover:text-foreground transition-colors"
                                        title={`Sell all ${currentShares.toFixed(sharePrecision)} shares`}
                                    >
                                        Sell all
                                    </button>
                                )}
                            </div>
                        </div>
                        <div>
                            <label className={`block text-xs uppercase tracking-wider mb-1 ${
                                getCalculatedField() === 'price'
                                    ? 'text-primary'
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
                                        ? 'bg-primary/10 border-primary/30 text-primary'
                                        : 'bg-input-bg border-border text-foreground'
                                } focus:border-primary/50`}
                            />
                        </div>
                        <div>
                            <label className={`block text-xs uppercase tracking-wider mb-1 ${
                                getCalculatedField() === 'total'
                                    ? 'text-primary'
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
                                        ? 'bg-primary/10 border-primary/30 text-primary'
                                        : 'bg-input-bg border-border text-foreground'
                                } focus:border-primary/50`}
                            />
                        </div>
                    </FieldGrid>

                    <FieldGrid cols={2}>
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
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Expense Account (for fees)
                            </label>
                            <AccountSelector
                                value={form.expenseAccountGuid}
                                onChange={(guid, name) => handleAccountSelect('expenseAccountGuid', 'expenseAccountName', guid, name)}
                                placeholder="Select expense account..."
                                accountTypes={['EXPENSE']}
                            />
                        </div>
                    </FieldGrid>

                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                            Cash Account
                        </label>
                        <AccountSelector
                            value={form.cashAccountGuid}
                            onChange={(guid, name) => handleAccountSelect('cashAccountGuid', 'cashAccountName', guid, name)}
                            placeholder="Select cash/bank account..."
                            accountTypes={['BANK', 'ASSET', 'CASH']}
                        />
                    </div>
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
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>

                    <FieldGrid cols={2}>
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Cash Account
                            </label>
                            <AccountSelector
                                value={form.cashAccountGuid}
                                onChange={(guid, name) => handleAccountSelect('cashAccountGuid', 'cashAccountName', guid, name)}
                                placeholder="Select cash/bank account..."
                                accountTypes={['BANK', 'ASSET', 'CASH']}
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Income Account
                            </label>
                            <AccountSelector
                                value={form.incomeAccountGuid}
                                onChange={(guid, name) => handleAccountSelect('incomeAccountGuid', 'incomeAccountName', guid, name)}
                                placeholder="Select income account..."
                                accountTypes={['INCOME']}
                            />
                        </div>
                    </FieldGrid>
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
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>

                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                            Cash Account
                        </label>
                        <AccountSelector
                            value={form.cashAccountGuid}
                            onChange={(guid, name) => handleAccountSelect('cashAccountGuid', 'cashAccountName', guid, name)}
                            placeholder="Select cash/bank account..."
                            accountTypes={['BANK', 'ASSET', 'CASH']}
                        />
                    </div>
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
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
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
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
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
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50"
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
                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
                >
                    {saving ? (
                        <>
                            <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
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
