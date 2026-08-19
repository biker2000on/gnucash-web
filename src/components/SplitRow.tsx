'use client';

import { SplitFormData } from '@/lib/types';
import { AccountSelector } from './ui/AccountSelector';
import { useState, useEffect, useCallback } from 'react';
import { evaluateMathExpression, containsMathExpression } from '@/lib/math-eval';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useToast } from '@/contexts/ToastContext';
import { useTaxShortcut } from '@/lib/hooks/useTaxShortcut';
import { formatEvaluatedAccountAmount } from '@/lib/transaction-currency';
import { Tip } from '@/components/ui/Tooltip';

interface SplitRowProps {
    split: SplitFormData;
    index: number;
    onChange: (index: number, field: keyof SplitFormData, value: string) => void;
    onRemove: (index: number) => void;
    canRemove: boolean;
    transactionCurrencyGuid?: string; // The transaction's currency GUID
    error?: string; // Row-level validation message, shown under the account cell
}

export function SplitRow({
    split,
    index,
    onChange,
    onRemove,
    canRemove,
    transactionCurrencyGuid,
    error,
}: SplitRowProps) {
    const [accountCommodity, setAccountCommodity] = useState<string | null>(null);
    const { defaultTaxRate } = useUserPreferences();
    const { success } = useToast();
    const showExchangeRate = Boolean(
        split.account_guid &&
        accountCommodity &&
        transactionCurrencyGuid &&
        accountCommodity !== transactionCurrencyGuid
    );

    const fetchDefaultRate = useCallback(async (fromCommodity: string, toCommodity: string) => {
        try {
            const res = await fetch(`/api/exchange-rates/pair?from=${fromCommodity}&to=${toCommodity}`);
            if (res.ok) {
                const data = await res.json();
                if (data.rate && !split.exchange_rate) {
                    onChange(index, 'exchange_rate', data.rate.toString());
                }
            }
        } catch (err) {
            console.error('Failed to fetch exchange rate:', err);
        }
    }, [index, onChange, split.exchange_rate]);

    // Check for multi-currency when account is selected
    useEffect(() => {
        if (split.account_guid && transactionCurrencyGuid) {
            // Fetch account info to get its commodity
            fetch(`/api/accounts/${split.account_guid}/info`)
                .then(res => res.json())
                .then(data => {
                    setAccountCommodity(data.commodity_guid);
                    // Show exchange rate if commodities differ
                    const needsExchangeRate = data.commodity_guid && data.commodity_guid !== transactionCurrencyGuid;

                    // If different, fetch default exchange rate
                    if (needsExchangeRate && !split.exchange_rate) {
                        fetchDefaultRate(data.commodity_guid, transactionCurrencyGuid);
                    }
                })
                .catch(err => console.error('Failed to fetch account info:', err));
        }
    }, [fetchDefaultRate, split.account_guid, split.exchange_rate, transactionCurrencyGuid]);

    const handleAccountChange = (accountGuid: string, accountName: string) => {
        setAccountCommodity(null);
        onChange(index, 'account_guid', accountGuid);
        onChange(index, 'account_name', accountName);
        onChange(index, 'exchange_rate', '');
    };

    const handleDebitChange = (value: string) => {
        // Clear credit when entering debit
        onChange(index, 'debit', value);
        if (value) {
            onChange(index, 'credit', '');
        }
    };

    const handleCreditChange = (value: string) => {
        // Clear debit when entering credit
        onChange(index, 'credit', value);
        if (value) {
            onChange(index, 'debit', '');
        }
    };

    const handleDebitBlur = () => {
        const result = evaluateMathExpression(split.debit);
        if (result !== null) {
            onChange(index, 'debit', formatEvaluatedAccountAmount(split.debit, result));
        }
    };

    const handleCreditBlur = () => {
        const result = evaluateMathExpression(split.credit);
        if (result !== null) {
            onChange(index, 'credit', formatEvaluatedAccountAmount(split.credit, result));
        }
    };

    // Tax shortcut for debit/credit: plain 't' evaluates any pending math
    // expression then multiplies by (1 + taxRate). Uses useTaxShortcut so the
    // behaviour matches the inline ledger AmountCell.
    const { applyTax: applyTaxDebit } = useTaxShortcut(
        split.debit,
        defaultTaxRate,
        (newAmount) => onChange(index, 'debit', newAmount),
        (msg) => success(msg),
    );
    const { applyTax: applyTaxCredit } = useTaxShortcut(
        split.credit,
        defaultTaxRate,
        (newAmount) => onChange(index, 'credit', newAmount),
        (msg) => success(msg),
    );

    const handleAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, field: 'debit' | 'credit') => {
        if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            (field === 'debit' ? applyTaxDebit : applyTaxCredit)();
        }
    };

    return (
        <div className="py-2 border-b border-border last:border-0">
            <div className="flex flex-col md:grid md:grid-cols-12 gap-2 md:items-center">
                {/* Account Selector */}
                <div className="w-full md:col-span-5">
                    <AccountSelector
                        value={split.account_guid}
                        onChange={handleAccountChange}
                        placeholder="Select account..."
                    />
                    {error && (
                        <p role="alert" className="mt-1 text-xs text-error">
                            {error}
                        </p>
                    )}
                </div>

                {/* Debit & Credit */}
                <div className="grid grid-cols-2 gap-2 md:contents">
                    {/* Debit */}
                    <div className="relative md:col-span-2">
                        <input
                            type="text"
                            inputMode="decimal"
                            placeholder="Debit"
                            value={split.debit}
                            onChange={(e) => handleDebitChange(e.target.value)}
                            onBlur={handleDebitBlur}
                            onKeyDown={(e) => handleAmountKeyDown(e, 'debit')}
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-positive placeholder-foreground-muted focus:outline-none focus:border-primary/50 text-right font-mono"
                        />
                        {containsMathExpression(split.debit) && (
                            <span className="absolute right-8 top-1/2 -translate-y-1/2 text-xs text-primary pointer-events-none">=</span>
                        )}
                    </div>

                    {/* Credit */}
                    <div className="relative md:col-span-2">
                        <input
                            type="text"
                            inputMode="decimal"
                            placeholder="Credit"
                            value={split.credit}
                            onChange={(e) => handleCreditChange(e.target.value)}
                            onBlur={handleCreditBlur}
                            onKeyDown={(e) => handleAmountKeyDown(e, 'credit')}
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-negative placeholder-foreground-muted focus:outline-none focus:border-primary/50 text-right font-mono"
                        />
                        {containsMathExpression(split.credit) && (
                            <span className="absolute right-8 top-1/2 -translate-y-1/2 text-xs text-primary pointer-events-none">=</span>
                        )}
                    </div>
                </div>

                {/* Memo & Remove */}
                <div className="flex gap-2 items-center md:contents">
                    {/* Memo */}
                    <div className="flex-1 md:col-span-2">
                        <input
                            type="text"
                            placeholder="Memo"
                            value={split.memo}
                            onChange={(e) => onChange(index, 'memo', e.target.value)}
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50"
                        />
                    </div>

                    {/* Remove Button */}
                    <div className="md:col-span-1 flex justify-center">
                        {canRemove && (
                            <Tip content="Remove split" describedBy={false}>
                            <button
                                type="button"
                                onClick={() => onRemove(index)}
                                className="p-2 text-foreground-muted hover:text-negative transition-colors"
                                aria-label="Remove split"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                            </Tip>
                        )}
                    </div>
                </div>
            </div>

            {/* Exchange Rate (shown when account currency differs from transaction currency) */}
            {showExchangeRate && (
                <div className="mt-2 ml-1 flex items-center gap-2">
                    <label className="text-xs text-warning">
                        Exchange Rate:
                    </label>
                    <input
                        type="number"
                        step="any"
                        value={split.exchange_rate || ''}
                        onChange={(e) => onChange(index, 'exchange_rate', e.target.value)}
                        className="w-28 px-2 py-1 bg-warning-light border border-warning/50 rounded text-warning text-xs font-mono focus:outline-none focus:border-warning"
                        placeholder="1.0000"
                    />
                    <span className="text-xs text-foreground-muted">
                        (account currency to transaction currency)
                    </span>
                </div>
            )}
        </div>
    );
}
