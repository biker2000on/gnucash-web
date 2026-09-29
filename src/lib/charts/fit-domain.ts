/**
 * Y-axis fitting for time-series charts whose interesting movement is small
 * relative to the level (net worth over one year: a $200k move on a $1.5M
 * base). A zero-based axis flattens that movement into a sliver; this fits the
 * axis to the visible data with padding and returns clean, evenly spaced ticks.
 */

/** Round a raw step up to 1, 2, 2.5, or 5 × a power of ten. */
export function niceStep(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return nice * pow;
}

/** The nice step just below `step` (itself a nice step). */
function smallerNiceStep(step: number): number {
    const pow = 10 ** Math.floor(Math.log10(step) + 1e-9);
    const n = Math.round((step / pow) * 10) / 10;
    const prev = n === 1 ? 0.5 : n === 2 ? 1 : n === 2.5 ? 2 : n === 5 ? 2.5 : 5;
    return prev * pow;
}

export interface FittedDomain {
    domain: [number, number];
    ticks: number[];
}

/**
 * Fit an axis to `values` with ~5% padding and about `targetTicks` intervals.
 * A near-flat series still gets a visible span (2% of its magnitude), and an
 * all-non-negative series never gets a negative lower bound.
 */
export function fitDomain(values: number[], targetTicks = 4): FittedDomain | null {
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) return null;

    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const magnitude = Math.max(Math.abs(min), Math.abs(max));
    const span = Math.max(max - min, magnitude * 0.02, 1);
    const pad = span * 0.05;

    let lo = min - pad;
    const hi = max + pad;
    if (min >= 0 && lo < 0) lo = 0;

    // Rounding the step up can leave a third of the axis empty (a 600k raw
    // step becomes 1M). Prefer the next smaller nice step when it still keeps
    // the tick count reasonable.
    const coarse = niceStep((hi - lo) / targetTicks);
    const fine = smallerNiceStep(coarse);
    const intervals = (st: number) => (Math.ceil(hi / st) - Math.floor(lo / st));
    const step = intervals(fine) <= targetTicks + 2 ? fine : coarse;
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step;

    const ticks: number[] = [];
    // Round each tick to the step's precision so 0.1 + 0.2 noise never leaks
    // into a label.
    const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    for (let t = start; t <= end + step / 2; t += step) {
        ticks.push(Number(t.toFixed(decimals)));
    }
    return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
}

/**
 * Drop points after the period containing `today`. A "This Year" range ends
 * Dec 31, and plotting future month-ends just repeats today's balance as a
 * flat line. Points are period-end dates (YYYY-MM-DD), so the first point on
 * or after today is the current period and is kept.
 */
export function clipFuturePoints<T extends { date: string }>(points: T[], today: string): T[] {
    const idx = points.findIndex((p) => p.date >= today);
    return idx === -1 ? points : points.slice(0, idx + 1);
}
