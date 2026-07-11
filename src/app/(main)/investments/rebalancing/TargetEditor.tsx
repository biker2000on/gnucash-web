'use client';

import type { RebalanceRow } from '@/lib/rebalancing';
import { formatCurrency } from '@/lib/format';

interface TargetEditorProps {
    rows: RebalanceRow[];
    /** Raw input strings keyed by symbol/sector (controlled by the page). */
    targetInputs: Record<string, string>;
    onTargetChange: (key: string, value: string) => void;
    /** First column header: 'Symbol' (default) or 'Sector'. */
    keyHeader?: string;
}

function parsePct(value: string | undefined): number {
    const n = parseFloat(value ?? '');
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Editable target-allocation table: one row per symbol with current %,
 * an editable target %, drift, and the dollar delta to reach target.
 */
export function TargetEditor({ rows, targetInputs, onTargetChange, keyHeader = 'Symbol' }: TargetEditorProps) {
    const totalPct = rows.reduce((sum, r) => sum + parsePct(targetInputs[r.key]), 0);
    const totalOk = Math.abs(totalPct - 100) <= 0.01;

    return (
        <div className="bg-background-secondary rounded-lg border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-foreground">Target Allocation</h3>
                <span
                    className={`font-mono tabular-nums text-sm ${
                        totalOk ? 'text-foreground-secondary' : 'text-warning'
                    }`}
                >
                    Total: {totalPct.toFixed(1)}%
                </span>
            </div>

            {!totalOk && totalPct > 0 && (
                <div className="px-4 py-2 text-xs text-warning bg-warning/10 border-b border-border">
                    Targets sum to {totalPct.toFixed(1)}%, not 100% — they will be
                    normalized proportionally when computing drift.
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                    <thead className="bg-background-tertiary/50">
                        <tr className="text-left text-xs text-foreground-secondary">
                            <th className="px-4 py-2 font-medium">{keyHeader}</th>
                            <th className="px-4 py-2 font-medium text-right">Value</th>
                            <th className="px-4 py-2 font-medium text-right">Current %</th>
                            <th className="px-4 py-2 font-medium text-right">Target %</th>
                            <th className="px-4 py-2 font-medium text-right">Drift</th>
                            <th className="px-4 py-2 font-medium text-right">$ to Target</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.map(row => (
                            <tr key={row.key} className="hover:bg-surface-hover/40">
                                <td className="px-4 py-2">
                                    <div className="font-mono font-medium text-foreground">{row.key}</div>
                                    {row.label !== row.key && (
                                        <div className="text-xs text-foreground-muted truncate max-w-[220px]">
                                            {row.label}
                                        </div>
                                    )}
                                    {row.missingHolding && (
                                        <div className="text-xs text-warning">Not currently held</div>
                                    )}
                                </td>
                                <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground-secondary">
                                    {formatCurrency(row.currentValue)}
                                </td>
                                <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">
                                    {row.currentPct.toFixed(1)}%
                                </td>
                                <td className="px-4 py-2 text-right">
                                    <div className="inline-flex items-center gap-1">
                                        <input
                                            type="number"
                                            min={0}
                                            max={100}
                                            step={1}
                                            inputMode="decimal"
                                            value={targetInputs[row.key] ?? ''}
                                            placeholder="0"
                                            onChange={e => onTargetChange(row.key, e.target.value)}
                                            aria-label={`Target percent for ${row.key}`}
                                            className="w-20 bg-input-bg border border-border rounded px-2 py-1 text-right font-mono tabular-nums text-sm text-foreground focus:outline-none focus:border-primary/50"
                                        />
                                        <span className="text-foreground-muted text-xs">%</span>
                                    </div>
                                </td>
                                <td
                                    className={`px-4 py-2 text-right font-mono tabular-nums ${
                                        !row.outsideBand
                                            ? 'text-foreground-muted'
                                            : row.driftPct > 0
                                                ? 'text-warning'
                                                : 'text-secondary'
                                    }`}
                                >
                                    {row.driftPct > 0 ? '+' : ''}
                                    {row.driftPct.toFixed(1)}%
                                </td>
                                <td
                                    className={`px-4 py-2 text-right font-mono tabular-nums ${
                                        Math.abs(row.delta) < 0.01
                                            ? 'text-foreground-muted'
                                            : row.delta > 0
                                                ? 'text-positive'
                                                : 'text-negative'
                                    }`}
                                >
                                    {row.delta > 0 ? '+' : ''}
                                    {formatCurrency(row.delta)}
                                </td>
                            </tr>
                        ))}
                        {rows.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-4 py-6 text-center text-foreground-muted">
                                    No holdings found
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
