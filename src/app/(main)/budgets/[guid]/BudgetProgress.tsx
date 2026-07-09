'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { FilterBar } from '@/components/ui/FilterBar';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { useToast } from '@/contexts/ToastContext';
import { EnvelopeSettingsModal, type EnvelopeView, type GoalOption } from './BudgetEnvelopes';
import type {
    AccountProgress,
    BudgetActualsResponse,
    PacingStatus,
} from '@/lib/budget-actuals';

interface BudgetProgressProps {
    data: BudgetActualsResponse;
}

const STATUS_STYLES: Record<PacingStatus, { badge: string; bar: string; label: string }> = {
    'on-track': { badge: 'bg-positive/10 text-positive', bar: 'bg-primary', label: 'On track' },
    warning: { badge: 'bg-warning/10 text-warning', bar: 'bg-warning', label: 'Projected over' },
    over: { badge: 'bg-negative/10 text-negative', bar: 'bg-negative', label: 'Over budget' },
};

function StatusBadge({ status }: { status: PacingStatus }) {
    const s = STATUS_STYLES[status];
    return (
        <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded ${s.badge}`}>
            {s.label}
        </span>
    );
}

/**
 * Flat budgeted-vs-actual bar. Fill = pct of budget used; the thin marker
 * sits at the elapsed fraction of the period (where spend "should" be at a
 * steady pace).
 */
function ProgressBar({
    pctUsed,
    paceMarker,
    status,
    isIncome,
}: {
    pctUsed: number | null;
    paceMarker: number | null;
    status: PacingStatus;
    isIncome: boolean;
}) {
    const fillPct = pctUsed === null ? 0 : Math.min(100, Math.max(0, pctUsed));
    const barClass = isIncome ? 'bg-positive' : STATUS_STYLES[status].bar;
    return (
        <div className="relative h-1.5 rounded-sm bg-background-tertiary overflow-hidden">
            <div
                className={`absolute inset-y-0 left-0 rounded-sm ${barClass} transition-[width] duration-150 ease-out`}
                style={{ width: `${fillPct}%` }}
            />
            {paceMarker !== null && paceMarker > 0 && paceMarker < 1 && (
                <div
                    className="absolute inset-y-0 w-px bg-foreground-muted"
                    style={{ left: `${paceMarker * 100}%` }}
                    title={`${Math.round(paceMarker * 100)}% of period elapsed`}
                />
            )}
        </div>
    );
}

function rowStatus(account: AccountProgress, periodNum: number, isCurrentPeriod: boolean): PacingStatus {
    if (isCurrentPeriod && account.pacing) return account.pacing.status;
    const period = account.periods[periodNum];
    if (!period) return 'on-track';
    return period.actual > period.budgeted + 0.005 ? 'over' : 'on-track';
}

export function BudgetProgress({ data }: BudgetProgressProps) {
    const toast = useToast();
    const [selectedPeriod, setSelectedPeriod] = useState(data.currentPeriod ?? 0);
    const isCurrentPeriod = selectedPeriod === data.currentPeriod;

    // Envelope/rollover state (config + carry balances + active alerts).
    const [envelopeView, setEnvelopeView] = useState<EnvelopeView | null>(null);
    const [goals, setGoals] = useState<GoalOption[]>([]);
    const [settingsAccount, setSettingsAccount] = useState<{ guid: string; name: string } | null>(null);
    const [scanning, setScanning] = useState(false);

    const fetchEnvelopes = useCallback(async () => {
        try {
            const res = await fetch(`/api/budgets/${data.budgetGuid}/envelopes`);
            if (!res.ok) return;
            setEnvelopeView(await res.json());
        } catch (err) {
            console.error('Error loading envelope view:', err);
        }
    }, [data.budgetGuid]);

    useEffect(() => {
        fetchEnvelopes();
    }, [fetchEnvelopes]);

    // Goals for the link-to-goal select and inline goal labels.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/goals');
                if (!res.ok) return;
                const list = await res.json();
                if (cancelled || !Array.isArray(list)) return;
                setGoals(list.map((g: {
                    id: number;
                    name: string;
                    monthlyContribution: number | null;
                    progress?: { progressPct?: number };
                }) => ({
                    id: g.id,
                    name: g.name,
                    monthlyContribution: g.monthlyContribution ?? null,
                    progressPct: g.progress?.progressPct ?? null,
                })));
            } catch (err) {
                console.error('Error loading goals:', err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const configByAccount = useMemo(
        () => new Map((envelopeView?.config ?? []).map(c => [c.accountGuid, c])),
        [envelopeView]
    );
    const envelopeByAccount = useMemo(
        () => new Map((envelopeView?.envelopes ?? []).map(e => [e.accountGuid, e])),
        [envelopeView]
    );
    const goalById = useMemo(() => new Map(goals.map(g => [g.id, g])), [goals]);
    const showAvailableColumn = useMemo(
        () => (envelopeView?.config ?? []).some(c => c.rolloverEnabled),
        [envelopeView]
    );
    const alertCount = envelopeView?.alerts.length ?? 0;

    const handleScanNow = useCallback(async () => {
        setScanning(true);
        try {
            const res = await fetch('/api/budgets/alerts/scan', { method: 'POST' });
            if (!res.ok) throw new Error('Scan failed');
            const result: { detected: number; created: number } = await res.json();
            if (result.created > 0) {
                toast.success(`Budget scan: ${result.created} new alert${result.created === 1 ? '' : 's'} (${result.detected} active)`);
            } else {
                toast.info(result.detected > 0
                    ? `Budget scan: ${result.detected} active condition${result.detected === 1 ? '' : 's'}, no new alerts`
                    : 'Budget scan: no alert conditions found');
            }
            fetchEnvelopes();
        } catch (err) {
            console.error('Error scanning budget alerts:', err);
            toast.error('Failed to scan budget alerts');
        } finally {
            setScanning(false);
        }
    }, [toast, fetchEnvelopes]);

    const pacing = isCurrentPeriod ? data.pacing : null;
    const selectedTotals = data.periodTotals[selectedPeriod];
    const paceMarker = isCurrentPeriod ? data.elapsedFraction : null;

    const stepPeriod = useCallback((delta: number) => {
        setSelectedPeriod(prev => Math.min(data.periods.length - 1, Math.max(0, prev + delta)));
    }, [data.periods.length]);

    // [ / ] step the period selector; scoped as plain keys so they are
    // ignored inside inputs and never collide with the global chords.
    useKeyboardShortcut('budget-progress-prev-period', '[', 'Previous budget period', () => stepPeriod(-1));
    useKeyboardShortcut('budget-progress-next-period', ']', 'Next budget period', () => stepPeriod(1));

    const sortedAccounts = useMemo(() => {
        const rank = (a: AccountProgress) => {
            if (a.type === 'INCOME') return 3;
            if (isCurrentPeriod && a.pacing) {
                if (a.pacing.status === 'over') return 0;
                if (a.pacing.status === 'warning') return 1;
            }
            return 2;
        };
        return [...data.accounts].sort((a, b) =>
            rank(a) - rank(b) ||
            (b.periods[selectedPeriod]?.actual ?? 0) - (a.periods[selectedPeriod]?.actual ?? 0) ||
            a.name.localeCompare(b.name)
        );
    }, [data.accounts, selectedPeriod, isCurrentPeriod]);

    if (data.accounts.length === 0) {
        return (
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 text-center">
                <h3 className="text-lg font-medium text-foreground-secondary mb-2">No Budget Allocations</h3>
                <p className="text-foreground-muted">
                    Add accounts and amounts in the Editor tab to start tracking progress.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Current-period summary (matches the editor's stat card row) */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
                    <div className="text-xs text-foreground-muted uppercase tracking-wider mb-1">
                        Budgeted · {data.periods[selectedPeriod]?.label ?? ''}
                    </div>
                    <div className="text-2xl font-bold font-mono tabular-nums text-foreground">
                        {formatCurrency(selectedTotals?.budgeted ?? 0, data.currency)}
                    </div>
                </div>
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
                    <div className="text-xs text-foreground-muted uppercase tracking-wider mb-1">Spent</div>
                    <div className="text-2xl font-bold font-mono tabular-nums text-foreground">
                        {formatCurrency(selectedTotals?.actual ?? 0, data.currency)}
                    </div>
                    {selectedTotals?.pctUsed !== null && selectedTotals !== undefined && (
                        <div className="text-xs text-foreground-secondary mt-1">
                            {selectedTotals.pctUsed.toFixed(0)}% of budget
                        </div>
                    )}
                </div>
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
                    <div className="text-xs text-foreground-muted uppercase tracking-wider mb-1">Remaining</div>
                    <div className={`text-2xl font-bold font-mono tabular-nums ${(selectedTotals?.remaining ?? 0) < 0 ? 'text-negative' : 'text-positive'}`}>
                        {formatCurrency(selectedTotals?.remaining ?? 0, data.currency)}
                    </div>
                </div>
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
                    <div className="text-xs text-foreground-muted uppercase tracking-wider mb-1">Projected End of Period</div>
                    {pacing ? (
                        <>
                            <div className={`text-2xl font-bold font-mono tabular-nums ${pacing.status !== 'on-track' ? 'text-negative' : 'text-foreground'}`}>
                                {formatCurrency(pacing.projected, data.currency)}
                            </div>
                            <div className="text-xs mt-1">
                                {pacing.projectedOver > 0 ? (
                                    <span className="text-negative font-mono tabular-nums">
                                        +{formatCurrency(pacing.projectedOver, data.currency)} over budget
                                    </span>
                                ) : (
                                    <span className="text-positive">On pace</span>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="text-2xl font-bold font-mono tabular-nums text-foreground-muted">—</div>
                            <div className="text-xs text-foreground-muted mt-1">Current period only</div>
                        </>
                    )}
                </div>
            </div>

            {/* Progress table (same treatment as the budget editor table) */}
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl overflow-hidden">
                <div className="px-4 py-2 bg-surface-hover/50 border-b border-border">
                    <FilterBar
                        primary={
                            <div className="flex items-center gap-2">
                                <label htmlFor="budget-period-select" className="text-xs text-foreground-secondary uppercase tracking-wider">
                                    Period
                                </label>
                                <select
                                    id="budget-period-select"
                                    value={selectedPeriod}
                                    onChange={e => setSelectedPeriod(parseInt(e.target.value, 10))}
                                    className="text-xs bg-surface text-foreground-secondary border border-border rounded px-2 py-1"
                                >
                                    {data.periods.map(p => (
                                        <option key={p.periodNum} value={p.periodNum}>
                                            {p.label}{p.periodNum === data.currentPeriod ? ' (current)' : ''}
                                        </option>
                                    ))}
                                </select>
                                <span className="hidden sm:inline text-xs text-foreground-muted">
                                    <kbd className="px-1 py-0.5 rounded border border-border bg-surface font-mono text-[10px]">[</kbd>
                                    {' '}
                                    <kbd className="px-1 py-0.5 rounded border border-border bg-surface font-mono text-[10px]">]</kbd>
                                    {' '}to step
                                </span>
                            </div>
                        }
                    >
                        {envelopeView && (
                            <span className="flex items-center gap-2 text-xs">
                                <span className={alertCount > 0 ? 'text-warning' : 'text-foreground-muted'}>
                                    {alertCount} alert{alertCount === 1 ? '' : 's'}
                                </span>
                                <button
                                    onClick={handleScanNow}
                                    disabled={scanning}
                                    className="px-2 py-1 text-xs text-foreground-secondary hover:text-foreground border border-border rounded hover:bg-surface-hover transition-colors disabled:opacity-50"
                                >
                                    {scanning ? 'Scanning…' : 'Scan now'}
                                </button>
                            </span>
                        )}
                        {isCurrentPeriod && data.elapsedFraction !== null && (
                            <span className="text-xs text-foreground-muted">
                                {Math.round(data.elapsedFraction * 100)}% of period elapsed · as of{' '}
                                <span className="font-mono tabular-nums">{data.asOf}</span>
                            </span>
                        )}
                    </FilterBar>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm max-md:text-xs">
                        <thead>
                            <tr className="bg-background-secondary text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-4 py-3 text-left font-semibold min-w-[180px]">Account</th>
                                <th className="px-4 py-3 text-left font-semibold min-w-[160px] w-[24%]">Progress</th>
                                <th className="px-4 py-3 text-right font-semibold min-w-[100px]">Budgeted</th>
                                <th className="px-4 py-3 text-right font-semibold min-w-[100px]">Actual</th>
                                <th className="px-4 py-3 text-right font-semibold min-w-[100px]">Remaining</th>
                                {showAvailableColumn && (
                                    <th className="px-4 py-3 text-right font-semibold min-w-[110px]" title="Remaining including rollover carry">
                                        Available
                                    </th>
                                )}
                                <th className="px-4 py-3 text-right font-semibold min-w-[110px]">Projected</th>
                                <th className="px-4 py-3 text-left font-semibold min-w-[110px]">Status</th>
                                <th className="px-2 py-3 w-10" aria-label="Envelope settings" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                            {sortedAccounts.map(account => {
                                const period = account.periods[selectedPeriod];
                                if (!period) return null;
                                const isIncome = account.type === 'INCOME';
                                const status = rowStatus(account, selectedPeriod, isCurrentPeriod);
                                const accountPacing = isCurrentPeriod ? account.pacing : null;
                                const envelope = envelopeByAccount.get(account.guid);
                                const envelopePeriod = envelope?.rolloverEnabled
                                    ? envelope.periods.find(p => p.periodNum === selectedPeriod) ?? null
                                    : null;
                                const config = configByAccount.get(account.guid);
                                const linkedGoal = config?.goalId != null ? goalById.get(config.goalId) ?? null : null;
                                return (
                                    <tr key={account.guid} className="hover:bg-white/[0.02] transition-colors">
                                        <td className="px-4 py-2 font-medium text-foreground">
                                            <Link
                                                href={`/accounts/${account.guid}`}
                                                className="hover:text-primary transition-colors"
                                            >
                                                {account.name}
                                            </Link>
                                            <div className="text-xs text-foreground-muted">{account.type}</div>
                                            {linkedGoal && (
                                                <div className="text-xs text-primary">
                                                    Goal: {linkedGoal.name}
                                                    {linkedGoal.progressPct !== null && (
                                                        <span className="font-mono tabular-nums"> · {linkedGoal.progressPct.toFixed(0)}%</span>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-2">
                                            <ProgressBar
                                                pctUsed={period.pctUsed}
                                                paceMarker={paceMarker}
                                                status={status}
                                                isIncome={isIncome}
                                            />
                                            <div className="mt-1 text-xs text-foreground-muted font-mono tabular-nums">
                                                {period.pctUsed !== null
                                                    ? `${period.pctUsed.toFixed(0)}% ${isIncome ? 'received' : 'used'}`
                                                    : 'no budget'}
                                                {accountPacing && accountPacing.paceRatio !== null && !isIncome && (
                                                    <span> · {accountPacing.paceRatio.toFixed(2)}× pace</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">
                                            {formatCurrency(period.budgeted, account.currency)}
                                        </td>
                                        <td className={`px-4 py-2 text-right font-mono tabular-nums ${isIncome ? 'text-positive' : 'text-foreground'}`}>
                                            {formatCurrency(period.actual, account.currency)}
                                        </td>
                                        <td className={`px-4 py-2 text-right font-mono tabular-nums ${period.remaining < 0 && !isIncome ? 'text-negative' : 'text-foreground-secondary'}`}>
                                            {formatCurrency(period.remaining, account.currency)}
                                        </td>
                                        {showAvailableColumn && (
                                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                                                {envelopePeriod ? (
                                                    <>
                                                        <span className={envelopePeriod.effectiveRemaining < 0 ? 'text-negative' : 'text-positive'}>
                                                            {formatCurrency(envelopePeriod.effectiveRemaining, account.currency)}
                                                        </span>
                                                        {envelopePeriod.carryIn !== 0 && (
                                                            <div className="text-xs text-foreground-muted">
                                                                {envelopePeriod.carryIn > 0 ? '+' : ''}
                                                                {formatCurrency(envelopePeriod.carryIn, account.currency)} carried
                                                            </div>
                                                        )}
                                                    </>
                                                ) : (
                                                    <span className="text-foreground-muted">—</span>
                                                )}
                                            </td>
                                        )}
                                        <td className="px-4 py-2 text-right font-mono tabular-nums">
                                            {accountPacing ? (
                                                <>
                                                    <span className={!isIncome && accountPacing.projectedOver > 0 ? 'text-negative' : 'text-foreground-secondary'}>
                                                        {formatCurrency(accountPacing.projected, account.currency)}
                                                    </span>
                                                    {!isIncome && accountPacing.projectedOver > 0 && (
                                                        <div className="text-xs text-negative">
                                                            +{formatCurrency(accountPacing.projectedOver, account.currency)}
                                                        </div>
                                                    )}
                                                </>
                                            ) : (
                                                <span className="text-foreground-muted">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-2">
                                            {isIncome ? (
                                                <span className="text-xs text-foreground-muted">Income</span>
                                            ) : (
                                                <StatusBadge status={status} />
                                            )}
                                        </td>
                                        <td className="px-2 py-2 text-center">
                                            {!isIncome && envelopeView && (
                                                <button
                                                    onClick={() => setSettingsAccount({ guid: account.guid, name: account.name })}
                                                    className="p-1.5 text-foreground-muted hover:text-primary hover:bg-primary/10 rounded transition-colors"
                                                    title="Envelope settings"
                                                    aria-label={`Envelope settings for ${account.name}`}
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                    </svg>
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                        <tfoot>
                            <tr className="bg-background-tertiary/80 font-semibold border-t border-border">
                                <td className="px-4 py-2 text-foreground">Total Expenses</td>
                                <td className="px-4 py-2 text-xs text-foreground-muted font-mono tabular-nums">
                                    {selectedTotals?.pctUsed !== null && selectedTotals !== undefined
                                        ? `${selectedTotals.pctUsed.toFixed(0)}% used`
                                        : ''}
                                </td>
                                <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">
                                    {formatCurrency(selectedTotals?.budgeted ?? 0, data.currency)}
                                </td>
                                <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">
                                    {formatCurrency(selectedTotals?.actual ?? 0, data.currency)}
                                </td>
                                <td className={`px-4 py-2 text-right font-mono tabular-nums ${(selectedTotals?.remaining ?? 0) < 0 ? 'text-negative' : 'text-positive'}`}>
                                    {formatCurrency(selectedTotals?.remaining ?? 0, data.currency)}
                                </td>
                                {showAvailableColumn && (() => {
                                    const expenseGuids = new Set(
                                        data.accounts.filter(a => a.type === 'EXPENSE').map(a => a.guid)
                                    );
                                    const totalAvailable = (envelopeView?.envelopes ?? [])
                                        .filter(e => e.rolloverEnabled && expenseGuids.has(e.accountGuid))
                                        .reduce((s, e) => s + (e.periods.find(p => p.periodNum === selectedPeriod)?.effectiveRemaining ?? 0), 0);
                                    return (
                                        <td className={`px-4 py-2 text-right font-mono tabular-nums ${totalAvailable < 0 ? 'text-negative' : 'text-positive'}`}>
                                            {formatCurrency(totalAvailable, data.currency)}
                                        </td>
                                    );
                                })()}
                                <td className="px-4 py-2 text-right font-mono tabular-nums">
                                    {pacing ? (
                                        <span className={pacing.projectedOver > 0 ? 'text-negative' : 'text-foreground-secondary'}>
                                            {formatCurrency(pacing.projected, data.currency)}
                                        </span>
                                    ) : (
                                        <span className="text-foreground-muted">—</span>
                                    )}
                                </td>
                                <td className="px-4 py-2">
                                    {pacing && <StatusBadge status={pacing.status} />}
                                </td>
                                <td className="px-2 py-2" />
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>

            {/* Per-line envelope settings (rollover / threshold / goal link) */}
            <EnvelopeSettingsModal
                isOpen={settingsAccount !== null}
                onClose={() => setSettingsAccount(null)}
                budgetGuid={data.budgetGuid}
                account={settingsAccount}
                config={settingsAccount ? configByAccount.get(settingsAccount.guid) ?? null : null}
                goals={goals}
                onSaved={fetchEnvelopes}
            />
        </div>
    );
}
