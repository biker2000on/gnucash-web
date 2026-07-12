/**
 * Digest narrative tests: prompt-payload builder (numbers included, list
 * caps) and null-on-failure behavior of generateDigestNarrative.
 * Pure — the AI client is injected as a fake.
 */

import { describe, it, expect } from 'vitest';
import {
    buildNarrativePayload,
    buildNarrativeMessages,
    sanitizeNarrative,
    generateDigestNarrative,
    MAX_NARRATIVE_CATEGORIES,
    MAX_NARRATIVE_SUBSCRIPTIONS,
    MAX_NARRATIVE_LENGTH,
} from '../digest-narrative';
import type { MonthlyDigest, DigestCategory, DigestSubscription } from '../digest';

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

function mkCategory(i: number): DigestCategory {
    return {
        name: `Category ${i}`,
        amount: 100 + i,
        priorAmount: 90 + i,
        delta: 10,
        percent: 11.11,
    };
}

function mkSub(i: number): DigestSubscription {
    return {
        label: `Service ${i}`,
        accountName: 'Expenses:Subscriptions',
        cadence: 'monthly',
        currentAmount: 9.99 + i,
        previousAmount: 9.99,
        changePercent: 10,
        lastSeen: '2026-07-01',
        nextExpected: '2026-08-01',
    };
}

function mkDigest(overrides: Partial<MonthlyDigest> = {}): MonthlyDigest {
    return {
        month: '2026-07',
        monthLabel: 'July 2026',
        generatedAt: '2026-07-12T00:00:00.000Z',
        currency: 'USD',
        netWorth: { end: 123456.78, change: 2345.67, changePercent: 1.94 },
        cashFlow: { income: 8000, expenses: 5500.25, savingsRate: 31.25 },
        topCategories: [mkCategory(1), mkCategory(2)],
        subscriptions: { new: [mkSub(1)], changed: [], stopped: [] },
        upcomingBills: [],
        budget: {
            budgetName: 'Household',
            periodNum: 6,
            rows: [
                { accountGuid: 'a1', accountName: 'Food', budgeted: 500, actual: 620, variance: -120, status: 'over' },
                { accountGuid: 'a2', accountName: 'Fuel', budgeted: 200, actual: 150, variance: 50, status: 'under' },
            ],
            totalBudgeted: 700,
            totalActual: 770,
            outOfRange: false,
        },
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/* buildNarrativePayload                                               */
/* ------------------------------------------------------------------ */

describe('buildNarrativePayload', () => {
    it('carries the digest numbers through verbatim (rounded to 2 dp)', () => {
        const payload = buildNarrativePayload(mkDigest());
        expect(payload.netWorth).toEqual({ end: 123456.78, change: 2345.67, changePercent: 1.94 });
        expect(payload.cashFlow).toEqual({ income: 8000, expenses: 5500.25, savingsRate: 31.25 });
        expect(payload.topCategories[0]).toEqual({
            name: 'Category 1',
            amount: 101,
            delta: 10,
            percent: 11.11,
        });
        expect(payload.budget).toEqual({
            name: 'Household',
            overCount: 1,
            underCount: 1,
            totalBudgeted: 700,
            totalActual: 770,
        });
        expect(payload.currency).toBe('USD');
        expect(payload.month).toBe('July 2026');
    });

    it('caps category and subscription list lengths', () => {
        const digest = mkDigest({
            topCategories: Array.from({ length: 9 }, (_, i) => mkCategory(i)),
            subscriptions: {
                new: Array.from({ length: 7 }, (_, i) => mkSub(i)),
                changed: Array.from({ length: 6 }, (_, i) => ({ ...mkSub(i), direction: 'up' as const })),
                stopped: Array.from({ length: 5 }, (_, i) => mkSub(i)),
            },
        });
        const payload = buildNarrativePayload(digest);
        expect(payload.topCategories).toHaveLength(MAX_NARRATIVE_CATEGORIES);
        expect(payload.subscriptions.new).toHaveLength(MAX_NARRATIVE_SUBSCRIPTIONS);
        expect(payload.subscriptions.changed).toHaveLength(MAX_NARRATIVE_SUBSCRIPTIONS);
        expect(payload.subscriptions.stopped).toHaveLength(MAX_NARRATIVE_SUBSCRIPTIONS);
    });

    it('handles a missing budget', () => {
        const payload = buildNarrativePayload(mkDigest({ budget: null }));
        expect(payload.budget).toBeNull();
    });

    it('truncates long names so the payload stays compact', () => {
        const digest = mkDigest({
            topCategories: [{ ...mkCategory(1), name: 'X'.repeat(200) }],
        });
        const payload = buildNarrativePayload(digest);
        expect(payload.topCategories[0].name).toHaveLength(60);
    });
});

/* ------------------------------------------------------------------ */
/* buildNarrativeMessages                                              */
/* ------------------------------------------------------------------ */

describe('buildNarrativeMessages', () => {
    it('produces a system rule-set and a JSON user payload containing the numbers', () => {
        const [system, user] = buildNarrativeMessages(mkDigest());
        expect(system.role).toBe('system');
        expect(system.content).toMatch(/3 to 5 sentences/);
        expect(system.content).toMatch(/no advice/i);
        expect(user.role).toBe('user');
        const parsed = JSON.parse(user.content);
        expect(parsed.netWorth.change).toBe(2345.67);
        expect(parsed.cashFlow.savingsRate).toBe(31.25);
    });
});

/* ------------------------------------------------------------------ */
/* sanitizeNarrative                                                   */
/* ------------------------------------------------------------------ */

describe('sanitizeNarrative', () => {
    it('trims and strips markdown fences', () => {
        expect(sanitizeNarrative('```\nA fine month.\n```')).toBe('A fine month.');
        expect(sanitizeNarrative('  Plain text.  ')).toBe('Plain text.');
    });

    it('rejects empty, JSON-shaped, and heading-shaped replies', () => {
        expect(sanitizeNarrative('')).toBeNull();
        expect(sanitizeNarrative('   ')).toBeNull();
        expect(sanitizeNarrative('{"narrative": "hi"}')).toBeNull();
        expect(sanitizeNarrative('[1,2]')).toBeNull();
        expect(sanitizeNarrative('# Summary')).toBeNull();
    });

    it('caps absurdly long replies', () => {
        const long = 'a'.repeat(MAX_NARRATIVE_LENGTH + 500);
        const result = sanitizeNarrative(long);
        expect(result).not.toBeNull();
        expect(result!.length).toBeLessThanOrEqual(MAX_NARRATIVE_LENGTH);
    });
});

/* ------------------------------------------------------------------ */
/* generateDigestNarrative                                             */
/* ------------------------------------------------------------------ */

describe('generateDigestNarrative', () => {
    it('returns { narrative } on a clean reply', async () => {
        const result = await generateDigestNarrative(mkDigest(), async () =>
            'Net worth rose by $2,345.67 in July 2026. Income was $8,000 against $5,500.25 of expenses.'
        );
        expect(result).toEqual({
            narrative:
                'Net worth rose by $2,345.67 in July 2026. Income was $8,000 against $5,500.25 of expenses.',
        });
    });

    it('returns null when the client throws (network / timeout / API error)', async () => {
        const result = await generateDigestNarrative(mkDigest(), async () => {
            throw new Error('AI API error: 502');
        });
        expect(result).toBeNull();
    });

    it('returns null when the reply is unusable', async () => {
        expect(await generateDigestNarrative(mkDigest(), async () => '')).toBeNull();
        expect(await generateDigestNarrative(mkDigest(), async () => '{"oops": true}')).toBeNull();
    });

    it('never rejects even for a synchronously-throwing client', async () => {
        const bad = (() => {
            throw new Error('boom');
        }) as unknown as Parameters<typeof generateDigestNarrative>[1];
        await expect(generateDigestNarrative(mkDigest(), bad)).resolves.toBeNull();
    });
});
