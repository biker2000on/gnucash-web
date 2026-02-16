'use client';

import { SplitFormData } from '@/lib/types';
import { AccountSelector } from './ui/AccountSelector';
import { useState, useEffect } from 'react';
import { evaluateMathExpression, containsMathExpression } from '@/lib/math-eval';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useToast } from '@/contexts/ToastContext';

interface SplitRowProps {
    split: SplitFormData;
    index: number;
    onChange: (index: number, field: keyof SplitFormData, value: string) => void;
    onRemove: (index: number) => void;
    canRemove: boolean;
    transactionCurrencyGuid?: string; // The transaction's currency GUID
}

export function SplitRow({
    split,
    index,
    onChange,
    onRemove,
    canRemove,
    transactionCurrencyGuid,
}: SplitRowProps) {
    const [showExchangeRate, setShowExchangeRate] = useState(false);
    const [accountCommodity, setAccountCommodity] = useState<string | null>(null);
    const { defaultTaxRate } = useUserPreferences();
    const { success } = useToast();

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
                    setShowExchangeRate(needsExchangeRate);

                    // If different, fetch default exchange rate
                    if (needsExchangeRate && !split.exchange_rate) {
                        fetchDefaultRate(data.commodity_guid, transactionCurrencyGuid);
                    }
                })
                .catch(err => console.error('Failed to fetch account info:', err));
        } else {
            setShowExchangeRate(false);
            setAccountCommodity(null);
        }
    }, [split.account_guid, transactionCurrencyGuid]);

    const fetchDefaultRate = async (fromCommodity: string, toCommodity: string) => {
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
    };

    const handleAccountChange = (accountGuid: string, accountName: string) => {
        onChange(index, 'account_guid', accountGuid);
        onChange(index, 'account_name', accountName);
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
            onChange(index, 'debit', result.toFixed(2));
        }
    };

    const handleCreditBlur = () => {
        const result = evaluateMathExpression(split.credit);
        if (result !== null) {
            onChange(index, 'credit', result.toFixed(2));
        }
    };

    const handleAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, field: 'debit' | 'credit') => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
            e.preventDefault();
            if (defaultTaxRate <= 0) {
                success('No tax rate configured. Set it in Profile settings.');
                return;
            }
            const currentStr = split[field];
            if (!currentStr) return;
            const currentValue = parseFloat(currentStr);
            if (isNaN(currentValue) || currentValue === 0) return;

            const withTax = Math.round(currentValue * (1 + defaultTaxRate) * 100) / 100;
            onChange(index, field, withTax.toFixed(2));
            success(`Tax applied: ${currentValue.toFixed(2)} + ${(defaultTaxRate * 100).toFixed(2)}% = ${withTax.toFixed(2)}`);
        }
    };

    return (
        <div className="py-2 border-b border-border last:border-0">
            <div className="grid grid-cols-12 gap-2 items-center">
                {/* Account Selector */}
                <div className="col-span-5">
                    <AccountSelector
                        value={split.account_guid}
                        onChange={handleAccountChange}
                        placeholder="Select account..."
                    />
                </div>

                {/* Debit */}
                <div className="col-span-2 relative">
                    <input
                        type="text"
                        inputMode="decimal"
                        placeholder="Debit"
                        value={split.debit}
                        onChange={(e) => handleDebitChange(e.target.value)}
                        onBlur={handleDebitBlur}
                        onKeyDown={(e) => handleAmountKeyDown(e, 'debit')}
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-emerald-400 placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50 text-right font-mono"
                    />
                    {containsMathExpression(split.debit) && (
                        <span className="absolute right-8 top-1/2 -translate-y-1/2 text-xs text-cyan-400 pointer-events-none">=</span>
                    )}
                </div>

                {/* Credit */}
                <div className="col-span-2 relative">
                    <input
                        type="text"
                        inputMode="decimal"
                        placeholder="Credit"
                        value={split.credit}
                        onChange={(e) => handleCreditChange(e.target.value)}
                        onBlur={handleCreditBlur}
                        onKeyDown={(e) => handleAmountKeyDown(e, 'credit')}
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-rose-400 placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50 text-right font-mono"
                    />
                    {containsMathExpression(split.credit) && (
                        <span className="absolute right-8 top-1/2 -translate-y-1/2 text-xs text-cyan-400 pointer-events-none">=</span>
                    )}
                </div>

                {/* Memo */}
                <div className="col-span-2">
                    <input
                        type="text"
                        placeholder="Memo"
                        value={split.memo}
                        onChange={(e) => onChange(index, 'memo', e.target.value)}
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50"
                    />
                </div>

                {/* Remove Button */}
                <div className="col-span-1 flex justify-center">
                    {canRemove && (
                        <button
                            type="button"
                            onClick={() => onRemove(index)}
                            className="p-2 text-foreground-muted hover:text-rose-400 transition-colors"
                            title="Remove split"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>

            {/* Exchange Rate (shown when account currency differs from transaction currency) */}
            {showExchangeRate && (
                <div className="mt-2 ml-1 flex items-center gap-2">
                    <label className="text-xs text-amber-400">
                        Exchange Rate:
                    </label>
                    <input
                        type="number"
                        step="0.0001"
                        value={split.exchange_rate || ''}
                        onChange={(e) => onChange(index, 'exchange_rate', e.target.value)}
                        className="w-28 px-2 py-1 bg-amber-950/30 border border-amber-600/50 rounded text-amber-200 text-xs font-mono focus:outline-none focus:border-amber-500"
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
