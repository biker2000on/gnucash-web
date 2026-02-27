'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { SplitFormData, TransactionFormData, CreateTransactionRequest, Transaction, Account } from '@/lib/types';
import { SplitRow } from './SplitRow';
import { toNumDenom } from '@/lib/validation';
import { AccountSelector } from './ui/AccountSelector';
import { DescriptionAutocomplete } from './ui/DescriptionAutocomplete';
import { TransactionSuggestion } from '@/app/api/transactions/descriptions/route';
import { useFormKeyboardShortcuts } from '@/lib/hooks/useFormKeyboardShortcuts';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { useToast } from '@/contexts/ToastContext';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { evaluateMathExpression, containsMathExpression } from '@/lib/math-eval';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';

interface TransactionFormProps {
    transaction?: Transaction | null;
    onSave: (data: CreateTransactionRequest) => Promise<void>;
    onCancel: () => void;
    defaultCurrencyGuid?: string;
    simpleMode?: boolean;
    defaultFromAccount?: string;
    defaultToAccount?: string;
    onSaveAndAnother?: (data: CreateTransactionRequest) => Promise<void>;
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
    onSaveAndAnother,
}: TransactionFormProps) {
    const [formData, setFormData] = useState<TransactionFormData>({
        post_date: new Date().toISOString().split('T')[0],
        description: '',
        num: '',
        currency_guid: defaultCurrencyGuid || '',
        splits: [createEmptySplit(), createEmptySplit()],
    });
    const [errors, setErrors] = useState<string[]>([]);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [isSimpleMode, setIsSimpleMode] = useState(simpleMode);
    const [simpleData, setSimpleData] = useState({
        amount: '',
        fromAccountGuid: defaultFromAccount,
        toAccountGuid: defaultToAccount,
    });
    const dateFormat = 'MM/DD/YYYY';
    const [dateDisplay, setDateDisplay] = useState(() => formatDateForDisplay(new Date().toISOString().split('T')[0], dateFormat));
    const formRef = useRef<HTMLDivElement>(null);
    const dateInputRef = useRef<HTMLInputElement>(null);
    const { success } = useToast();
    const { defaultTaxRate } = useUserPreferences();

    // Fetch accounts for commodity info (used for multi-currency detection)
    const { data: accounts = [] } = useAccounts({ flat: true });
    const accountMap = useMemo(() => {
        const map = new Map<string, Account>();
        for (const acc of accounts as Account[]) {
            map.set(acc.guid, acc);
        }
        return map;
    }, [accounts]);

    // Detect multi-currency transaction
    const isMultiCurrency = useMemo(() => {
        const commodities = new Set<string>();

        if (isSimpleMode) {
            // Simple mode: check from and to accounts
            if (simpleData.fromAccountGuid) {
                const fromAccount = accountMap.get(simpleData.fromAccountGuid);
                if (fromAccount?.commodity_guid) commodities.add(fromAccount.commodity_guid);
            }
            if (simpleData.toAccountGuid) {
                const toAccount = accountMap.get(simpleData.toAccountGuid);
                if (toAccount?.commodity_guid) commodities.add(toAccount.commodity_guid);
            }
        } else {
            // Advanced mode: check all splits with accounts selected
            for (const split of formData.splits) {
                if (split.account_guid) {
                    const account = accountMap.get(split.account_guid);
                    if (account?.commodity_guid) commodities.add(account.commodity_guid);
                }
            }
        }

        return commodities.size > 1;
    }, [isSimpleMode, simpleData.fromAccountGuid, simpleData.toAccountGuid, formData.splits, accountMap]);

    // Get currency mnemonics for the multi-currency info message
    const multiCurrencyInfo = useMemo(() => {
        if (!isMultiCurrency) return null;

        const currencies = new Map<string, string>(); // guid -> mnemonic

        if (isSimpleMode) {
            if (simpleData.fromAccountGuid) {
                const acc = accountMap.get(simpleData.fromAccountGuid);
                if (acc?.commodity_guid && acc.commodity_mnemonic) {
                    currencies.set(acc.commodity_guid, acc.commodity_mnemonic);
                }
            }
            if (simpleData.toAccountGuid) {
                const acc = accountMap.get(simpleData.toAccountGuid);
                if (acc?.commodity_guid && acc.commodity_mnemonic) {
                    currencies.set(acc.commodity_guid, acc.commodity_mnemonic);
                }
            }
        } else {
            for (const split of formData.splits) {
                if (split.account_guid) {
                    const acc = accountMap.get(split.account_guid);
                    if (acc?.commodity_guid && acc.commodity_mnemonic) {
                        currencies.set(acc.commodity_guid, acc.commodity_mnemonic);
                    }
                }
            }
        }

        return Array.from(currencies.values());
    }, [isMultiCurrency, isSimpleMode, simpleData.fromAccountGuid, simpleData.toAccountGuid, formData.splits, accountMap]);

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

            const postDate = transaction.post_date.toString().split('T')[0];
            setFormData({
                post_date: postDate,
                description: transaction.description,
                num: transaction.num || '',
                currency_guid: transaction.currency_guid,
                splits,
            });
            setDateDisplay(formatDateForDisplay(postDate, dateFormat));

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

    // Auto-focus date field on mount
    useEffect(() => {
        const timer = setTimeout(() => {
            dateInputRef.current?.focus();
        }, 50);
        return () => clearTimeout(timer);
    }, []);

    const handleDescriptionSelect = (suggestion: TransactionSuggestion) => {
        // In simple mode, try to auto-fill accounts if there are exactly 2 splits
        if (isSimpleMode && suggestion.splits.length === 2) {
            const [split1, split2] = suggestion.splits;

            // Determine which is debit and which is credit based on amount sign
            const debitSplit = split1.amount > 0 ? split1 : split2;
            const creditSplit = split1.amount < 0 ? split1 : split2;

            setSimpleData({
                amount: Math.abs(debitSplit.amount).toFixed(2),
                fromAccountGuid: creditSplit.accountGuid,
                toAccountGuid: debitSplit.accountGuid,
            });

            success(`Auto-filled: ${Math.abs(debitSplit.amount).toFixed(2)} from ${creditSplit.accountName} to ${debitSplit.accountName}`);
        }
    };

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

    const handleAmountBlur = () => {
        const result = evaluateMathExpression(simpleData.amount);
        if (result !== null) {
            setSimpleData(prev => ({ ...prev, amount: result.toFixed(2) }));
        }
    };

    const applyTax = () => {
        if (defaultTaxRate <= 0) {
            success('No tax rate configured. Set it in Settings.');
            return;
        }

        // Evaluate any math expression first
        let currentValue: number;
        const evaluated = evaluateMathExpression(simpleData.amount);
        if (evaluated !== null) {
            currentValue = evaluated;
        } else {
            currentValue = parseFloat(simpleData.amount);
        }

        if (isNaN(currentValue) || currentValue === 0) return;

        const withTax = Math.round(currentValue * (1 + defaultTaxRate) * 100) / 100;
        setSimpleData(prev => ({ ...prev, amount: withTax.toFixed(2) }));
        success(`Tax applied: ${currentValue.toFixed(2)} + ${(defaultTaxRate * 100).toFixed(1)}% = ${withTax.toFixed(2)}`);
    };

    const handleAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 't' || e.key === 'T') {
            // Don't intercept if modifier keys are held (let browser handle Ctrl+T etc.)
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            applyTax();
        }
    };

    const validateForm = (): { valid: boolean; errors: string[]; fieldErrors: Record<string, string> } => {
        const errors: string[] = [];
        const fieldErrors: Record<string, string> = {};

        // Common validation
        if (!formData.description?.trim()) {
            errors.push('Description is required');
            fieldErrors.description = 'Required';
        }
        if (!formData.post_date) {
            errors.push('Post date is required');
            fieldErrors.post_date = 'Required';
        }

        if (isSimpleMode) {
            // Simple mode validation
            if (!simpleData.amount || parseFloat(simpleData.amount) <= 0) {
                errors.push('Amount must be greater than zero');
                fieldErrors.amount = 'Must be > 0';
            }
            if (!simpleData.fromAccountGuid) {
                errors.push('From account is required');
                fieldErrors.fromAccount = 'Required';
            }
            if (!simpleData.toAccountGuid) {
                errors.push('To account is required');
                fieldErrors.toAccount = 'Required';
            }
            if (simpleData.fromAccountGuid === simpleData.toAccountGuid) {
                errors.push('From and To accounts must be different');
                fieldErrors.fromAccount = 'Must differ';
                fieldErrors.toAccount = 'Must differ';
            }
        } else {
            // Advanced mode validation
            if (formData.splits.filter(s => s.account_guid).length < 2) {
                errors.push('At least 2 accounts must be selected');
                fieldErrors.splits = 'Need 2+ accounts';
            }

            const { difference } = calculateBalance();
            if (Math.abs(difference) > 0.01) {
                errors.push(`Transaction is unbalanced by ${difference.toFixed(2)}. Debits must equal credits.`);
                fieldErrors.splits = 'Unbalanced';
            }
        }

        return { valid: errors.length === 0, errors, fieldErrors };
    };

    const buildApiData = (): CreateTransactionRequest | null => {
        // Prepare splits - either from simple mode or advanced mode
        let submissionSplits: SplitFormData[];

        if (isSimpleMode) {
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
            submissionSplits = formData.splits;
        }

        // Convert form data to API format
        return {
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
    };

    const resetForm = () => {
        // Keep the current date but clear everything else
        setFormData(prev => ({
            ...prev,
            description: '',
            num: '',
            splits: [createEmptySplit(), createEmptySplit()],
        }));
        setSimpleData({
            amount: '',
            fromAccountGuid: defaultFromAccount,
            toAccountGuid: defaultToAccount,
        });
        setErrors([]);
        setFieldErrors({});
    };

    const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            const current = new Date(formData.post_date + 'T12:00:00');
            current.setDate(current.getDate() + 1);
            const newDate = current.toISOString().split('T')[0];
            setFormData(f => ({ ...f, post_date: newDate }));
            setDateDisplay(formatDateForDisplay(newDate, dateFormat));
        } else if (e.key === '-') {
            e.preventDefault();
            const current = new Date(formData.post_date + 'T12:00:00');
            current.setDate(current.getDate() - 1);
            const newDate = current.toISOString().split('T')[0];
            setFormData(f => ({ ...f, post_date: newDate }));
            setDateDisplay(formatDateForDisplay(newDate, dateFormat));
        } else if (e.key === 't' || e.key === 'T') {
            e.preventDefault();
            const newDate = new Date().toISOString().split('T')[0];
            setFormData(f => ({ ...f, post_date: newDate }));
            setDateDisplay(formatDateForDisplay(newDate, dateFormat));
        }
    };

    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();

        const validation = validateForm();
        setErrors(validation.errors);
        setFieldErrors(validation.fieldErrors);

        if (!validation.valid) {
            // Focus first invalid field
            const firstErrorField = Object.keys(validation.fieldErrors)[0];
            if (firstErrorField) {
                const element = document.querySelector(`[data-field="${firstErrorField}"]`) as HTMLElement;
                element?.focus();
            }
            return;
        }

        const apiData = buildApiData();
        if (!apiData) return;

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

    const handleSaveAndAnother = async () => {
        const validation = validateForm();
        setErrors(validation.errors);
        setFieldErrors(validation.fieldErrors);

        if (!validation.valid) {
            // Focus first invalid field
            const firstErrorField = Object.keys(validation.fieldErrors)[0];
            if (firstErrorField) {
                const element = document.querySelector(`[data-field="${firstErrorField}"]`) as HTMLElement;
                element?.focus();
            }
            return;
        }

        const apiData = buildApiData();
        if (!apiData || !onSaveAndAnother) return;

        setSaving(true);
        try {
            await onSaveAndAnother(apiData);
            resetForm();
            success('Transaction saved. Ready for next.');
            // Focus date field for the next transaction
            setTimeout(() => dateInputRef.current?.focus(), 0);
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

    // Setup keyboard shortcut (Ctrl+Enter for save)
    useFormKeyboardShortcuts(formRef, () => handleSubmit(), {
        validate: () => validateForm().valid
    });

    // Setup Ctrl+Shift+Enter for save and another
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
                e.preventDefault();
                if (onSaveAndAnother) {
                    handleSaveAndAnother();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onSaveAndAnother, handleSaveAndAnother]);

    // Register date field shortcuts for help modal
    useKeyboardShortcut('date-plus', '+', 'Next day', () => {}, 'date-field');
    useKeyboardShortcut('date-minus', '-', 'Previous day', () => {}, 'date-field');
    useKeyboardShortcut('date-today', 't', 'Set to today', () => {}, 'date-field');

    // Register tax shortcut for help modal
    useKeyboardShortcut('tax-apply', 't', 'Apply tax rate', () => {}, 'amount-field');

    return (
        <div ref={formRef}>
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

            {/* Multi-Currency Info Banner */}
            {isMultiCurrency && multiCurrencyInfo && (
                <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-sm text-blue-400">
                    <div className="flex items-start gap-2">
                        <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <div>
                            <span className="font-medium">Multi-currency transaction detected</span>
                            <span className="text-blue-400/80"> ({multiCurrencyInfo.join(' / ')})</span>
                            <p className="text-blue-400/70 mt-1">
                                Trading splits will be automatically generated to balance this transaction across currencies.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Header Fields */}
            <div className="grid grid-cols-3 gap-4">
                <div>
                    <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                        Date
                    </label>
                    <input
                        ref={dateInputRef}
                        type="text"
                        value={dateDisplay}
                        onChange={(e) => setDateDisplay(e.target.value)}
                        onFocus={() => dateInputRef.current?.select()}
                        onBlur={() => {
                            const parsed = parseDateInput(dateDisplay);
                            if (parsed) {
                                setFormData(f => ({ ...f, post_date: parsed }));
                                setDateDisplay(formatDateForDisplay(parsed, dateFormat));
                            } else {
                                setDateDisplay(formatDateForDisplay(formData.post_date, dateFormat));
                            }
                        }}
                        onKeyDown={handleDateKeyDown}
                        data-field="post_date"
                        placeholder="MM/DD/YYYY"
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                    />
                </div>
                <div className="col-span-2">
                    <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                        Description
                    </label>
                    <DescriptionAutocomplete
                        value={formData.description}
                        onChange={(value) => setFormData(f => ({ ...f, description: value }))}
                        onSelectSuggestion={handleDescriptionSelect}
                        accountGuid={simpleData.fromAccountGuid || undefined}
                        placeholder="Enter description..."
                        hasError={!!fieldErrors.description}
                    />
                </div>
            </div>

            <div>
                <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                    Number/Reference
                </label>
                <input
                    type="text"
                    value={formData.num}
                    onChange={(e) => setFormData(f => ({ ...f, num: e.target.value }))}
                    placeholder="Check #, reference, etc."
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50"
                />
            </div>

            {/* Mode Toggle and Content */}
            {isSimpleMode ? (
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <label className="text-xs text-foreground-muted uppercase tracking-wider">
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
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                            Amount
                        </label>
                        <div className="flex gap-1.5 items-center">
                            <div className="relative flex-1">
                                <input
                                    type="text"
                                    inputMode="decimal"
                                    value={simpleData.amount}
                                    onChange={(e) => setSimpleData(prev => ({ ...prev, amount: e.target.value }))}
                                    onBlur={handleAmountBlur}
                                    onKeyDown={handleAmountKeyDown}
                                    placeholder="0.00"
                                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50"
                                />
                                {containsMathExpression(simpleData.amount) && (
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-cyan-400 pointer-events-none">=</span>
                                )}
                            </div>
                            {defaultTaxRate > 0 && (
                                <button
                                    type="button"
                                    onClick={applyTax}
                                    className="p-2 rounded-lg bg-input-bg border border-border text-foreground-muted hover:text-foreground hover:border-border-hover transition-colors"
                                    title={`Apply tax (${(defaultTaxRate * 100).toFixed(1)}%)`}
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                                        <path strokeLinecap="round" d="M19 5L5 19M6.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM17.5 20a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                                    </svg>
                                </button>
                            )}
                        </div>
                    </div>

                    {/* From/To accounts */}
                    <div className="flex items-center gap-4">
                        <div className="flex-1">
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                From Account
                            </label>
                            <AccountSelector
                                value={simpleData.fromAccountGuid}
                                onChange={(guid) => setSimpleData(prev => ({ ...prev, fromAccountGuid: guid }))}
                                placeholder="Select source account..."
                            />
                        </div>
                        <div className="flex items-center justify-center pt-5">
                            <svg className="w-6 h-6 text-foreground-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                            </svg>
                        </div>
                        <div className="flex-1">
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
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
                        <label className="text-xs text-foreground-muted uppercase tracking-wider">
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
                                className="text-xs bg-background-tertiary hover:bg-background-tertiary text-foreground px-3 py-1 rounded-lg transition-colors"
                            >
                                + Add Split
                            </button>
                        </div>
                    </div>

                    {/* Column Headers */}
                    <div className="grid grid-cols-12 gap-2 text-xs text-foreground-muted uppercase tracking-wider py-2 border-b border-border-hover">
                        <div className="col-span-5">Account</div>
                        <div className="col-span-2 text-right">Debit</div>
                        <div className="col-span-2 text-right">Credit</div>
                        <div className="col-span-2">Memo</div>
                        <div className="col-span-1"></div>
                    </div>

                    {/* Split Rows */}
                    <div className="bg-background/30 rounded-lg">
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
                    <div className="grid grid-cols-12 gap-2 text-sm font-mono py-3 border-t border-border-hover mt-2">
                        <div className="col-span-5 text-foreground-secondary text-right pr-2">Totals:</div>
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
            <div className="flex justify-between items-center pt-4 border-t border-border">
                <span className="text-xs text-foreground-muted">
                    <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Ctrl</kbd> + <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Enter</kbd> save
                    {onSaveAndAnother && (
                        <> | <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Ctrl+Shift</kbd> + <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Enter</kbd> save & new</>
                    )}
                </span>
                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                    {onSaveAndAnother && (
                        <button
                            type="button"
                            onClick={handleSaveAndAnother}
                            disabled={saving}
                            className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white rounded-lg transition-colors"
                        >
                            Save & New
                        </button>
                    )}
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
            </div>
        </form>
        </div>
    );
}
