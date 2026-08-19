'use client';

import { useState, useEffect, useRef, useMemo, useCallback, useImperativeHandle, type Ref } from 'react';
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
import { parseAmountStrict } from '@/lib/parse-amount';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { toLocalDateString } from '@/lib/datePresets';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { ErrorLiveRegion } from '@/components/a11y/LiveRegion';
import { FieldError } from '@/components/ui/form';
import { ApiRequestError } from '@/lib/api-error';
import {
    buildCurrencySplitAmounts,
    deriveRecordedExchangeRate,
    editableDecimalMagnitude,
    parseExchangeRate,
} from '@/lib/transaction-currency';
import { Tip } from '@/components/ui/Tooltip';

export interface TransactionFormHandle {
    /**
     * Whether the form now holds content the user typed (or picked) that
     * differs from what it was seeded with. Read on the way out of the modal:
     * true means closing would destroy work. Same shape as the ledger's
     * inline editors (EditableSplitRowsHandle, InvestmentEditRowHandle).
     */
    isDirty: () => boolean;
}

interface TransactionFormProps {
    transaction?: Transaction | null;
    onSave: (data: CreateTransactionRequest) => Promise<void>;
    onCancel: () => void;
    defaultCurrencyGuid?: string;
    simpleMode?: boolean;
    defaultFromAccount?: string;
    defaultToAccount?: string;
    onSaveAndAnother?: (data: CreateTransactionRequest) => Promise<void>;
    /** React 19 ref-as-prop; exposes {@link TransactionFormHandle}. */
    ref?: Ref<TransactionFormHandle>;
}

interface SimpleModeData {
    amount: string;
    fromAccountGuid: string;
    toAccountGuid: string;
    memo: string;
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

/** New client-generated transaction guid in GnuCash's 32-hex-char form. */
const newClientTxGuid = (): string => crypto.randomUUID().replace(/-/g, '');

/**
 * Parse one user-typed amount box — the simple-mode Amount field and every
 * advanced-mode debit/credit cell. A math expression ("12+3") evaluates;
 * anything else must be a single valid number ("$1,234.56", "1,234.56", "25").
 * Returns null for input that is NOT a valid amount ("abc", "1.2.3", "1,23")
 * so callers reject it instead of silently booking 0 or a truncated value.
 */
export function parseAmountField(text: string): number | null {
    const evaluated = evaluateMathExpression(text);
    if (evaluated !== null) return evaluated;
    return parseAmountStrict(text);
}

/**
 * Same, for a split's debit/credit box where blank means "nothing on this
 * side" (0) rather than an error. Null still means malformed.
 */
export function parseSplitAmountField(text: string): number | null {
    if (!text.trim()) return 0;
    return parseAmountField(text);
}

/**
 * One amount box, reduced to a form two spellings of the same number share.
 * Unparseable text is kept verbatim so a half-typed "12+" still counts as
 * content the user would lose.
 */
const normalizeAmountText = (text: string): string => {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const value = parseAmountField(trimmed);
    return value === null ? trimmed : value.toFixed(4);
};

/** A split row is content only once something has been chosen or typed in it. */
const splitHasContent = (split: SplitFormData): boolean => Boolean(
    split.account_guid
    || split.debit.trim()
    || split.credit.trim()
    || (split.memo ?? '').trim()
);

/**
 * Canonical text for everything the user can actually type or pick in this
 * form. Compared against the baseline captured when the form was seeded, this
 * is the definition of "dirty" behind {@link TransactionFormHandle.isDirty}.
 *
 * Deliberately EXCLUDED, because none of it is user work and all of it moves
 * on its own after the form opens:
 *  - `currency_guid`, which the async default-currency fetch fills in;
 *  - split `id`s, a fresh crypto.randomUUID() per blank row;
 *  - `account_name`, `dateDisplay`, errors and saving flags — derived or
 *    presentational;
 *  - the Simple/Advanced toggle itself: switching carries the same content
 *    across, so a bare look at the other mode must not read as an edit.
 *
 * Blank split rows are dropped, so neither the two pre-seeded empty rows nor
 * an empty row added with "Add Split" counts as content. Amounts are compared
 * numerically because a Simple/Advanced round-trip rewrites "25" as "25.00".
 * Rows are sorted because that same round-trip can reorder them; there is no
 * UI to reorder rows, so order carries no user intent.
 */
export function serializeFormContent(formData: TransactionFormData, simple: SimpleModeData): string {
    const splits = formData.splits
        .filter(splitHasContent)
        .map(split => [
            split.account_guid,
            normalizeAmountText(split.debit),
            normalizeAmountText(split.credit),
            split.memo ?? '',
            split.reconcile_state,
            normalizeAmountText(split.exchange_rate ?? ''),
        ].join('\u001f'))
        .sort();

    return JSON.stringify({
        post_date: formData.post_date,
        description: formData.description,
        num: formData.num,
        splits,
        // Simple mode keeps the entry in its own state until save, so it has
        // to be compared whichever mode is showing.
        simple: {
            amount: normalizeAmountText(simple.amount),
            fromAccountGuid: simple.fromAccountGuid,
            toAccountGuid: simple.toAccountGuid,
            memo: simple.memo,
        },
    });
}

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
    const amount = parseAmountField(simple.amount) ?? 0;
    const claimed = new Set<string>();
    const makeSide = (accountGuid: string, side: 'from' | 'to'): SplitFormData => {
        const prior = priorSplits.find(s => s.account_guid === accountGuid && !claimed.has(s.id));
        if (prior) claimed.add(prior.id);
        const debit = side === 'to' ? amount.toFixed(2) : '';
        const credit = side === 'from' ? amount.toFixed(2) : '';
        // Dirty-compare only, never a booked value: one side is our own
        // toFixed(2) output and the other is the loaded split. A parse miss
        // here just reports "changed" and resets reconcile state, which is the
        // conservative direction, so plain parseFloat is deliberate.
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
    ref,
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
    const [simpleData, setSimpleData] = useState<SimpleModeData>({
        amount: '',
        fromAccountGuid: defaultFromAccount,
        toAccountGuid: defaultToAccount,
        memo: '',
    });
    // What the form was seeded with, in serializeFormContent's canonical form.
    // Captured here on the first render (so the pre-populated date, the two
    // empty split rows and any defaultFrom/ToAccount are part of "pristine"),
    // and re-captured whenever the form is re-seeded: when an edited
    // transaction finishes loading, and after Save & New clears it. isDirty is
    // this string against the live one — never a comparison with "empty".
    const baselineRef = useRef<string | null>(null);
    if (baselineRef.current === null) {
        baselineRef.current = serializeFormContent(formData, simpleData);
    }
    // The memo value simple mode was seeded with. While the field still holds
    // this value the user hasn't touched it, and buildSimpleModeSplits keeps
    // each split's own stored memo instead of overwriting both.
    const initialSimpleMemoRef = useRef('');
    // In-flight guard. A ref, not `saving` state: the Ctrl+Enter listener can
    // fire twice before React re-renders, so a state read would still be false
    // on the second press and post the transaction twice.
    const savingRef = useRef(false);
    // Idempotency key for creates: generated once per form-open (and once per
    // entry in save-and-another), so a retried submit collapses onto the same
    // record server-side instead of creating a duplicate.
    const clientTxGuidRef = useRef<string | null>(null);
    if (clientTxGuidRef.current === null) clientTxGuidRef.current = newClientTxGuid();
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
                // Server-rendered decimal string (never user input): plain
                // parseFloat, used only for its sign.
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
            const loadedForm: TransactionFormData = {
                post_date: postDate,
                description: transaction.description,
                num: transaction.num || '',
                currency_guid: transaction.currency_guid,
                splits,
            };
            setFormData(loadedForm);
            setDateDisplay(formatDateForDisplay(postDate, dateFormat));

            // Simple mode is only seeded for a 2-split transaction; otherwise
            // it stays at the untouched initial values below.
            let loadedSimple: SimpleModeData = {
                amount: '',
                fromAccountGuid: defaultFromAccount,
                toAccountGuid: defaultToAccount,
                memo: '',
            };

            // If editing a transaction with more than 2 splits, use advanced mode
            if (splits.length > 2) {
                setIsSimpleMode(false);
            } else if (splits.length === 2) {
                // If editing a 2-split transaction, populate simple mode data.
                // These amounts came from editableDecimalMagnitude above, not
                // from the keyboard, so parseFloat is safe here.
                const debitSplit = splits.find(s => parseFloat(s.debit) > 0);
                const creditSplit = splits.find(s => parseFloat(s.credit) > 0);
                if (debitSplit && creditSplit) {
                    // Seed the memo only when both splits agree; otherwise
                    // leave it blank and preserve per-split memos on save.
                    const sharedMemo = debitSplit.memo === creditSplit.memo ? debitSplit.memo : '';
                    initialSimpleMemoRef.current = sharedMemo;
                    loadedSimple = {
                        amount: debitSplit.debit,
                        fromAccountGuid: creditSplit.account_guid,
                        toAccountGuid: debitSplit.account_guid,
                        memo: sharedMemo,
                    };
                    setSimpleData(loadedSimple);
                }
            }

            // In edit mode "dirty" means "differs from the loaded
            // transaction", so the baseline moves to what was just loaded
            // rather than the empty form this component mounted with.
            baselineRef.current = serializeFormContent(loadedForm, loadedSimple);
        }
    }, [transaction, dateFormat, defaultFromAccount, defaultToAccount]);

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

    // The smallest fraction the transaction currency is stored in. Must match
    // the `transactionFraction` buildApiData passes to
    // buildCurrencySplitAmounts, or the form would balance different numbers
    // than it submits.
    const TRANSACTION_FRACTION = 100;

    const resolveAccountFraction = (split: SplitFormData): number => {
        const scu = accountMap.get(split.account_guid)?.commodity_scu;
        return typeof scu === 'number' && Number.isInteger(scu) && scu > 0 ? scu : 100;
    };

    const calculateBalance = () => {
        let totalDebit = 0;
        let totalCredit = 0;
        // Sum of the values the API will actually receive, in whole units of
        // TRANSACTION_FRACTION. Kept separate from the raw debit/credit totals
        // because buildCurrencySplitAmounts ROUNDS to those units: a debit of 1
        // at rate 0.3333 is submitted as 33/100, which balances a plainly-typed
        // 0.33 credit even though the raw floats differ by 0.0033. Validating
        // the raw difference would reject a transaction the server accepts.
        let submittedValueUnits = 0;
        // Rows carrying an amount that buildApiData will DROP because no
        // account is selected. They are excluded from submittedValueUnits (it
        // must describe exactly what is sent, or it could mask a real
        // imbalance) and reported as their own per-row error instead, so the
        // amount cannot be silently discarded by an accepted save.
        const unassignedAmountRows: number[] = [];
        // Splits whose typed amount does not parse. They are NOT counted as 0:
        // a malformed amount must not be able to make a transaction look
        // balanced. validateForm reports them and blocks the save.
        const invalidAmountSplits: string[] = [];
        formData.splits.forEach((split, index) => {
            const rate = resolveSplitExchangeRate(split);
            if (rate === null) return;

            const debit = parseSplitAmountField(split.debit);
            const credit = parseSplitAmountField(split.credit);
            if (debit === null || credit === null) {
                invalidAmountSplits.push(
                    accountMap.get(split.account_guid)?.fullname
                    || accountMap.get(split.account_guid)?.name
                    || split.account_name
                    || 'a split'
                );
                return;
            }

            // Inputs are in the account's commodity, but balance is determined
            // by split values in the transaction currency.
            totalDebit += debit * rate;
            totalCredit += credit * rate;

            // Exactly what buildApiData will serialize for this row.
            const submittedValue = buildCurrencySplitAmounts(
                debit - credit,
                rate,
                resolveAccountFraction(split),
                TRANSACTION_FRACTION,
            ).valueNum;

            // buildApiData sends only rows with an account, so only those count
            // toward the balance the API will check. An account-less row that
            // still rounds to a non-zero amount is a separate problem: its
            // value is about to be dropped, which the user has to be told.
            if (split.account_guid) {
                submittedValueUnits += submittedValue;
            } else if (submittedValue !== 0) {
                unassignedAmountRows.push(index);
            }
        });
        return {
            totalDebit,
            totalCredit,
            difference: totalDebit - totalCredit,
            // What the API will see. This is the one to validate against.
            submittedDifference: submittedValueUnits / TRANSACTION_FRACTION,
            invalidAmountSplits,
            unassignedAmountRows,
        };
    };

    const autoBalanceLastSplit = () => {
        const { difference, submittedDifference, invalidAmountSplits } = calculateBalance();
        // The difference is meaningless while any typed amount is unparseable.
        if (invalidAmountSplits.length > 0) return;
        // Nothing to do when the values that will be submitted already balance
        // — otherwise an FX-rounding artefact would push a correct transaction
        // out of balance. The adjustment itself uses the raw difference, which
        // is what actually has to reach zero before rounding.
        if (submittedDifference === 0) return;

        setFormData(prev => {
            const newSplits = [...prev.splits];
            const lastIndex = newSplits.length - 1;
            const lastSplit = newSplits[lastIndex];
            const rate = resolveSplitExchangeRate(lastSplit);
            if (rate === null) return prev;
            const nativeDifference = Math.abs(difference) / rate;
            // The last split's own box is user-typed too, so it is parsed
            // strictly rather than prefix-parsed before being added to.
            const existingDebit = parseSplitAmountField(lastSplit.debit);
            const existingCredit = parseSplitAmountField(lastSplit.credit);
            if (existingDebit === null || existingCredit === null) return prev;

            if (difference > 0) {
                // Need more credit
                newSplits[lastIndex] = {
                    ...lastSplit,
                    credit: (existingCredit + nativeDifference).toFixed(2),
                    debit: '',
                };
            } else {
                // Need more debit
                newSplits[lastIndex] = {
                    ...lastSplit,
                    debit: (existingDebit + nativeDifference).toFixed(2),
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
            // These boxes hold whatever the user typed in advanced mode, so
            // the "which side is which" test parses them the same way a save
            // would; the raw text carries over and simple mode validates it.
            const debitSplit = formData.splits.find(s => (parseSplitAmountField(s.debit) ?? 0) > 0);
            const creditSplit = formData.splits.find(s => (parseSplitAmountField(s.credit) ?? 0) > 0);
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

        // Evaluates any math expression first, then falls back to a strict
        // parse; a malformed amount is left untouched rather than taxed as 0.
        const currentValue = parseAmountField(simpleData.amount);
        if (currentValue === null || currentValue === 0) return;

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

    /**
     * Translate the server's field names into this form's field keys.
     *
     * The API validates the wire shape (`splits[0].account_guid`), the form
     * renders its own controls (`splits[0]`, and in simple mode `fromAccount`
     * / `toAccount` / `amount` rather than a split list). Anything that does
     * not map onto a rendered control is dropped here rather than stored under
     * a key nothing reads — the banner still carries the full text.
     */
    const mapServerFieldErrors = (serverErrors: Record<string, string>): Record<string, string> => {
        const mapped: Record<string, string> = {};
        for (const [field, message] of Object.entries(serverErrors)) {
            const splitMatch = field.match(/^splits\[(\d+)\]/);
            if (splitMatch) {
                // Simple mode has no split rows; the two accounts stand in.
                if (isSimpleMode) {
                    mapped.splits = mapped.splits ?? message;
                } else {
                    const key = `splits[${splitMatch[1]}]`;
                    mapped[key] = mapped[key] ?? message;
                }
                continue;
            }
            if (field === 'currency_guid') {
                mapped.splits = mapped.splits ?? message;
                continue;
            }
            mapped[field] = mapped[field] ?? message;
        }
        return mapped;
    };

    /** Shared failure path for both save buttons. */
    const applySaveError = (error: unknown) => {
        if (error instanceof ApiRequestError) {
            setErrors([error.message]);
            const mapped = mapServerFieldErrors(error.fieldErrors);
            if (Object.keys(mapped).length > 0) setFieldErrors(mapped);
            return;
        }
        setErrors([error instanceof Error ? error.message : 'An error occurred while saving']);
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
            const amountValue = simpleData.amount.trim() ? parseAmountField(simpleData.amount) : null;
            if (!simpleData.amount.trim()) {
                errors.push('Amount is required');
                fieldErrors.amount = 'Required';
            } else if (amountValue === null) {
                errors.push(`"${simpleData.amount.trim()}" is not a valid amount. Enter a number like 1234.56.`);
                fieldErrors.amount = 'Not a number';
            } else if (amountValue <= 0) {
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
            // Both empty is "Required" on each side, not "must be different" —
            // the equality test would otherwise overwrite the real reason with
            // one the user cannot act on.
            if (
                simpleData.fromAccountGuid &&
                simpleData.toAccountGuid &&
                simpleData.fromAccountGuid === simpleData.toAccountGuid
            ) {
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

            const { submittedDifference, invalidAmountSplits, unassignedAmountRows } = calculateBalance();
            if (invalidAmountSplits.length > 0) {
                errors.push(`Enter a valid amount (e.g. 1234.56) for: ${invalidAmountSplits.join(', ')}.`);
                fieldErrors.splits = 'Invalid amount';
            }

            // An amount on a row with no account is dropped from the request.
            // Reported per row so the user can see which one, rather than as a
            // global imbalance that would not explain itself.
            for (const index of unassignedAmountRows) {
                fieldErrors[`splits[${index}]`] = 'Select an account or clear this amount.';
            }
            if (unassignedAmountRows.length > 0) {
                const rowLabel = unassignedAmountRows.map(index => `line ${index + 1}`).join(', ');
                errors.push(
                    unassignedAmountRows.length === 1
                        ? `Select an account for ${rowLabel} or clear its amount — it would not be saved.`
                        : `Select an account for ${rowLabel} or clear their amounts — they would not be saved.`
                );
            }

            // Only meaningful once every amount parses. Checks the ROUNDED
            // integer value units the API will receive. The server applies the
            // same exact rational balance rule, so the form cannot accept an
            // imbalance that the write path rejects.
            if (invalidAmountSplits.length === 0 && missingRateAccounts.length === 0 && submittedDifference !== 0) {
                errors.push(`Transaction is unbalanced by ${submittedDifference.toFixed(2)}. Debits must equal credits.`);
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
            // Strict: a malformed amount aborts the save (validateForm has
            // already reported it) instead of quietly booking 0.
            const debit = parseSplitAmountField(split.debit);
            const credit = parseSplitAmountField(split.credit);
            if (debit === null || credit === null) return null;
            const accountAmount = debit - credit;
            const exchangeRate = resolveSplitExchangeRate(split);
            if (exchangeRate === null) return null;
            // Same fraction resolution calculateBalance uses, so the balance
            // the form validated is the balance that gets submitted.
            const accountFraction = resolveAccountFraction(split);

            const {
                valueNum,
                valueDenom,
                quantityNum,
                quantityDenom,
            } = buildCurrencySplitAmounts(accountAmount, exchangeRate, accountFraction, TRANSACTION_FRACTION);

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

        // Convert form data to API format. New transactions carry the
        // client-generated guid so a replayed POST is deduplicated by the
        // server; edits are keyed by the URL guid instead.
        return {
            ...(transaction ? {} : { guid: clientTxGuidRef.current ?? undefined }),
            currency_guid: formData.currency_guid,
            num: formData.num || undefined,
            post_date: formData.post_date,
            description: formData.description,
            splits: apiSplits,
        };
    };

    const resetForm = () => {
        // The saved entry owns the previous guid; the next one needs its own.
        clientTxGuidRef.current = newClientTxGuid();
        // Keep the current date but clear everything else
        const nextForm: TransactionFormData = {
            ...formData,
            description: '',
            num: '',
            splits: [createEmptySplit(), createEmptySplit()],
        };
        const nextSimple: SimpleModeData = {
            amount: '',
            fromAccountGuid: defaultFromAccount,
            toAccountGuid: defaultToAccount,
            memo: '',
        };
        setFormData(nextForm);
        initialSimpleMemoRef.current = '';
        setSimpleData(nextSimple);
        // The previous entry is saved; the cleared form is the new pristine
        // state, so Escape right after Save & New must not prompt.
        baselineRef.current = serializeFormContent(nextForm, nextSimple);
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
        // Ctrl+Enter is a window-level listener, so it bypasses the button's
        // disabled={saving}; without this a second press duplicates the entry.
        if (savingRef.current) return;

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

        savingRef.current = true;
        setSaving(true);
        try {
            await onSave(apiData);
        } catch (error) {
            applySaveError(error);
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    saveAndAnotherRef.current = async () => {
        // Same guard as handleSubmit: Ctrl+Shift+Enter is window-level too.
        if (savingRef.current) return;

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

        savingRef.current = true;
        setSaving(true);
        try {
            await onSaveAndAnother(apiData);
            resetForm();
            success('Transaction saved. Ready for next.');
            // Focus date field for the next transaction
            setTimeout(() => dateInputRef.current?.focus(), 0);
        } catch (error) {
            applySaveError(error);
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    // Read by TransactionFormModal on every exit path (Escape, the header
    // close button, Cancel) to decide whether closing would destroy work.
    const isDirty = useCallback(
        () => serializeFormContent(formData, simpleData) !== baselineRef.current,
        [formData, simpleData],
    );
    useImperativeHandle(ref, () => ({ isDirty }), [isDirty]);

    const { totalDebit, totalCredit, submittedDifference } = calculateBalance();

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
                {/* Error Messages.
                    The visible list carries no role of its own — ErrorLiveRegion
                    is the always-mounted region that speaks, and doubling the
                    role would announce twice (see a11y/LiveRegion.tsx). Each
                    message that names a field is ALSO rendered under that field
                    below, so the user is not left re-reading the form. */}
            <ErrorLiveRegion message={errors.length > 0 ? errors.join('. ') : null} />
            {errors.length > 0 && (
                <div data-testid="form-errors" className="rounded-lg border border-error/30 bg-error/10 p-4">
                    <ul className="list-disc list-inside text-sm text-error space-y-1">
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
                            aria-invalid={fieldErrors.post_date ? true : undefined}
                            aria-describedby={fieldErrors.post_date ? 'tx-error-post_date' : undefined}
                            className={`w-full bg-input-bg border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 ${
                                fieldErrors.post_date ? 'border-error' : 'border-border'
                            }`}
                        />
                    )}
                    <FieldError id="tx-error-post_date" message={fieldErrors.post_date} />
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
                    <FieldError id="tx-error-description" message={fieldErrors.description} />
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
                                    data-field="amount"
                                    aria-invalid={fieldErrors.amount ? true : undefined}
                                    aria-describedby={fieldErrors.amount ? 'tx-error-amount' : undefined}
                                    className={`w-full bg-input-bg border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 ${
                                        fieldErrors.amount ? 'border-error' : 'border-border'
                                    }`}
                                />
                                {containsMathExpression(simpleData.amount) && (
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-primary pointer-events-none">=</span>
                                )}
                            </div>
                            {defaultTaxRate > 0 && (
                                <Tip content={`Apply tax (${(defaultTaxRate * 100).toFixed(1)}%)`} describedBy={false}>
                                <button
                                    type="button"
                                    onClick={applyTax}
                                    className="p-2 rounded-lg bg-input-bg border border-border text-foreground-muted hover:text-foreground hover:border-border-hover transition-colors"
                                    aria-label={`Apply tax (${(defaultTaxRate * 100).toFixed(1)}%)`}
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                                        <path strokeLinecap="round" d="M19 5L5 19M6.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM17.5 20a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                                    </svg>
                                </button>
                                </Tip>
                            )}
                        </div>
                        <FieldError id="tx-error-amount" message={fieldErrors.amount} />
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
                            <FieldError id="tx-error-fromAccount" message={fieldErrors.fromAccount} />
                        </div>
                        <div className="flex items-center justify-center md:pt-5">
                            <Tip content="Swap accounts (reverse transfer direction)" describedBy={false}>
                            <button
                                type="button"
                                onClick={() => setSimpleData(prev => ({
                                    ...prev,
                                    fromAccountGuid: prev.toAccountGuid,
                                    toAccountGuid: prev.fromAccountGuid,
                                }))}
                                className="p-1.5 rounded-lg text-foreground-muted hover:text-primary hover:bg-primary/10 transition-colors"
                                aria-label="Swap accounts (reverse transfer direction)"
                            >
                                <svg className="w-5 h-5 md:w-6 md:h-6 md:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                                </svg>
                            </button>
                            </Tip>
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
                            <FieldError id="tx-error-toAccount" message={fieldErrors.toAccount} />
                        </div>
                    </div>
                    <FieldError id="tx-error-splits" message={fieldErrors.splits} />

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
                                error={fieldErrors[`splits[${index}]`]}
                            />
                        ))}
                    </div>
                    <FieldError id="tx-error-splits-advanced" message={fieldErrors.splits} />

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
                            {submittedDifference !== 0 ? (
                                <span className="text-warning">
                                    Difference: {submittedDifference.toFixed(2)}
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
                            {submittedDifference !== 0 ? (
                                <span className="text-warning">
                                    Diff: {submittedDifference.toFixed(2)}
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
