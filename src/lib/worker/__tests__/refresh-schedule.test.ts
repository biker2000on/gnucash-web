/**
 * Price-refresh scheduling: right book, sane clock.
 *
 * Two behaviours are pinned here because both failed silently in production
 * shapes rather than loudly in tests:
 *
 *  - Recovery used to schedule `books.findFirst()`, so on any deployment with
 *    more than one book the timer could land on a book the user is not
 *    authorized for while their own book went stale. Book selection must come
 *    from the membership helper.
 *
 *  - A malformed stored time produced a NaN delay. `setTimeout(fn, NaN)` runs
 *    the callback immediately, which reschedules, which runs immediately --
 *    a hot loop. Malformed times must be rejected before they reach a timer.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    DEFAULT_REFRESH_TIME,
    msUntilNextUtcTime,
    normalizeRefreshTime,
    resolvePriceRefreshTargets,
    type RefreshScheduleSources,
} from '@/lib/worker/refresh-schedule';

/**
 * A multi-book deployment. Alice is authorized on her own book only; the other
 * two books exist and would be plausible `findFirst()` winners.
 */
const BOOKS_BY_USER: Record<number, { guid: string }[]> = {
    1: [{ guid: 'book-alice' }],
    2: [{ guid: 'book-bob' }, { guid: 'book-bob-archive' }],
    3: [],
};

function sources(overrides: Partial<RefreshScheduleSources> = {}): RefreshScheduleSources {
    return {
        listRefreshEnabledUserIds: async () => [1],
        readRefreshTime: async () => '06:30',
        listAuthorizedBooks: async (userId: number) => BOOKS_BY_USER[userId] ?? [],
        onSkip: () => {},
        ...overrides,
    };
}

describe('normalizeRefreshTime', () => {
    it('accepts a valid 24-hour HH:MM', () => {
        expect(normalizeRefreshTime('00:00')).toBe('00:00');
        expect(normalizeRefreshTime('21:00')).toBe('21:00');
        expect(normalizeRefreshTime('23:59')).toBe('23:59');
        expect(normalizeRefreshTime('  09:15  ')).toBe('09:15');
    });

    it.each([
        ['24:00', 'hour out of range'],
        ['21:60', 'minute out of range'],
        ['9:00', 'unpadded hour'],
        ['21:00:00', 'seconds appended'],
        ['banana', 'not a time at all'],
        ['', 'empty string'],
        ['NaN:NaN', 'literally the failure mode'],
    ])('rejects %s (%s)', (value) => {
        expect(normalizeRefreshTime(value)).toBeNull();
    });

    it.each([[7], [null], [undefined], [{}], [['21:00']], [true]])(
        'rejects the non-string %s that a JSON-encoded preference can yield',
        (value) => {
            expect(normalizeRefreshTime(value)).toBeNull();
        },
    );
});

describe('msUntilNextUtcTime', () => {
    const now = new Date('2026-08-17T10:00:00.000Z');

    it('returns the delay until later today', () => {
        expect(msUntilNextUtcTime('12:30', now)).toBe((2 * 60 + 30) * 60_000);
    });

    it('rolls to tomorrow once the time has passed', () => {
        expect(msUntilNextUtcTime('09:00', now)).toBe(23 * 60 * 60_000);
    });

    it('rolls to tomorrow rather than firing instantly when the time is NOW', () => {
        // A 0ms delay here would fire, reschedule, and fire again immediately.
        expect(msUntilNextUtcTime('10:00', now)).toBe(24 * 60 * 60_000);
    });

    it('returns null -- never NaN -- for a malformed time', () => {
        for (const bad of ['banana', '25:00', '', '9:5']) {
            const ms = msUntilNextUtcTime(bad, now);
            expect(ms).toBeNull();
            expect(Number.isNaN(ms as unknown as number)).toBe(false);
        }
    });

    it('never returns a delay that setTimeout would coerce to 0', () => {
        // Sweep every minute of the day against a fixed clock: any 0 or NaN
        // here is a hot loop in production.
        for (let h = 0; h < 24; h++) {
            for (let m = 0; m < 60; m += 7) {
                const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                const ms = msUntilNextUtcTime(t, now)!;
                expect(ms).toBeGreaterThan(0);
                expect(Number.isFinite(ms)).toBe(true);
            }
        }
    });
});

describe('resolvePriceRefreshTargets — book targeting', () => {
    it("targets the user's OWN authorized book, not an arbitrary one", async () => {
        const listAuthorizedBooks = vi.fn(async (userId: number) => BOOKS_BY_USER[userId] ?? []);

        const targets = await resolvePriceRefreshTargets(sources({ listAuthorizedBooks }));

        expect(targets).toEqual([
            { userId: 1, bookGuid: 'book-alice', refreshTime: '06:30' },
        ]);
        // The decisive assertion: selection was driven by the membership
        // lookup for THIS user, not by a book-table scan.
        expect(listAuthorizedBooks).toHaveBeenCalledWith(1);
        expect(targets.map(t => t.bookGuid)).not.toContain('book-bob');
        expect(targets.map(t => t.bookGuid)).not.toContain('book-bob-archive');
    });

    it('schedules EVERY book a user is authorized for', async () => {
        const targets = await resolvePriceRefreshTargets(
            sources({ listRefreshEnabledUserIds: async () => [2] }),
        );

        expect(targets.map(t => t.bookGuid)).toEqual(['book-bob', 'book-bob-archive']);
    });

    it('keeps each user on their own books when several have refresh enabled', async () => {
        const targets = await resolvePriceRefreshTargets(
            sources({ listRefreshEnabledUserIds: async () => [1, 2] }),
        );

        expect(targets).toEqual([
            { userId: 1, bookGuid: 'book-alice', refreshTime: '06:30' },
            { userId: 2, bookGuid: 'book-bob', refreshTime: '06:30' },
            { userId: 2, bookGuid: 'book-bob-archive', refreshTime: '06:30' },
        ]);
    });

    it('skips a user with no authorized books instead of falling back to any book', async () => {
        const onSkip = vi.fn();
        const targets = await resolvePriceRefreshTargets(
            sources({ listRefreshEnabledUserIds: async () => [3], onSkip }),
        );

        expect(targets).toEqual([]);
        expect(onSkip).toHaveBeenCalledWith(expect.stringContaining('no authorized books'));
    });

    it('claims a shared book once, so two users cannot fight over one timer', async () => {
        const onSkip = vi.fn();
        const targets = await resolvePriceRefreshTargets(
            sources({
                listRefreshEnabledUserIds: async () => [1, 2],
                listAuthorizedBooks: async () => [{ guid: 'book-shared' }],
                onSkip,
            }),
        );

        expect(targets).toEqual([
            { userId: 1, bookGuid: 'book-shared', refreshTime: '06:30' },
        ]);
        expect(onSkip).toHaveBeenCalledWith(expect.stringContaining('already scheduled'));
    });

    it('applies the default time when the preference is unset', async () => {
        const targets = await resolvePriceRefreshTargets(
            sources({ readRefreshTime: async () => null }),
        );

        expect(targets).toEqual([
            { userId: 1, bookGuid: 'book-alice', refreshTime: DEFAULT_REFRESH_TIME },
        ]);
    });
});

describe('resolvePriceRefreshTargets — malformed stored time', () => {
    const MALFORMED: unknown[] = ['banana', '25:99', '9:5', '', 7, true, {}, ['21:00']];

    it.each(MALFORMED.map(v => [JSON.stringify(v) ?? String(v), v]))(
        'produces NO schedule for stored value %s',
        async (_label, stored) => {
            const onSkip = vi.fn();
            const targets = await resolvePriceRefreshTargets(
                sources({ readRefreshTime: async () => stored, onSkip }),
            );

            // No target means no timer means nothing to spin.
            expect(targets).toEqual([]);
            expect(onSkip).toHaveBeenCalledTimes(1);
            expect(onSkip).toHaveBeenCalledWith(expect.stringContaining('not a valid HH:MM'));
        },
    );

    it('never yields a target whose time would produce a NaN delay', async () => {
        // The runaway-scheduling proof, end to end: whatever survives
        // resolution must produce a strictly positive, finite delay.
        const now = new Date('2026-08-17T10:00:00.000Z');

        for (const stored of [...MALFORMED, '06:30', null, undefined]) {
            const targets = await resolvePriceRefreshTargets(
                sources({ readRefreshTime: async () => stored }),
            );

            for (const target of targets) {
                const ms = msUntilNextUtcTime(target.refreshTime, now);
                expect(ms).not.toBeNull();
                expect(Number.isFinite(ms!)).toBe(true);
                expect(ms!).toBeGreaterThan(0);
            }
        }
    });

    it('skips only the offending user, leaving the rest scheduled', async () => {
        const targets = await resolvePriceRefreshTargets(
            sources({
                listRefreshEnabledUserIds: async () => [1, 2],
                readRefreshTime: async (userId: number) => (userId === 1 ? '99:99' : '06:30'),
            }),
        );

        expect(targets.map(t => t.userId)).toEqual([2, 2]);
    });

    it('does not let one failing lookup wipe out recovery for everyone', async () => {
        const onSkip = vi.fn();
        const targets = await resolvePriceRefreshTargets(
            sources({
                listRefreshEnabledUserIds: async () => [1, 2],
                listAuthorizedBooks: async (userId: number) => {
                    if (userId === 1) throw new Error('permission lookup exploded');
                    return BOOKS_BY_USER[userId];
                },
                onSkip,
            }),
        );

        expect(targets.map(t => t.bookGuid)).toEqual(['book-bob', 'book-bob-archive']);
        expect(onSkip).toHaveBeenCalledWith(expect.stringContaining('permission lookup exploded'));
    });
});
