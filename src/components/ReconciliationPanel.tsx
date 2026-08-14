'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { formatCurrency } from '@/lib/format';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { toLocalDateString } from '@/lib/datePresets';

interface ReconciliationPanelProps {
    accountGuid: string;
    commodityScu?: number;
    accountCurrency: string;
    isInvestment?: boolean;
    sharePrecision?: number;
    currentBalance: number;
    selectedBalance: number;
    onReconcileComplete?: () => void;
    selectedSplits: Set<string>;
    onSelectAll: () => void;
    onClearSelection: () => void;
    isReconciling: boolean;
    onStartReconcile: () => void;
    onCancelReconcile: () => void;
    simpleFinBalance?: { balance: number; balanceDate: string } | null;
}

export function ReconciliationPanel({
    accountCurrency,
    accountGuid,
    commodityScu,
    isInvestment = false,
    sharePrecision = 4,
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
    const statementBalanceTouched = useRef(false);
    const simpleFinDefaultApplied = useRef(false);
    const wasReconciling = useRef(false);

    // Each reconciliation gets one SimpleFin default. Once the user edits the
    // field (including clearing it), later renders or balance refreshes must
    // not overwrite their intended statement balance.
    useEffect(() => {
        if (isReconciling && !wasReconciling.current) {
            statementBalanceTouched.current = false;
            simpleFinDefaultApplied.current = false;
            setStatementBalance('');
        }
        wasReconciling.current = isReconciling;
    }, [isReconciling]);

    useEffect(() => {
        if (
            isReconciling &&
            simpleFinBalance &&
            !statementBalanceTouched.current &&
            !simpleFinDefaultApplied.current &&
            !isInvestment
        ) {
            setStatementBalance(simpleFinBalance.balance.toFixed(2));
            simpleFinDefaultApplied.current = true;
        }
    }, [isReconciling, simpleFinBalance, isInvestment]);

    const minorUnitScale = commodityScu && commodityScu > 0 ? Math.round(Math.log10(commodityScu)) : 2;
    const toMinorUnits = (value: string | number): bigint | null => {
        const raw = String(value).trim();
        if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
        const negative = raw.startsWith('-');
        const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
        if (fraction.length > minorUnitScale) return null;
        const magnitude = BigInt(whole) * (10n ** BigInt(minorUnitScale))
            + BigInt((fraction + '0'.repeat(minorUnitScale)).slice(0, minorUnitScale));
        return negative ? -magnitude : magnitude;
    };
    // Compare integer minor units only. The server independently recomputes this
    // from signed split quantity numerators/denominators before it writes.
    const statementMinorUnits = toMinorUnits(statementBalance);
    const currentMinorUnits = toMinorUnits(currentBalance.toFixed(minorUnitScale));
    const selectedMinorUnits = toMinorUnits(selectedBalance.toFixed(minorUnitScale));
    const hasStatementBalance = statementMinorUnits !== null;
    const differenceMinorUnits = hasStatementBalance && currentMinorUnits !== null && selectedMinorUnits !== null
        ? statementMinorUnits - currentMinorUnits - selectedMinorUnits
        : null;

    const handleFinish = useCallback(async (recordDiscrepancy = false) => {
        if (selectedSplits.size === 0) {
            setError('No transactions selected for reconciliation');
            return;
        }

        if (!hasStatementBalance || differenceMinorUnits === null) {
            setError('Enter a valid statement balance before finishing reconciliation.');
            return;
        }
        if (!recordDiscrepancy && differenceMinorUnits !== 0n) {
            setError('The difference must be exactly zero before finishing. Review the selected transactions or explicitly record the discrepancy.');
            return;
        }

        setSaving(true);
        setError(null);

        try {
            const res = await fetch(`/api/accounts/${accountGuid}/reconcile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    splitGuids: Array.from(selectedSplits),
                    statementDate,
                    endingBalance: statementBalance,
                    commodityScu,
                    createAdjustment: recordDiscrepancy,
                }),
            });

            if (!res.ok) {
                const body = await res.json().catch(() => null) as { error?: string } | null;
                throw new Error(body?.error || 'Failed to reconcile transactions');
            }

            onReconcileComplete?.();
            onCancelReconcile();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setSaving(false);
        }
    }, [accountGuid, commodityScu, differenceMinorUnits, hasStatementBalance, selectedSplits, statementBalance, statementDate, onReconcileComplete, onCancelReconcile]);

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

    const displayAmount = (n: number) => {
        if (isInvestment) {
            return `${n.toFixed(sharePrecision)} ${accountCurrency}`;
        }
        return formatCurrency(n.toFixed(2), accountCurrency);
    };
    const isExactlyBalanced = differenceMinorUnits === 0n;

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
            className="fixed z-50 w-[380px] max-w-[calc(100vw-2rem)] bg-surface border border-warning/30 rounded-xl p-4 space-y-3 shadow-2xl"
            style={position ? { left: position.x, top: position.y, bottom: 'auto', right: 'auto' } : { bottom: 16, right: 16 }}
        >
            <div
                className="flex items-center justify-between cursor-grab active:cursor-grabbing select-none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                <h3 className="text-sm font-semibold text-warning flex items-center gap-2">
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
                <div role="alert" className="bg-negative/10 border border-negative/30 rounded-lg px-3 py-1.5 text-xs text-negative">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                    <label htmlFor="reconciliation-statement-date" className="block text-xs text-foreground-secondary uppercase tracking-wider mb-1">
                        Statement Date
                    </label>
                    <input
                        id="reconciliation-statement-date"
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
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-warning/50"
                    />
                </div>
                <div>
                    <label htmlFor="reconciliation-statement-balance" className="block text-xs text-foreground-secondary uppercase tracking-wider mb-1">
                        {isInvestment ? 'Share Balance' : 'Statement Balance'}
                    </label>
                    <input
                        id="reconciliation-statement-balance"
                        type="number"
                        step={String(1 / (commodityScu && commodityScu > 0 ? commodityScu : 100))}
                        value={statementBalance}
                        onChange={(e) => {
                            statementBalanceTouched.current = true;
                            setStatementBalance(e.target.value);
                        }}
                        placeholder={isInvestment ? (0).toFixed(sharePrecision) : '0.00'}
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-warning/50 font-mono text-right"
                    />
                    {simpleFinBalance && (
                        <p className="text-xs text-foreground-muted mt-0.5">
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
                    <div className={`font-mono text-xs ${isExactlyBalanced ? 'text-positive' : 'text-warning'}`}>
                        {differenceMinorUnits === null ? '—' : displayAmount(Number(differenceMinorUnits) / (commodityScu && commodityScu > 0 ? commodityScu : 100))}
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
                    onClick={() => handleFinish()}
                    disabled={saving || selectedSplits.size === 0 || !hasStatementBalance || !isExactlyBalanced}
                    className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors flex items-center gap-1.5"
                >
                    {saving ? (
                        <>
                            <div className="w-3 h-3 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
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
            {!hasStatementBalance && (
                <p aria-live="polite" className="text-xs text-warning">
                    Enter the statement ending balance to calculate the difference.
                </p>
            )}
            {hasStatementBalance && !isExactlyBalanced && selectedSplits.size > 0 && !isInvestment && (
                <div className="border-t border-border pt-3 space-y-2">
                    <p aria-live="polite" className="text-xs text-warning">
                        Difference must be exactly zero to finish. Create an adjusting transaction to Imbalance to finish this reconciliation.
                    </p>
                    <button
                        onClick={() => handleFinish(true)}
                        disabled={saving}
                        className="px-3 py-1.5 text-xs bg-warning text-background rounded-lg transition-colors"
                    >
                        Create adjustment and finish
                    </button>
                </div>
            )}
            {hasStatementBalance && !isExactlyBalanced && selectedSplits.size > 0 && isInvestment && (
                <p aria-live="polite" className="text-xs text-warning">Share adjustments must be entered manually.</p>
            )}
        </div>
    );
}
