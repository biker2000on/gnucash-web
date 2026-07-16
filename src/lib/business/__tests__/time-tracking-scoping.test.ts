/**
 * Timekeeper scoping in the time-tracking service (mocked prisma).
 *
 * - listTimeEntries with a userId option filters the query to that user.
 * - Scoped single-entry operations treat another user's entry as NOT FOUND
 *   (404 semantics — a timekeeper must never learn a foreign id exists).
 * - Unscoped calls (edit/admin) still reach other users' entries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { timeEntries, customers, jobs, users } = vi.hoisted(() => ({
    timeEntries: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
    customers: { findMany: vi.fn(), findUnique: vi.fn() },
    jobs: { findMany: vi.fn(), findUnique: vi.fn() },
    users: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_time_entries: timeEntries,
        customers,
        jobs,
        gnucash_web_users: users,
    },
}));

import {
    listTimeEntries,
    getTimeEntry,
    updateTimeEntry,
    deleteTimeEntry,
    TimeTrackingNotFoundError,
} from '../time-tracking.service';

const BOOK = 'b'.repeat(32);

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: 7,
        book_guid: BOOK,
        user_id: 2, // owned by user 2
        customer_guid: null,
        job_guid: null,
        entry_date: new Date('2026-07-13T00:00:00Z'),
        minutes: 60,
        rate: null,
        description: 'work',
        billable: true,
        invoiced_invoice_guid: null,
        timer_started_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    timeEntries.findMany.mockResolvedValue([]);
    customers.findMany.mockResolvedValue([]);
    jobs.findMany.mockResolvedValue([]);
    users.findMany.mockResolvedValue([]);
});

describe('listTimeEntries user scoping', () => {
    it('filters by user_id when the userId option is set (timekeeper path)', async () => {
        await listTimeEntries(BOOK, { userId: 1 });
        expect(timeEntries.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ book_guid: BOOK, user_id: 1 }),
            }),
        );
    });

    it('does not filter by user when no userId option is given (edit/admin path)', async () => {
        await listTimeEntries(BOOK, {});
        const where = timeEntries.findMany.mock.calls[0][0].where;
        expect(where).not.toHaveProperty('user_id');
    });

    it('attributes entries with the owning username', async () => {
        timeEntries.findMany.mockResolvedValue([row({ user_id: 2 })]);
        users.findMany.mockResolvedValue([{ id: 2, username: 'alice' }]);
        const entries = await listTimeEntries(BOOK, {});
        expect(entries[0].userId).toBe(2);
        expect(entries[0].username).toBe('alice');
    });
});

describe('single-entry scoping (own entries only for timekeepers)', () => {
    it("getTimeEntry returns null for another user's entry when scoped", async () => {
        timeEntries.findUnique.mockResolvedValue(row({ user_id: 2 }));
        expect(await getTimeEntry(BOOK, 7, { userId: 1 })).toBeNull();
        // Unscoped (edit/admin) still sees it
        expect(await getTimeEntry(BOOK, 7)).not.toBeNull();
        // The owner sees their own entry
        expect(await getTimeEntry(BOOK, 7, { userId: 2 })).not.toBeNull();
    });

    it("updateTimeEntry throws NotFound for another user's entry when scoped", async () => {
        timeEntries.findUnique.mockResolvedValue(row({ user_id: 2 }));
        await expect(updateTimeEntry(BOOK, 7, { minutes: 30 }, { userId: 1 }))
            .rejects.toBeInstanceOf(TimeTrackingNotFoundError);
        expect(timeEntries.update).not.toHaveBeenCalled();
    });

    it('updateTimeEntry succeeds for the owning user when scoped', async () => {
        timeEntries.findUnique.mockResolvedValue(row({ user_id: 1 }));
        timeEntries.update.mockResolvedValue(row({ user_id: 1, minutes: 30 }));
        const updated = await updateTimeEntry(BOOK, 7, { minutes: 30 }, { userId: 1 });
        expect(updated.minutes).toBe(30);
        expect(timeEntries.update).toHaveBeenCalled();
    });

    it("deleteTimeEntry throws NotFound for another user's entry when scoped", async () => {
        timeEntries.findUnique.mockResolvedValue(row({ user_id: 2 }));
        await expect(deleteTimeEntry(BOOK, 7, { userId: 1 }))
            .rejects.toBeInstanceOf(TimeTrackingNotFoundError);
        expect(timeEntries.delete).not.toHaveBeenCalled();
    });

    it('deleteTimeEntry (unscoped, edit/admin) can delete any user entry', async () => {
        timeEntries.findUnique.mockResolvedValue(row({ user_id: 2 }));
        timeEntries.delete.mockResolvedValue(row({ user_id: 2 }));
        await deleteTimeEntry(BOOK, 7);
        expect(timeEntries.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    });

    it('a legacy entry with NULL user_id is not visible to a scoped caller', async () => {
        timeEntries.findUnique.mockResolvedValue(row({ user_id: null }));
        expect(await getTimeEntry(BOOK, 7, { userId: 1 })).toBeNull();
        await expect(deleteTimeEntry(BOOK, 7, { userId: 1 }))
            .rejects.toBeInstanceOf(TimeTrackingNotFoundError);
    });
});
