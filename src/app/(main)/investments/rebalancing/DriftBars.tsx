'use client';

import type { RebalanceRow } from '@/lib/rebalancing';

interface DriftBarsProps {
    rows: RebalanceRow[];
    bandPct: number;
    /** Width class for the key column (sector names need more room). */
    keyWidthClass?: string;
}

/**
 * Horizontal drift bars: one row per symbol showing current % (filled bar)
 * against target % (tick mark). Overweight positions outside the band are
 * tinted warning/negative; within-band positions stay muted.
 */
export function DriftBars({ rows, bandPct, keyWidthClass = 'w-16' }: DriftBarsProps) {
    const visible = rows.filter(r => r.currentPct > 0 || r.targetPct > 0);
    const maxPct = Math.max(10, ...visible.map(r => Math.max(r.currentPct, r.targetPct)));
    // Leave headroom so target ticks near the max are still visible
    const scale = maxPct * 1.1;

    if (visible.length === 0) {
        return null;
    }

    return (
        <div className="bg-background-secondary rounded-lg border border-border p-4">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground">Current vs Target</h3>
                <span className="text-xs text-foreground-muted">
                    Band: ±{bandPct} pts (absolute)
                </span>
            </div>

            <div className="space-y-2.5">
                {visible.map(row => {
                    const currentWidth = Math.min(100, (row.currentPct / scale) * 100);
                    const targetLeft = Math.min(100, (row.targetPct / scale) * 100);
                    const overweight = row.driftPct > 0;
                    const barColor = !row.outsideBand
                        ? 'bg-foreground-muted/50'
                        : overweight
                            ? Math.abs(row.driftPct) > bandPct * 2
                                ? 'bg-negative/70'
                                : 'bg-warning/70'
                            : 'bg-secondary/70';

                    return (
                        <div key={row.key} className="flex items-center gap-3">
                            <span
                                className={`${keyWidthClass} shrink-0 font-mono text-xs text-foreground truncate`}
                                title={row.key}
                            >
                                {row.key}
                            </span>
                            <div className="relative flex-1 h-4 bg-background-tertiary rounded-sm overflow-hidden">
                                <div
                                    className={`absolute inset-y-0 left-0 rounded-sm ${barColor} transition-[width] duration-150`}
                                    style={{ width: `${currentWidth}%` }}
                                />
                                {row.targetPct > 0 && (
                                    <div
                                        className="absolute inset-y-0 w-0.5 bg-primary"
                                        style={{ left: `${targetLeft}%` }}
                                        title={`Target ${row.targetPct.toFixed(1)}%`}
                                    />
                                )}
                            </div>
                            <span className="w-28 shrink-0 text-right font-mono tabular-nums text-xs text-foreground-secondary">
                                {row.currentPct.toFixed(1)}%
                                <span className="text-foreground-muted"> / {row.targetPct.toFixed(1)}%</span>
                            </span>
                            <span
                                className={`w-14 shrink-0 text-right font-mono tabular-nums text-xs ${
                                    !row.outsideBand
                                        ? 'text-foreground-muted'
                                        : overweight
                                            ? 'text-warning'
                                            : 'text-secondary'
                                }`}
                            >
                                {row.driftPct > 0 ? '+' : ''}
                                {row.driftPct.toFixed(1)}
                            </span>
                        </div>
                    );
                })}
            </div>

            <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border text-xs text-foreground-muted">
                <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-3 h-2 rounded-sm bg-foreground-muted/50" /> Within band
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-3 h-2 rounded-sm bg-warning/70" /> Overweight
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-3 h-2 rounded-sm bg-secondary/70" /> Underweight
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-0.5 h-3 bg-primary" /> Target
                </span>
            </div>
        </div>
    );
}
