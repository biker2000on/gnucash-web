import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryRawMock, txFindUniqueMock } = vi.hoisted(() => ({
    queryRawMock: vi.fn(),
    txFindUniqueMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: queryRawMock,
        transactions: { findUnique: txFindUniqueMock },
        books: { findFirst: vi.fn() },
    },
}));

import {
    PeriodLockedError,
    findLockedDate,
    assertNotLocked,
    assertTxnMutable,
    getCachedLockDate,
    invalidatePeriodLockCache,
    toIsoDateString,
} from '../period-lock.service';

const BOOK = 'b'.repeat(32);

/** Seed the lock-date lookup ($queryRaw against gnucash_web_book_settings). */
function seedLockDate(lockDate: string | null) {
    queryRawMock.mockResolvedValue(lockDate === null ? [] : [{ lock_date: lockDate }]);
}

beforeEach(() => {
    queryRawMock.mockReset();
    txFindUniqueMock.mockReset();
    invalidatePeriodLockCache();
});

describe('findLockedDate boundary rule', () => {
    it('blocks a date exactly on the lock date', () => {
        expect(findLockedDate('2026-06-30', ['2026-06-30'])).toBe('2026-06-30');
    });

    it('allows the day after the lock date', () => {
        expect(findLockedDate('2026-06-30', ['2026-07-01'])).toBeNull();
    });

    it('blocks dates before the lock date', () => {
        expect(findLockedDate('2026-06-30', ['2026-01-15'])).toBe('2026-01-15');
    });

    it('passes everything when no lock date is set', () => {
        expect(findLockedDate(null, ['1990-01-01', '2026-06-30'])).toBeNull();
    });

    it('skips null/undefined dates (e.g. template transactions)', () => {
        expect(findLockedDate('2026-06-30', [null, undefined])).toBeNull();
        expect(findLockedDate('2026-06-30', [null, '2026-06-30'])).toBe('2026-06-30');
    });

    it('handles Date objects (compared by UTC calendar day)', () => {
        // Noon-UTC convention used by importers/posting engines
        expect(findLockedDate('2026-06-30', [new Date('2026-06-30T12:00:00Z')])).toBe('2026-06-30');
        expect(findLockedDate('2026-06-30', [new Date('2026-07-01T12:00:00Z')])).toBeNull();
    });

    it('returns the first locked date among many', () => {
        expect(findLockedDate('2026-06-30', ['2026-07-05', '2026-06-01', '2026-05-01'])).toBe('2026-06-01');
    });
});

describe('toIsoDateString', () => {
    it('slices full ISO strings and formats Dates in UTC', () => {
        expect(toIsoDateString('2026-06-30T23:59:59Z')).toBe('2026-06-30');
        expect(toIsoDateString(new Date('2026-06-30T00:00:00Z'))).toBe('2026-06-30');
    });
});

describe('assertNotLocked', () => {
    it('throws PeriodLockedError with the lock date when a date is locked', async () => {
        seedLockDate('2026-06-30');
        await expect(assertNotLocked(BOOK, ['2026-06-30'])).rejects.toMatchObject({
            code: 'PERIOD_LOCKED',
            lockDate: '2026-06-30',
        });
        await expect(assertNotLocked(BOOK, ['2026-06-15'])).rejects.toBeInstanceOf(PeriodLockedError);
    });

    it('resolves when every date is after the lock date', async () => {
        seedLockDate('2026-06-30');
        await expect(assertNotLocked(BOOK, ['2026-07-01', new Date('2026-08-15T12:00:00Z')]))
            .resolves.toBeUndefined();
    });

    it('resolves when the book has no lock date row', async () => {
        seedLockDate(null);
        await expect(assertNotLocked(BOOK, ['1990-01-01'])).resolves.toBeUndefined();
    });

    it('carries the spec error message', async () => {
        seedLockDate('2026-06-30');
        await expect(assertNotLocked(BOOK, ['2026-06-01'])).rejects.toThrow(
            'Period locked: transactions on or before 2026-06-30 are closed',
        );
    });
});

describe('assertTxnMutable', () => {
    it('throws when the transaction is dated on/before the lock date', async () => {
        seedLockDate('2026-06-30');
        txFindUniqueMock.mockResolvedValue({ post_date: new Date('2026-06-30T12:00:00Z') });
        await expect(assertTxnMutable(BOOK, 't'.repeat(32))).rejects.toBeInstanceOf(PeriodLockedError);
    });

    it('passes when the transaction is after the lock date', async () => {
        seedLockDate('2026-06-30');
        txFindUniqueMock.mockResolvedValue({ post_date: new Date('2026-07-01T12:00:00Z') });
        await expect(assertTxnMutable(BOOK, 't'.repeat(32))).resolves.toBeUndefined();
    });

    it('passes for missing transactions (caller handles 404)', async () => {
        seedLockDate('2026-06-30');
        txFindUniqueMock.mockResolvedValue(null);
        await expect(assertTxnMutable(BOOK, 't'.repeat(32))).resolves.toBeUndefined();
    });

    it('skips the transaction lookup entirely when no lock is set', async () => {
        seedLockDate(null);
        await expect(assertTxnMutable(BOOK, 't'.repeat(32))).resolves.toBeUndefined();
        expect(txFindUniqueMock).not.toHaveBeenCalled();
    });
});

describe('getCachedLockDate caching', () => {
    it('caches the lock date per book within the TTL', async () => {
        seedLockDate('2026-06-30');
        expect(await getCachedLockDate(BOOK)).toBe('2026-06-30');
        expect(await getCachedLockDate(BOOK)).toBe('2026-06-30');
        expect(queryRawMock).toHaveBeenCalledTimes(1);
    });

    it('re-queries after invalidation', async () => {
        seedLockDate('2026-06-30');
        await getCachedLockDate(BOOK);
        invalidatePeriodLockCache(BOOK);
        seedLockDate('2026-07-31');
        expect(await getCachedLockDate(BOOK)).toBe('2026-07-31');
        expect(queryRawMock).toHaveBeenCalledTimes(2);
    });

    it('normalizes Postgres DATE values (JS Date at UTC midnight)', async () => {
        queryRawMock.mockResolvedValue([{ lock_date: new Date('2026-06-30T00:00:00Z') }]);
        expect(await getCachedLockDate(BOOK)).toBe('2026-06-30');
    });
});
