/**
 * Proactive-insight detector tests: threshold logic on synthetic series,
 * dedupe-key stability, dismiss filtering, and the AI-polish fallback.
 * Prisma (and the pg pool behind ai-config) are mocked — everything under
 * test is pure.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/db', () => ({ query: vi.fn(), toDecimal: vi.fn() }));

import {
    detectCategorySpike,
    detectNewMerchants,
    detectSavingsRateDrop,
    detectNetWorthMilestone,
    detectBalanceDrops,
    computeInsights,
    filterInsights,
    polishInsights,
    isoWeekKey,
    CATEGORY_SPIKE_MIN_AMOUNT,
    NEW_MERCHANT_MIN_AMOUNT,
    BALANCE_DROP_MIN_PRIOR,
    type InsightCandidate,
    type InsightSource,
} from '../insights';

const MONTH = '2026-07';
const WEEK = '2026-W28';

/* ------------------------------------------------------------------ */
/* detectCategorySpike                                                 */
/* ------------------------------------------------------------------ */

describe('detectCategorySpike', () => {
    it('flags the top category when >25% above its 3-month average', () => {
        const out = detectCategorySpike(MONTH, [
            { name: 'Dining', current: 400, priorMonths: [300, 290, 310] }, // avg 300, +33%
            { name: 'Fuel', current: 100, priorMonths: [100, 100, 100] },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('category-spike');
        expect(out[0].title).toContain('Dining');
        expect(out[0].title).toContain('33%');
        expect(out[0].severity).toBe('info');
    });

    it('stays quiet at or below the 25% threshold', () => {
        expect(
            detectCategorySpike(MONTH, [
                { name: 'Dining', current: 375, priorMonths: [300, 300, 300] }, // exactly +25%
            ])
        ).toEqual([]);
        expect(
            detectCategorySpike(MONTH, [
                { name: 'Dining', current: 310, priorMonths: [300, 300, 300] },
            ])
        ).toEqual([]);
    });

    it('escalates to warning above +50%', () => {
        const out = detectCategorySpike(MONTH, [
            { name: 'Travel', current: 900, priorMonths: [400, 500, 600] }, // avg 500, +80%
        ]);
        expect(out[0].severity).toBe('warning');
    });

    it('ignores categories below the minimum spend', () => {
        expect(
            detectCategorySpike(MONTH, [
                { name: 'Coffee', current: CATEGORY_SPIKE_MIN_AMOUNT - 1, priorMonths: [10, 10, 10] },
            ])
        ).toEqual([]);
    });

    it('needs a prior-month base (no history, zero average → no insight)', () => {
        expect(detectCategorySpike(MONTH, [{ name: 'New', current: 500, priorMonths: [] }])).toEqual([]);
        expect(
            detectCategorySpike(MONTH, [{ name: 'New', current: 500, priorMonths: [0, 0, 0] }])
        ).toEqual([]);
        expect(detectCategorySpike(MONTH, [])).toEqual([]);
    });

    it('only examines the single top current-month category', () => {
        const out = detectCategorySpike(MONTH, [
            { name: 'Big Steady', current: 1000, priorMonths: [1000, 1000, 1000] }, // top but flat
            { name: 'Small Spiky', current: 400, priorMonths: [100, 100, 100] },    // spiky but not top
        ]);
        expect(out).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* detectNewMerchants                                                  */
/* ------------------------------------------------------------------ */

describe('detectNewMerchants', () => {
    it('flags first-ever charges over $100 landing in the month', () => {
        const out = detectNewMerchants(MONTH, [
            { description: 'Peloton', firstDate: '2026-07-03', firstAmount: 250 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('new-merchant');
        expect(out[0].severity).toBe('info');
        expect(out[0].title).toContain('Peloton');
        expect(out[0].detail).toContain('250');
    });

    it('ignores small first charges and merchants first seen earlier', () => {
        expect(
            detectNewMerchants(MONTH, [
                { description: 'Corner Store', firstDate: '2026-07-03', firstAmount: NEW_MERCHANT_MIN_AMOUNT },
                { description: 'Old Gym', firstDate: '2026-06-15', firstAmount: 500 },
            ])
        ).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* detectSavingsRateDrop                                               */
/* ------------------------------------------------------------------ */

describe('detectSavingsRateDrop', () => {
    it('flags a drop of >= 10 points vs the prior average', () => {
        const out = detectSavingsRateDrop(MONTH, 5, [20, 22, 18, 21]); // avg 20.25
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('savings-rate-drop');
        expect(out[0].severity).toBe('warning');
        expect(out[0].detail).toContain('5.0%');
    });

    it('stays quiet below the threshold and on improvements', () => {
        expect(detectSavingsRateDrop(MONTH, 15, [20, 22, 18, 21])).toEqual([]);
        expect(detectSavingsRateDrop(MONTH, 35, [20, 22, 18, 21])).toEqual([]);
    });

    it('requires at least 3 prior months of data', () => {
        expect(detectSavingsRateDrop(MONTH, 0, [30, 30])).toEqual([]);
        expect(detectSavingsRateDrop(MONTH, 0, [])).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* detectNetWorthMilestone                                             */
/* ------------------------------------------------------------------ */

describe('detectNetWorthMilestone', () => {
    it('flags an upward crossing of a $25k increment', () => {
        const out = detectNetWorthMilestone(24_000, 26_000);
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('info');
        expect(out[0].title).toContain('25,000');
        expect(out[0].dedupeKey).toBe('net-worth-milestone:up:25000');
    });

    it('flags a downward crossing as a warning', () => {
        const out = detectNetWorthMilestone(26_000, 24_000);
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('warning');
        expect(out[0].dedupeKey).toBe('net-worth-milestone:down:25000');
    });

    it('reports every milestone crossed in a large move', () => {
        const out = detectNetWorthMilestone(24_000, 80_000);
        expect(out.map(i => i.dedupeKey)).toEqual([
            'net-worth-milestone:up:25000',
            'net-worth-milestone:up:50000',
            'net-worth-milestone:up:75000',
        ]);
    });

    it('stays quiet within a bracket or exactly on a milestone already held', () => {
        expect(detectNetWorthMilestone(26_000, 27_000)).toEqual([]);
        expect(detectNetWorthMilestone(25_000, 26_000)).toEqual([]); // already at/above 25k
        expect(detectNetWorthMilestone(30_000, 30_000)).toEqual([]);
    });

    it('never emits non-positive milestones', () => {
        const out = detectNetWorthMilestone(-30_000, 10_000);
        expect(out).toEqual([]); // only crossings at 0 and below → suppressed
    });
});

/* ------------------------------------------------------------------ */
/* detectBalanceDrops                                                  */
/* ------------------------------------------------------------------ */

describe('detectBalanceDrops', () => {
    it('flags cash accounts down more than 30% week-over-week', () => {
        const out = detectBalanceDrops(WEEK, [
            { guid: 'chk', name: 'Checking', current: 600, weekAgo: 1000 }, // -40%
            { guid: 'sav', name: 'Savings', current: 900, weekAgo: 1000 },  // -10%
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].title).toContain('Checking');
        expect(out[0].severity).toBe('warning');
        expect(out[0].href).toBe('/accounts/chk');
    });

    it('escalates to critical past a 60% drop', () => {
        const out = detectBalanceDrops(WEEK, [
            { guid: 'chk', name: 'Checking', current: 350, weekAgo: 1000 }, // -65%
        ]);
        expect(out[0].severity).toBe('critical');
    });

    it('is quiet at the 30% boundary and for tiny prior balances', () => {
        expect(
            detectBalanceDrops(WEEK, [
                { guid: 'a', name: 'A', current: 700, weekAgo: 1000 }, // exactly -30%
                { guid: 'b', name: 'B', current: 5, weekAgo: BALANCE_DROP_MIN_PRIOR - 1 },
            ])
        ).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* Dedupe-key stability                                                */
/* ------------------------------------------------------------------ */

describe('dedupe keys', () => {
    it('are stable across runs for identical inputs', () => {
        const run = () =>
            computeInsights({
                month: MONTH,
                weekKey: WEEK,
                currency: 'USD',
                categories: [{ name: 'Dining Out!', current: 400, priorMonths: [300, 290, 310] }],
                newMerchants: [{ description: 'REI  Co-op', firstDate: '2026-07-03', firstAmount: 250 }],
                savingsRate: { current: 5, priorRates: [20, 22, 18, 21] },
                netWorth: { previous: 24_000, current: 26_000 },
                cashBalances: [{ guid: 'chk', name: 'Checking', current: 600, weekAgo: 1000 }],
            } satisfies InsightSource);

        const a = run().map(i => i.dedupeKey);
        const b = run().map(i => i.dedupeKey);
        expect(a).toEqual(b);
        expect(a).toEqual([
            'category-spike:2026-07:dining-out',
            'new-merchant:rei-co-op',
            'savings-rate:2026-07',
            'net-worth-milestone:up:25000',
            'balance-drop:chk:2026-W28',
        ]);
    });

    it('vary by month for the monthly detectors', () => {
        const series = [{ name: 'Dining', current: 400, priorMonths: [300, 290, 310] }];
        expect(detectCategorySpike('2026-07', series)[0].dedupeKey).not.toBe(
            detectCategorySpike('2026-08', series)[0].dedupeKey
        );
    });

    it('isoWeekKey is stable within an ISO week and changes across weeks', () => {
        // 2026-07-06 (Mon) .. 2026-07-12 (Sun) share a week
        expect(isoWeekKey(new Date(Date.UTC(2026, 6, 6)))).toBe(
            isoWeekKey(new Date(Date.UTC(2026, 6, 12)))
        );
        expect(isoWeekKey(new Date(Date.UTC(2026, 6, 12)))).not.toBe(
            isoWeekKey(new Date(Date.UTC(2026, 6, 13)))
        );
    });
});

/* ------------------------------------------------------------------ */
/* Dismiss filtering                                                   */
/* ------------------------------------------------------------------ */

describe('filterInsights', () => {
    const rows = [
        { id: 1, dismissedAt: null },
        { id: 2, dismissedAt: '2026-07-10T00:00:00.000Z' },
        { id: 3, dismissedAt: null },
    ];

    it('hides dismissed rows by default', () => {
        expect(filterInsights(rows).map(r => r.id)).toEqual([1, 3]);
    });

    it('includes dismissed rows when asked', () => {
        expect(filterInsights(rows, { includeDismissed: true }).map(r => r.id)).toEqual([1, 2, 3]);
    });
});

/* ------------------------------------------------------------------ */
/* AI polish (batched, fallback-safe)                                  */
/* ------------------------------------------------------------------ */

describe('polishInsights', () => {
    const candidates: InsightCandidate[] = [
        {
            kind: 'category-spike',
            severity: 'info',
            title: 'Dining spending is up 33%',
            detail: 'Template detail.',
            href: '/tools/digest',
            dedupeKey: 'category-spike:2026-07:dining',
        },
        {
            kind: 'new-merchant',
            severity: 'info',
            title: 'New merchant: Peloton',
            detail: 'Template detail 2.',
            href: '/ledger',
            dedupeKey: 'new-merchant:peloton',
        },
    ];

    it('applies rewritten titles/details from one batched reply', async () => {
        const out = await polishInsights(candidates, async () =>
            JSON.stringify({
                items: [
                    { i: 0, title: 'Dining out jumped a third this month', detail: 'Nicer words.' },
                    { i: 1, title: 'First Peloton charge spotted', detail: 'Nicer words 2.' },
                ],
            })
        );
        expect(out[0].title).toBe('Dining out jumped a third this month');
        expect(out[1].detail).toBe('Nicer words 2.');
        // Everything else (kind, severity, dedupe key, href) is untouched.
        expect(out[0].dedupeKey).toBe(candidates[0].dedupeKey);
        expect(out[1].href).toBe('/ledger');
    });

    it('falls back to the template text on a broken reply', async () => {
        expect(await polishInsights(candidates, async () => 'not json at all')).toEqual(candidates);
        expect(
            await polishInsights(candidates, async () => JSON.stringify({ items: 'nope' }))
        ).toEqual(candidates);
    });

    it('falls back when the chat call throws', async () => {
        const out = await polishInsights(candidates, async () => {
            throw new Error('AI API error: 500');
        });
        expect(out).toEqual(candidates);
    });

    it('ignores out-of-range or malformed items but keeps valid ones', async () => {
        const out = await polishInsights(candidates, async () =>
            JSON.stringify({
                items: [
                    { i: 99, title: 'x', detail: 'y' },
                    { i: 1, title: '', detail: 'Only the detail changed.' },
                    null,
                ],
            })
        );
        expect(out[0]).toEqual(candidates[0]);
        expect(out[1].title).toBe(candidates[1].title); // empty title rejected
        expect(out[1].detail).toBe('Only the detail changed.');
    });
});
