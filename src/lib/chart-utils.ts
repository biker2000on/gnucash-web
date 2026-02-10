/**
 * Shared utilities for investment chart gradient fills.
 * Used by PerformanceChart and InvestmentAccount for % change mode.
 */

// Colors
export const CHART_COLORS = {
  green: '#10b981',    // emerald-500 — positive returns
  red: '#f43f5e',      // rose-500 — negative returns
  cyan: '#06b6d4',     // cyan-500 — default price mode
} as const;

export const GRADIENT_FILL_OPACITY = 0.3;

/**
 * Compute the vertical offset (0–1) where the zero line falls
 * within a top-to-bottom SVG gradient, given the data domain [min, max].
 *
 * - Returns 1 if all values >= 0 (entire chart green)
 * - Returns 0 if all values <= 0 (entire chart red)
 * - Returns 0.5 for empty/degenerate data
 */
export function computeZeroOffset(data: Array<{ value: number }>, dataKey: string = 'value'): number {
  if (!data || data.length === 0) return 0.5;

  let min = Infinity;
  let max = -Infinity;
  for (const point of data) {
    const v = (point as Record<string, number>)[dataKey] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (min === max) return 0.5;
  if (min >= 0) return 1;      // all positive
  if (max <= 0) return 0;      // all negative

  // Clamp defensively
  return Math.max(0, Math.min(1, max / (max - min)));
}
