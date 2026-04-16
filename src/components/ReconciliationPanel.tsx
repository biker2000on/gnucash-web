'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { formatCurrency } from '@/lib/format';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { toLocalDateString } from '@/lib/datePresets';

interface ReconciliationPanelProps {
    accountGuid: string;
    accountCurrency: string;
    isInvestment?: boolean;
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
    isInvestment = false,
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
        toLocalDateString(new Date())
    );
    const [statementDateDisplay, setStatementDateDisplay] = useState(() =>
        formatDateForDisplay(toLocalDateString(new Date()), dateFormat)
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Auto-fill statement balance from SimpleFin when reconciliation starts
    useEffect(() => {
        if (isReconciling && simpleFinBalance && !statementBalance && !isInvestment) {
            setStatementBalance(simpleFinBalance.balance.toFixed(2));
        }
    }, [isReconciling, simpleFinBalance, statementBalance, isInvestment]);

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

    // Drag state
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        // Don't drag if clicking on interactive elements
        if ((e.target as HTMLElement).closest('button, input, a')) return;
        e.preventDefault();
        const panel = panelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const currentX = position?.x ?? rect.left;
        const currentY = position?.y ?? rect.top;
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: currentX, origY: currentY };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [position]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setPosition({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
    }, []);

    const handlePointerUp = useCallback(() => {
        dragRef.current = null;
    }, []);

    const parsedStatementBalance = parseFloat(statementBalance) || 0;
    // Reconciliation math: previously-reconciled (current) + newly-selected = statement balance
    const difference = parsedStatementBalance - (currentBalance + selectedBalance);

    const displayAmount = (n: number) => {
        if (isInvestment) {
            return `${n.toFixed(4)} ${accountCurrency}`;
        }
        return formatCurrency(n.toFixed(2), accountCurrency);
    };
    const balanceTolerance = isInvestment ? 0.00005 : 0.01;

    if (!isReconciling) {
        return (
            <button
                onClick={onStartReconcile}
                className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-2"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Reconcile
            </button>
        );
    }

    return (
        <div
            ref={panelRef}
            className="fixed z-50 w-[380px] max-w-[calc(100vw-2rem)] bg-surface border border-amber-500/30 rounded-xl p-4 space-y-3 shadow-2xl"
            style={position ? { left: position.x, top: position.y, bottom: 'auto', right: 'auto' } : { bottom: 16, right: 16 }}
        >
            <div
                className="flex items-center justify-between cursor-grab active:cursor-grabbing select-none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                <h3 className="text-sm font-semibold text-amber-400 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Reconciliation
                </h3>
                <button
                    onClick={onCancelReconcile}
                    className="text-foreground-secondary hover:text-foreground transition-colors"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {error && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-1.5 text-xs text-rose-400">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="block text-[10px] text-foreground-muted uppercase tracking-wider mb-1">
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
                        className="w-full bg-input-bg border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:border-amber-500/50"
                    />
                </div>
                <div>
                    <label className="block text-[10px] text-foreground-muted uppercase tracking-wider mb-1">
                        {isInvestment ? 'Share Balance' : 'Statement Balance'}
                    </label>
                    <input
                        type="number"
                        step={isInvestment ? '0.0001' : '0.01'}
                        value={statementBalance}
                        onChange={(e) => setStatementBalance(e.target.value)}
                        placeholder={isInvestment ? '0.0000' : '0.00'}
                        className="w-full bg-input-bg border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground placeholder-foreground-muted focus:outline-none focus:border-amber-500/50 font-mono text-right"
                    />
                    {simpleFinBalance && (
                        <p className="text-[9px] text-foreground-muted mt-0.5">
                            from SimpleFin, synced {new Date(simpleFinBalance.balanceDate).toLocaleDateString()}
                        </p>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="bg-background/30 rounded-lg p-2">
                    <div className="text-foreground-muted text-[10px] uppercase tracking-wider mb-0.5">
                        Current
                    </div>
                    <div className="font-mono text-foreground text-xs">
                        {displayAmount(currentBalance)}
                    </div>
                </div>
                <div className="bg-background/30 rounded-lg p-2">
                    <div className="text-foreground-muted text-[10px] uppercase tracking-wider mb-0.5">
                        Selected ({selectedSplits.size})
                    </div>
                    <div className="font-mono text-primary text-xs">
                        {displayAmount(selectedBalance)}
                    </div>
                </div>
                <div className="bg-background/30 rounded-lg p-2">
                    <div className="text-foreground-muted text-[10px] uppercase tracking-wider mb-0.5">
                        Difference
                    </div>
                    <div className={`font-mono text-xs ${Math.abs(difference) < balanceTolerance ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {displayAmount(difference)}
                    </div>
                </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
                <div className="flex items-center gap-2">
                    <button
                        onClick={onSelectAll}
                        className="text-[10px] text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Select All
                    </button>
                    <span className="text-foreground-muted text-[10px]">|</span>
                    <button
                        onClick={onClearSelection}
                        className="text-[10px] text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Clear
                    </button>
                </div>

                <button
                    onClick={handleFinish}
                    disabled={saving || selectedSplits.size === 0}
                    className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors flex items-center gap-1.5"
                >
                    {saving ? (
                        <>
                            <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Saving...
                        </>
                    ) : (
                        <>
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            Finish
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}
