'use client';

import { useState, useCallback, useEffect } from 'react';
import { formatCurrency } from '@/lib/format';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';

interface ReconciliationPanelProps {
    accountGuid: string;
    accountCurrency: string;
    currentBalance: number;
    selectedBalance: number;
    onReconcileComplete?: () => void;
    selectedSplits: Set<string>;
    onToggleSplit: (splitGuid: string) => void;
    onSelectAll: () => void;
    onClearSelection: () => void;
    isReconciling: boolean;
    onStartReconcile: () => void;
    onCancelReconcile: () => void;
    simpleFinBalance?: { balance: number; balanceDate: string } | null;
}

export function ReconciliationPanel({
    accountCurrency,
    currentBalance,
    selectedBalance,
    onReconcileComplete,
    selectedSplits,
    onSelectAll,
    onClearSelection,
    isReconciling,
    onStartReconcile,
    onCancelReconcile,
    simpleFinBalance,
}: ReconciliationPanelProps) {
    const { dateFormat } = useUserPreferences();
    const [statementBalance, setStatementBalance] = useState('');
    const [statementDate, setStatementDate] = useState(
        new Date().toISOString().split('T')[0]
    );
    const [statementDateDisplay, setStatementDateDisplay] = useState(() =>
        formatDateForDisplay(new Date().toISOString().split('T')[0], dateFormat)
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Auto-fill statement balance from SimpleFin when reconciliation starts
    useEffect(() => {
        if (isReconciling && simpleFinBalance && !statementBalance) {
            setStatementBalance(simpleFinBalance.balance.toFixed(2));
        }
    }, [isReconciling, simpleFinBalance]);

    const handleFinish = useCallback(async () => {
        if (selectedSplits.size === 0) {
            setError('No transactions selected for reconciliation');
            return;
        }

        setSaving(true);
        setError(null);

        try {
            const res = await fetch('/api/splits/bulk/reconcile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    splits: Array.from(selectedSplits),
                    reconcile_state: 'y',
                    reconcile_date: statementDate,
                }),
            });

            if (!res.ok) {
                throw new Error('Failed to reconcile transactions');
            }

            onReconcileComplete?.();
            onCancelReconcile();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setSaving(false);
        }
    }, [selectedSplits, statementDate, onReconcileComplete, onCancelReconcile]);

    const parsedStatementBalance = parseFloat(statementBalance) || 0;
    const difference = parsedStatementBalance - selectedBalance;

    if (!isReconciling) {
        return (
            <button
                onClick={onStartReconcile}
                className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors flex items-center gap-2"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Reconcile
            </button>
        );
    }

    return (
        <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-amber-400 flex items-center gap-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Reconciliation Mode
                </h3>
                <button
                    onClick={onCancelReconcile}
                    className="text-foreground-secondary hover:text-foreground transition-colors"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {error && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 text-sm text-rose-400">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                        Statement Date
                    </label>
                    <input
                        type="text"
                        value={statementDateDisplay}
                        onChange={(e) => setStatementDateDisplay(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onBlur={() => {
                            const parsed = parseDateInput(statementDateDisplay);
                            if (parsed) {
                                setStatementDate(parsed);
                                setStatementDateDisplay(formatDateForDisplay(parsed, dateFormat));
                            } else {
                                setStatementDateDisplay(formatDateForDisplay(statementDate, dateFormat));
                            }
                        }}
                        placeholder="MM/DD/YYYY"
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-amber-500/50"
                    />
                </div>
                <div>
                    <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                        Statement Balance
                    </label>
                    <input
                        type="number"
                        step="0.01"
                        value={statementBalance}
                        onChange={(e) => setStatementBalance(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-amber-500/50 font-mono text-right"
                    />
                    {simpleFinBalance && (
                        <p className="text-[10px] text-foreground-muted mt-1">
                            from SimpleFin, synced {new Date(simpleFinBalance.balanceDate).toLocaleDateString()}
                        </p>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="bg-background/30 rounded-lg p-3">
                    <div className="text-foreground-muted text-xs uppercase tracking-wider mb-1">
                        Current Balance
                    </div>
                    <div className="font-mono text-foreground">
                        {formatCurrency(currentBalance.toFixed(2), accountCurrency)}
                    </div>
                </div>
                <div className="bg-background/30 rounded-lg p-3">
                    <div className="text-foreground-muted text-xs uppercase tracking-wider mb-1">
                        Selected ({selectedSplits.size})
                    </div>
                    <div className="font-mono text-cyan-400">
                        {formatCurrency(selectedBalance.toFixed(2), accountCurrency)}
                    </div>
                </div>
                <div className="bg-background/30 rounded-lg p-3">
                    <div className="text-foreground-muted text-xs uppercase tracking-wider mb-1">
                        Difference
                    </div>
                    <div className={`font-mono ${Math.abs(difference) < 0.01 ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {formatCurrency(difference.toFixed(2), accountCurrency)}
                    </div>
                </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
                <div className="flex items-center gap-2">
                    <button
                        onClick={onSelectAll}
                        className="text-xs text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Select All Unreconciled
                    </button>
                    <span className="text-foreground-muted">|</span>
                    <button
                        onClick={onClearSelection}
                        className="text-xs text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Clear Selection
                    </button>
                </div>

                <button
                    onClick={handleFinish}
                    disabled={saving || selectedSplits.size === 0}
                    className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
                >
                    {saving ? (
                        <>
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Saving...
                        </>
                    ) : (
                        <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            Finish Reconciliation
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}
