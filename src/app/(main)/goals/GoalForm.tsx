'use client';

import { useState } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';
import type { Goal, GoalType } from '@/lib/goals';

export interface GoalFormValues {
    name: string;
    goalType: GoalType;
    targetAmount: string;
    targetMonths: string;
    targetDate: string;
    accountGuid: string;
    monthlyContribution: string;
}

const ASSET_TYPES = ['BANK', 'CASH', 'ASSET', 'STOCK', 'MUTUAL'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'];

const TYPE_OPTIONS: Array<{ value: GoalType; label: string }> = [
    { value: 'emergency_fund', label: 'Emergency Fund' },
    { value: 'savings_target', label: 'Savings Target' },
    { value: 'debt_payoff', label: 'Debt Payoff' },
];

export function goalToFormValues(goal: Goal | null): GoalFormValues {
    return {
        name: goal?.name ?? '',
        goalType: goal?.goalType ?? 'savings_target',
        targetAmount: goal?.targetAmount != null ? String(goal.targetAmount) : '',
        targetMonths: goal?.targetMonths != null ? String(goal.targetMonths) : '',
        targetDate: goal?.targetDate ?? '',
        accountGuid: goal?.accountGuid ?? '',
        monthlyContribution: goal?.monthlyContribution != null ? String(goal.monthlyContribution) : '',
    };
}

const inputClass =
    'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';

interface GoalFormProps {
    initial: GoalFormValues;
    saving: boolean;
    submitLabel: string;
    onSubmit: (values: GoalFormValues) => void;
    onCancel: () => void;
}

export function GoalForm({ initial, saving, submitLabel, onSubmit, onCancel }: GoalFormProps) {
    const [values, setValues] = useState<GoalFormValues>(initial);
    const set = <K extends keyof GoalFormValues>(key: K, v: GoalFormValues[K]) =>
        setValues(prev => ({ ...prev, [key]: v }));

    const isDebt = values.goalType === 'debt_payoff';
    const isEmergency = values.goalType === 'emergency_fund';
    const accountTypes = isDebt ? LIABILITY_TYPES : ASSET_TYPES;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit(values);
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            {/* Type selector */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">Goal type</label>
                <div className="grid grid-cols-3 gap-2">
                    {TYPE_OPTIONS.map(opt => (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => set('goalType', opt.value)}
                            className={`px-2 py-2 rounded-lg text-xs font-medium border transition-colors ${
                                values.goalType === opt.value
                                    ? 'border-primary/60 bg-primary/10 text-primary'
                                    : 'border-border text-foreground-secondary hover:bg-surface-hover'
                            }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Name */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">Name</label>
                <input
                    type="text"
                    value={values.name}
                    onChange={e => set('name', e.target.value)}
                    placeholder="e.g. 6-month emergency fund"
                    className={inputClass}
                    autoFocus
                />
            </div>

            {/* Tracking / source account */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    {isDebt ? 'Debt account' : 'Tracking account'}
                </label>
                <AccountSelector
                    value={values.accountGuid}
                    onChange={guid => set('accountGuid', guid)}
                    accountTypes={accountTypes}
                    placeholder="Select account..."
                />
                <p className="mt-1 text-xs text-foreground-muted">
                    {isDebt
                        ? 'The liability tracked toward payoff.'
                        : 'Current balance is read from this account.'}
                </p>
            </div>

            {/* Type-specific target fields */}
            {isEmergency && (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Months of expenses to cover
                    </label>
                    <input
                        type="number"
                        min="0"
                        step="1"
                        value={values.targetMonths}
                        onChange={e => set('targetMonths', e.target.value)}
                        placeholder="6"
                        className={inputClass}
                    />
                    <p className="mt-1 text-xs text-foreground-muted">
                        Target auto-computes from your monthly expense run-rate.
                    </p>
                </div>
            )}

            {!isEmergency && (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        {isDebt ? 'Original balance (optional)' : 'Target amount'}
                    </label>
                    <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={values.targetAmount}
                        onChange={e => set('targetAmount', e.target.value)}
                        placeholder={isDebt ? 'Starting balance for progress %' : '10000'}
                        className={inputClass}
                    />
                </div>
            )}

            {/* Optional target amount override for emergency fund */}
            {isEmergency && (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Fixed target override (optional)
                    </label>
                    <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={values.targetAmount}
                        onChange={e => set('targetAmount', e.target.value)}
                        placeholder="Used only if no expense data"
                        className={inputClass}
                    />
                </div>
            )}

            {/* Target / payoff-by date */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    {isDebt ? 'Payoff by (optional)' : 'Target date (optional)'}
                </label>
                <input
                    type="date"
                    value={values.targetDate}
                    onChange={e => set('targetDate', e.target.value)}
                    className={inputClass}
                />
            </div>

            {/* Monthly contribution / payment */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Monthly {isDebt ? 'payment' : 'contribution'} (optional)
                </label>
                <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={values.monthlyContribution}
                    onChange={e => set('monthlyContribution', e.target.value)}
                    placeholder="Leave blank to infer from account run-rate"
                    className={inputClass}
                />
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-border">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={saving || !values.name.trim()}
                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                >
                    {saving ? 'Saving...' : submitLabel}
                </button>
            </div>
        </form>
    );
}
