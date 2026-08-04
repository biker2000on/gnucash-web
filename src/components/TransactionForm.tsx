'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { SplitFormData, TransactionFormData, CreateTransactionRequest, Transaction, Account } from '@/lib/types';
import { SplitRow } from './SplitRow';
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
import { toLocalDateString } from '@/lib/datePresets';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import {
    buildCurrencySplitAmounts,
    deriveRecordedExchangeRate,
    editableDecimalMagnitude,
    parseExchangeRate,
} from '@/lib/transaction-currency';

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

/**
 * Build the two splits for a simple-mode (from -> to) entry.
 *
 * Memo placement matches GnuCash desktop's Transfer dialog
 * (gnc-xfer-dialog.c), which writes the SAME memo onto BOTH splits of a
 * simple two-split entry so it stays visible from either account's register.
 * `memo === null` means "the user did not touch the memo field": each side
 * then keeps its own stored memo, so differing per-split memos on an edited
 * transaction are preserved rather than flattened.
 *
 * When editing an existing 2-split transaction, each side reuses the loaded
 * split for the same account, so the split guid survives (the PUT handler
 * keys action/lot/reconcile_date off it). Reconcile state follows the ledger
 * inline-save rule: a split keeps its stored reconcile state only while its
 * own amount and account are untouched.
 */
export function buildSimpleModeSplits(
    simple: { amount: string; fromAccountGuid: string; toAccountGuid: string; memo: string | null },
    priorSplits: SplitFormData[],
): SplitFormData[] {
    const amount = parseFloat(simple.amount) || 0;
    const claimed = new Set<string>();
    const makeSide = (accountGuid: string, side: 'from' | 'to'): SplitFormData => {
        const prior = priorSplits.find(s => s.account_guid === accountGuid && !claimed.has(s.id));
        if (prior) claimed.add(prior.id);
        const debit = side === 'to' ? amount.toFixed(2) : '';
        const credit = side === 'from' ? amount.toFixed(2) : '';
        const amountUnchanged = Boolean(prior)
            && Math.abs((parseFloat(prior!.debit) || 0) - (parseFloat(debit) || 0)) < 0.005
            && Math.abs((parseFloat(prior!.credit) || 0) - (parseFloat(credit) || 0)) < 0.005;
        return {
            id: prior ? prior.id : crypto.randomUUID(),
            account_guid: accountGuid,
            account_name: prior?.account_name ?? '',
            debit,
            credit,
            memo: simple.memo === null ? (prior?.memo ?? '') : simple.memo,
            reconcile_state: amountUnchanged ? prior!.reconcile_state : 'n',
            ...(prior?.exchange_rate !== undefined ? { exchange_rate: prior.exchange_rate } : {}),
        };
    };
    return [
        makeSide(simple.fromAccountGuid, 'from'),
        makeSide(simple.toAccountGuid, 'to'),
    ];
}

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
        post_date: toLocalDateString(new Date()),
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
        memo: '',
    });
    // The memo value simple mode was seeded with. While the field still holds
    // this value the user hasn't touched it, and buildSimpleModeSplits keeps
    // each split's own stored memo instead of overwriting both.
    const initialSimpleMemoRef = useRef('');
    const formRef = useRef<HTMLDivElement>(null);
    const dateInputRef = useRef<HTMLInputElement>(null);
    const saveAndAnotherRef = useRef<(() => Promise<void>) | null>(null);
    const { success } = useToast();
    const { defaultTaxRate, dateFormat } = useUserPreferences();
    const isMobile = useIsMobile();
    const [dateDisplay, setDateDisplay] = useState(() => formatDateForDisplay(toLocalDateString(new Date()), dateFormat));

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
                const quantityDecimal = split.quantity_decimal || '0';
                const quantity = parseFloat(quantityDecimal);
                const magnitude = editableDecimalMagnitude(quantityDecimal);
                return {
                    id: split.guid,
                    account_guid: split.account_guid,
                    account_name: split.account_name || '',
                    debit: quantity > 0 ? magnitude : '',
                    credit: quantity < 0 ? magnitude : '',
                    memo: split.memo || '',
                    reconcile_state: split.reconcile_state as 'n' | 'c' | 'y' || 'n',
                    exchange_rate: deriveRecordedExchangeRate(
                        split.value_decimal,
                        quantityDecimal,
                    ),
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
                    // Seed the memo only when both splits agree; otherwise
                    // leave it blank and preserve per-split memos on save.
                    const sharedMemo = debitSplit.memo === creditSplit.memo ? debitSplit.memo : '';
                    initialSimpleMemoRef.current = sharedMemo;
                    setSimpleData({
                        amount: debitSplit.debit,
                        fromAccountGuid: creditSplit.account_guid,
                        toAccountGuid: debitSplit.account_guid,
                        memo: sharedMemo,
                    });
                }
            }
        }
    }, [transaction, dateFormat]);

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

            setSimpleData(prev => ({
                ...prev,
                amount: Math.abs(debitSplit.amount).toFixed(2),
                fromAccountGuid: creditSplit.accountGuid,
                toAccountGuid: debitSplit.accountGuid,
            }));

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

    const resolveSplitExchangeRate = (split: SplitFormData): number | null => {
        const account = accountMap.get(split.account_guid);

        // Once account metadata is available, it is authoritative. This also
        // prevents a stale rate from a previously-selected account being used.
        if (account?.commodity_guid && formData.currency_guid) {
            if (account.commodity_guid === formData.currency_guid) return 1;
            return parseExchangeRate(split.exchange_rate);
        }

        // While account metadata is loading, an already-populated rate remains
        // useful; otherwise treat the split as same-currency for display only.
        return parseExchangeRate(split.exchange_rate) ?? 1;
    };

    const calculateBalance = () => {
        let totalDebit = 0;
        let totalCredit = 0;
        formData.splits.forEach(split => {
            const rate = resolveSplitExchangeRate(split);
            if (rate === null) return;

            // Inputs are in the account's commodity, but balance is determined
            // by split values in the transaction currency.
            totalDebit += (parseFloat(split.debit) || 0) * rate;
            totalCredit += (parseFloat(split.credit) || 0) * rate;
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
            const rate = resolveSplitExchangeRate(lastSplit);
            if (rate === null) return prev;
            const nativeDifference = Math.abs(difference) / rate;

            if (difference > 0) {
                // Need more credit
                newSplits[lastIndex] = {
                    ...lastSplit,
                    credit: ((parseFloat(lastSplit.credit) || 0) + nativeDifference).toFixed(2),
                    debit: '',
                };
            } else {
                // Need more debit
                newSplits[lastIndex] = {
                    ...lastSplit,
                    debit: ((parseFloat(lastSplit.debit) || 0) + nativeDifference).toFixed(2),
                    credit: '',
                };
            }
            return { ...prev, splits: newSplits };
        });
    };

    const switchToAdvanced = () => {
        // Convert simple data to splits format, reusing loaded splits so an
        // edit round-trip through modes keeps guids/reconcile states/memos.
        if (simpleData.amount && simpleData.fromAccountGuid && simpleData.toAccountGuid) {
            const memoEdited = simpleData.memo !== initialSimpleMemoRef.current;
            setFormData(prev => ({
                ...prev,
                splits: buildSimpleModeSplits(
                    { ...simpleData, memo: memoEdited ? simpleData.memo : null },
                    prev.splits,
                ),
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
                const sharedMemo = debitSplit.memo === creditSplit.memo ? debitSplit.memo : '';
                initialSimpleMemoRef.current = sharedMemo;
                setSimpleData(prev => ({
                    ...prev,
                    amount: debitSplit.debit,
                    fromAccountGuid: creditSplit.account_guid,
                    toAccountGuid: debitSplit.account_guid,
                    memo: sharedMemo,
                }));
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

            const simpleAccounts = [
                accountMap.get(simpleData.fromAccountGuid),
                accountMap.get(simpleData.toAccountGuid),
            ].filter((account): account is Account => Boolean(account));
            const needsExchangeRate = simpleAccounts.some(account =>
                Boolean(
                    formData.currency_guid
                    && account.commodity_guid
                    && account.commodity_guid !== formData.currency_guid,
                )
            );
            if (needsExchangeRate) {
                errors.push('Foreign-currency transactions require Advanced mode so each account amount and exchange rate can be entered.');
                fieldErrors.splits = 'Use Advanced mode';
            }
        } else {
            // Advanced mode validation
            if (formData.splits.filter(s => s.account_guid).length < 2) {
                errors.push('At least 2 accounts must be selected');
                fieldErrors.splits = 'Need 2+ accounts';
            }

            const missingRateAccounts = formData.splits
                .filter(split => split.account_guid && resolveSplitExchangeRate(split) === null)
                .map(split => accountMap.get(split.account_guid)?.fullname
                    || accountMap.get(split.account_guid)?.name
                    || split.account_name
                    || 'selected account');

            if (missingRateAccounts.length > 0) {
                errors.push(`Enter a valid account-to-transaction exchange rate for: ${missingRateAccounts.join(', ')}.`);
                fieldErrors.splits = 'Exchange rate required';
            }

            const { difference } = calculateBalance();
            if (missingRateAccounts.length === 0 && Math.abs(difference) > 0.01) {
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
            // Generate splits from simple data. When editing, loaded splits
            // are reused so guids and reconcile states survive; the memo is
            // written to BOTH splits (GnuCash desktop Transfer dialog
            // behavior) unless the user left a seeded memo untouched.
            const memoEdited = simpleData.memo !== initialSimpleMemoRef.current;
            submissionSplits = buildSimpleModeSplits(
                { ...simpleData, memo: memoEdited ? simpleData.memo : null },
                formData.splits,
            );
        } else {
            submissionSplits = formData.splits;
        }

        const apiSplits: CreateTransactionRequest['splits'] = [];
        for (const split of submissionSplits.filter(candidate => candidate.account_guid)) {
            const debit = parseFloat(split.debit) || 0;
            const credit = parseFloat(split.credit) || 0;
            const accountAmount = debit - credit;
            const exchangeRate = resolveSplitExchangeRate(split);
            if (exchangeRate === null) return null;
            const accountFraction = accountMap.get(split.account_guid)?.commodity_scu || 100;

            const {
                valueNum,
                valueDenom,
                quantityNum,
                quantityDenom,
            } = buildCurrencySplitAmounts(accountAmount, exchangeRate, accountFraction);

            apiSplits.push({
                guid: /^[0-9a-f]{32}$/.test(split.id) ? split.id : undefined,
                account_guid: split.account_guid,
                value_num: valueNum,
                value_denom: valueDenom,
                quantity_num: quantityNum,
                quantity_denom: quantityDenom,
                memo: split.memo || undefined,
                reconcile_state: split.reconcile_state,
            });
        }

        // Convert form data to API format
        return {
            currency_guid: formData.currency_guid,
            num: formData.num || undefined,
            post_date: formData.post_date,
            description: formData.description,
            splits: apiSplits,
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
        initialSimpleMemoRef.current = '';
        setSimpleData({
            amount: '',
            fromAccountGuid: defaultFromAccount,
            toAccountGuid: defaultToAccount,
            memo: '',
        });
        setErrors([]);
        setFieldErrors({});
    };

    const adjustDate = (days: number) => {
        const current = new Date(formData.post_date + 'T12:00:00');
        current.setDate(current.getDate() + days);
        const newDate = toLocalDateString(current);
        setFormData(f => ({ ...f, post_date: newDate }));
        setDateDisplay(formatDateForDisplay(newDate, dateFormat));
    };

    const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            adjustDate(1);
        } else if (e.key === '-') {
            e.preventDefault();
            adjustDate(-1);
        } else if (e.key === 't' || e.key === 'T') {
            e.preventDefault();
            const newDate = toLocalDateString(new Date());
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

    saveAndAnotherRef.current = async () => {
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
                    saveAndAnotherRef.current?.();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onSaveAndAnother]);

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
                <div className="bg-negative/10 border border-negative/30 rounded-lg p-4">
                    <ul className="list-disc list-inside text-sm text-negative space-y-1">
                        {errors.map((error, i) => (
                            <li key={i}>{error}</li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Multi-Currency Info Banner */}
            {isMultiCurrency && multiCurrencyInfo && (
                <div className="p-3 rounded-lg bg-secondary/10 border border-secondary/30 text-sm text-secondary">
                    <div className="flex items-start gap-2">
                        <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <div>
                            <span className="font-medium">Multi-currency transaction detected</span>
                            <span className="text-secondary/80"> ({multiCurrencyInfo.join(' / ')})</span>
                            <p className="text-secondary/70 mt-1">
                                Trading splits will be automatically generated to balance this transaction across currencies.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Header Fields — GnuCash register proportions: narrow Date and
                Num beside each other, Description takes the width. */}
            <div className="flex flex-col md:flex-row gap-3">
                <div className="md:w-40">
                    <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                        Date
                    </label>
                    {isMobile ? (
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => adjustDate(-1)}
                                className="flex-shrink-0 w-10 h-10 flex items-center justify-center bg-input-bg border border-border rounded-lg text-foreground-muted hover:text-foreground hover:border-primary/50 transition-colors text-lg font-bold"
                            >
                                −
                            </button>
                            <input
                                ref={dateInputRef}
                                type="date"
                                value={formData.post_date}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    if (val) {
                                        setFormData(f => ({ ...f, post_date: val }));
                                        setDateDisplay(formatDateForDisplay(val, dateFormat));
                                    }
                                }}
                                data-field="post_date"
                                className="flex-1 min-w-0 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                            />
                            <button
                                type="button"
                                onClick={() => adjustDate(1)}
                                className="flex-shrink-0 w-10 h-10 flex items-center justify-center bg-input-bg border border-border rounded-lg text-foreground-muted hover:text-foreground hover:border-primary/50 transition-colors text-lg font-bold"
                            >
                                +
                            </button>
                        </div>
                    ) : (
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
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    )}
                </div>
                {/* Num recedes: check-number width, mono digits, muted text */}
                <div className="md:w-24">
                    <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                        Num
                    </label>
                    <input
                        type="text"
                        value={formData.num}
                        onChange={(e) => setFormData(f => ({ ...f, num: e.target.value }))}
                        placeholder="Check #"
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground-secondary placeholder-foreground-muted focus:outline-none focus:border-primary/50"
                    />
                </div>
                <div className="md:flex-1">
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
                            className="text-xs text-primary hover:text-primary-hover transition-colors"
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
                                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50"
                                />
                                {containsMathExpression(simpleData.amount) && (
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-primary pointer-events-none">=</span>
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
                    <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
                        <div className="w-full md:flex-1">
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                From Account
                            </label>
                            <AccountSelector
                                value={simpleData.fromAccountGuid}
                                onChange={(guid) => setSimpleData(prev => ({ ...prev, fromAccountGuid: guid }))}
                                placeholder="Select source account..."
                            />
                        </div>
                        <div className="flex items-center justify-center md:pt-5">
                            <button
                                type="button"
                                onClick={() => setSimpleData(prev => ({
                                    ...prev,
                                    fromAccountGuid: prev.toAccountGuid,
                                    toAccountGuid: prev.fromAccountGuid,
                                }))}
                                className="p-1.5 rounded-lg text-foreground-muted hover:text-primary hover:bg-primary/10 transition-colors"
                                title="Swap accounts (reverse transfer direction)"
                            >
                                <svg className="w-5 h-5 md:w-6 md:h-6 md:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                                </svg>
                            </button>
                        </div>
                        <div className="w-full md:flex-1">
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

                    {/* Memo — written to both splits, like GnuCash desktop's
                        Transfer dialog for a simple two-split entry */}
                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                            Memo
                        </label>
                        <input
                            type="text"
                            value={simpleData.memo}
                            onChange={(e) => setSimpleData(prev => ({ ...prev, memo: e.target.value }))}
                            placeholder="Optional memo (saved on both splits)"
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50"
                        />
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
                                className="text-xs text-primary hover:text-primary-hover transition-colors"
                            >
                                Switch to Simple Mode
                            </button>
                            <button
                                type="button"
                                onClick={autoBalanceLastSplit}
                                className="text-xs text-primary hover:text-primary-hover transition-colors"
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
                    <div className="hidden md:grid grid-cols-12 gap-2 text-xs text-foreground-muted uppercase tracking-wider py-2 border-b border-border-hover">
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

                    {/* Totals - Desktop */}
                    <div className="hidden md:grid grid-cols-12 gap-2 text-sm font-mono py-3 border-t border-border-hover mt-2">
                        <div className="col-span-5 text-foreground-secondary text-right pr-2">Totals:</div>
                        <div className="col-span-2 text-right text-positive">
                            {totalDebit.toFixed(2)}
                        </div>
                        <div className="col-span-2 text-right text-negative">
                            {totalCredit.toFixed(2)}
                        </div>
                        <div className="col-span-3 text-right">
                            {Math.abs(difference) > 0.01 ? (
                                <span className="text-warning">
                                    Difference: {difference.toFixed(2)}
                                </span>
                            ) : (
                                <span className="text-positive">Balanced</span>
                            )}
                        </div>
                    </div>
                    {/* Totals - Mobile */}
                    <div className="md:hidden flex justify-between text-sm font-mono py-3 border-t border-border-hover mt-2">
                        <div className="flex gap-3">
                            <span className="text-positive">Dr: {totalDebit.toFixed(2)}</span>
                            <span className="text-negative">Cr: {totalCredit.toFixed(2)}</span>
                        </div>
                        <div>
                            {Math.abs(difference) > 0.01 ? (
                                <span className="text-warning">
                                    Diff: {difference.toFixed(2)}
                                </span>
                            ) : (
                                <span className="text-positive">Balanced</span>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Actions */}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-between sm:items-center gap-3 pt-4 border-t border-border">
                <span className="hidden sm:inline text-xs text-foreground-muted">
                    <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Ctrl</kbd> + <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Enter</kbd> save
                    {onSaveAndAnother && (
                        <> | <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Ctrl+Shift</kbd> + <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Enter</kbd> save & new</>
                    )}
                </span>
                <div className="flex flex-wrap gap-3 justify-end">
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
                            onClick={() => saveAndAnotherRef.current?.()}
                            disabled={saving}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-lg transition-colors"
                        >
                            Save & New
                        </button>
                    )}
                    <button
                        type="submit"
                        disabled={saving}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
                    >
                        {saving ? (
                            <>
                                <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
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
