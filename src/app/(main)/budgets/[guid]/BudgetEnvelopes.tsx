'use client';

/**
 * Envelope settings UI for the budget Progress tab.
 *
 * Exports the per-line settings modal (rollover toggle, alert threshold,
 * link-to-goal select) plus the client-side types for the envelope view
 * returned by GET /api/budgets/[guid]/envelopes. The envelope column and
 * alerts row themselves render inside BudgetProgress so they blend into
 * the existing progress table.
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type {
    AccountEnvelope,
    BudgetAlertCandidate,
    EnvelopeConfig,
} from '@/lib/budget-envelope';
import type { PeriodRange } from '@/lib/budget-actuals';

/** Client shape of GET /api/budgets/[guid]/envelopes. */
export interface EnvelopeView {
    budgetGuid: string;
    currency: string;
    asOf: string;
    currentPeriod: number | null;
    periods: PeriodRange[];
    config: EnvelopeConfig[];
    envelopes: AccountEnvelope[];
    alerts: BudgetAlertCandidate[];
}

/** Slim goal option pulled from GET /api/goals. */
export interface GoalOption {
    id: number;
    name: string;
    monthlyContribution: number | null;
    progressPct: number | null;
}

interface EnvelopeSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    budgetGuid: string;
    account: { guid: string; name: string } | null;
    /** Existing config row for this account, if any. */
    config: EnvelopeConfig | null;
    goals: GoalOption[];
    /** Called after a successful save so the caller can refetch the view. */
    onSaved: () => void;
}

const inputClass =
    'w-full bg-surface text-foreground text-sm border border-border rounded-md px-3 py-2 ' +
    'focus:outline-none focus:border-border-hover placeholder:text-foreground-muted';

export function EnvelopeSettingsModal({
    isOpen,
    onClose,
    budgetGuid,
    account,
    config,
    goals,
    onSaved,
}: EnvelopeSettingsModalProps) {
    const toast = useToast();
    const [rolloverEnabled, setRolloverEnabled] = useState(true);
    const [thresholdPct, setThresholdPct] = useState('');
    const [goalId, setGoalId] = useState('');
    const [saving, setSaving] = useState(false);

    // Re-seed the form from the current config each time the modal opens.
    useEffect(() => {
        if (!isOpen) return;
        setRolloverEnabled(config?.rolloverEnabled ?? true);
        setThresholdPct(config?.alertThresholdPct != null ? String(config.alertThresholdPct) : '');
        setGoalId(config?.goalId != null ? String(config.goalId) : '');
    }, [isOpen, config]);

    if (!account) return null;

    const selectedGoal = goalId ? goals.find(g => g.id === Number(goalId)) ?? null : null;

    const handleSave = async () => {
        const trimmed = thresholdPct.trim();
        if (trimmed !== '') {
            const n = Number(trimmed);
            if (!Number.isInteger(n) || n < 1 || n > 500) {
                toast.error('Alert threshold must be a whole number between 1 and 500');
                return;
            }
        }
        setSaving(true);
        try {
            const res = await fetch(`/api/budgets/${budgetGuid}/envelopes`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([
                    {
                        accountGuid: account.guid,
                        rolloverEnabled,
                        alertThresholdPct: trimmed === '' ? null : Number(trimmed),
                        goalId: goalId === '' ? null : Number(goalId),
                    },
                ]),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || 'Failed to save envelope settings');
            }
            toast.success('Envelope settings saved');
            onSaved();
            onClose();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save envelope settings');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Envelope Settings" size="sm">
            <div className="p-6 space-y-5">
                <div className="text-sm text-foreground-secondary">
                    {account.name}
                </div>

                {/* Rollover toggle */}
                <label className="flex items-start gap-3 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={rolloverEnabled}
                        onChange={e => setRolloverEnabled(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-border bg-surface accent-[var(--primary)]"
                    />
                    <span>
                        <span className="block text-sm font-medium text-foreground">Roll over unspent budget</span>
                        <span className="block text-xs text-foreground-muted mt-0.5">
                            Carry each period&apos;s surplus (or deficit) into the next period&apos;s envelope.
                        </span>
                    </span>
                </label>

                {/* Alert threshold */}
                <div>
                    <label htmlFor="envelope-threshold" className="block text-xs text-foreground-secondary uppercase tracking-wider mb-1.5">
                        Alert threshold %
                    </label>
                    <input
                        id="envelope-threshold"
                        type="number"
                        min={1}
                        max={500}
                        step={1}
                        value={thresholdPct}
                        onChange={e => setThresholdPct(e.target.value)}
                        placeholder="80 (default)"
                        className={`${inputClass} font-mono tabular-nums`}
                    />
                    <p className="text-xs text-foreground-muted mt-1">
                        Alert when this line&apos;s spend reaches this percent of its budget. Blank uses the default (80%).
                    </p>
                </div>

                {/* Goal link */}
                <div>
                    <label htmlFor="envelope-goal" className="block text-xs text-foreground-secondary uppercase tracking-wider mb-1.5">
                        Linked goal
                    </label>
                    <select
                        id="envelope-goal"
                        value={goalId}
                        onChange={e => setGoalId(e.target.value)}
                        className={inputClass}
                    >
                        <option value="">None</option>
                        {goals.map(g => (
                            <option key={g.id} value={g.id}>
                                {g.name}
                            </option>
                        ))}
                    </select>
                    {selectedGoal && selectedGoal.monthlyContribution != null && selectedGoal.monthlyContribution > 0 && (
                        <p className="text-xs text-foreground-muted mt-1">
                            Goal plans{' '}
                            <span className="font-mono tabular-nums text-foreground-secondary">
                                {formatCurrency(selectedGoal.monthlyContribution)}
                            </span>
                            /mo — budgeting at least this much keeps it on plan.
                        </p>
                    )}
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-2">
                    <button
                        onClick={onClose}
                        disabled={saving}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground border border-border rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
