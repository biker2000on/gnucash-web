import { describe, it, expect, vi, beforeEach } from 'vitest';

// The service imports prisma at module level; mock it so pure helpers can be
// imported without a DB, and so the CRUD tests can drive row responses.
const { renewalsTable, entityDocs } = vi.hoisted(() => ({
    renewalsTable: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
    },
    entityDocs: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
    },
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_renewals: renewalsTable,
        gnucash_web_entity_documents: entityDocs,
    },
}));

import {
    addMonthsClamped,
    advanceRenewalDate,
    daysUntil,
    isReminderDue,
    renewalReminderSourceId,
    subscriptionCadenceToMonths,
    defaultRemindDays,
    subscriptionToRenewalCandidate,
    parseRenewalInput,
    listRenewals,
    createRenewal,
    updateRenewal,
    RenewalError,
} from '../renewals.service';

describe('addMonthsClamped', () => {
    it('adds simple months', () => {
        expect(addMonthsClamped('2026-03-15', 1)).toBe('2026-04-15');
        expect(addMonthsClamped('2026-03-15', 12)).toBe('2027-03-15');
    });

    it('clamps to the target month end', () => {
        expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
        expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29'); // leap year
        expect(addMonthsClamped('2026-08-31', 1)).toBe('2026-09-30');
    });

    it('rolls over year boundaries', () => {
        expect(addMonthsClamped('2026-11-15', 3)).toBe('2027-02-15');
        expect(addMonthsClamped('2026-12-31', 2)).toBe('2027-02-28');
    });
});

describe('advanceRenewalDate', () => {
    it('advances one cadence for a future-dated renewal', () => {
        expect(advanceRenewalDate('2026-08-01', 12, '2026-07-16')).toBe('2027-08-01');
    });

    it('advances a renewal due today into the future', () => {
        expect(advanceRenewalDate('2026-07-16', 1, '2026-07-16')).toBe('2026-08-16');
    });

    it('keeps advancing a long-overdue renewal until it is in the future', () => {
        // Overdue by ~7 months at monthly cadence: single hop would still be past.
        expect(advanceRenewalDate('2026-01-10', 1, '2026-07-16')).toBe('2026-08-10');
        // Annual, one hop suffices
        expect(advanceRenewalDate('2025-06-01', 12, '2026-07-16')).toBe('2027-06-01');
    });

    it('treats non-positive cadence as 1 month', () => {
        expect(advanceRenewalDate('2026-07-01', 0, '2026-07-16')).toBe('2026-08-01');
    });
});

describe('daysUntil', () => {
    it('counts days forward', () => {
        expect(daysUntil('2026-07-20', '2026-07-16')).toBe(4);
    });
    it('is zero for today', () => {
        expect(daysUntil('2026-07-16', '2026-07-16')).toBe(0);
    });
    it('is negative when overdue', () => {
        expect(daysUntil('2026-07-10', '2026-07-16')).toBe(-6);
    });
    it('handles month boundaries', () => {
        expect(daysUntil('2026-08-01', '2026-07-16')).toBe(16);
    });
});

describe('isReminderDue (reminder window math)', () => {
    const today = '2026-07-16';

    it('due when inside the lead window', () => {
        expect(isReminderDue({ renewalDate: '2026-07-30', remindDays: 14, dismissedUntil: null }, today)).toBe(true);
    });

    it('due exactly at the window boundary', () => {
        expect(isReminderDue({ renewalDate: '2026-07-30', remindDays: 14, dismissedUntil: null }, '2026-07-16')).toBe(true);
    });

    it('not due when outside the window', () => {
        expect(isReminderDue({ renewalDate: '2026-07-31', remindDays: 14, dismissedUntil: null }, today)).toBe(false);
    });

    it('due on the renewal day and when overdue', () => {
        expect(isReminderDue({ renewalDate: today, remindDays: 0, dismissedUntil: null }, today)).toBe(true);
        expect(isReminderDue({ renewalDate: '2026-07-01', remindDays: 7, dismissedUntil: null }, today)).toBe(true);
    });

    it('suppressed while dismissed through today or later', () => {
        expect(isReminderDue({ renewalDate: '2026-07-20', remindDays: 14, dismissedUntil: '2026-07-16' }, today)).toBe(false);
        expect(isReminderDue({ renewalDate: '2026-07-20', remindDays: 14, dismissedUntil: '2026-08-01' }, today)).toBe(false);
    });

    it('reactivates after the dismissal lapses', () => {
        expect(isReminderDue({ renewalDate: '2026-07-20', remindDays: 14, dismissedUntil: '2026-07-15' }, today)).toBe(true);
    });
});

describe('renewalReminderSourceId', () => {
    it('is unique per renewal cycle so advancing the date re-arms reminders', () => {
        const before = renewalReminderSourceId(7, '2026-07-20');
        const after = renewalReminderSourceId(7, '2027-07-20');
        expect(before).toBe('renewal:7:2026-07-20');
        expect(before).not.toBe(after);
    });
});

describe('subscription import mapping', () => {
    const today = '2026-07-16';

    it('maps detection cadences to months (weekly unsupported)', () => {
        expect(subscriptionCadenceToMonths('monthly')).toBe(1);
        expect(subscriptionCadenceToMonths('quarterly')).toBe(3);
        expect(subscriptionCadenceToMonths('annual')).toBe(12);
        expect(subscriptionCadenceToMonths('weekly')).toBeNull();
    });

    it('scales reminder lead with cadence', () => {
        expect(defaultRemindDays(1)).toBe(7);
        expect(defaultRemindDays(3)).toBe(14);
        expect(defaultRemindDays(12)).toBe(30);
    });

    it('builds a candidate from an active series', () => {
        const candidate = subscriptionToRenewalCandidate({
            merchantLabel: 'Netflix.com',
            cadence: 'monthly',
            status: 'active',
            nextExpected: '2026-07-28',
            currentAmount: 15.4900001,
            accountName: 'Expenses:Entertainment:Streaming',
        }, today);
        expect(candidate).toEqual({
            name: 'Netflix.com',
            renewalDate: '2026-07-28',
            amount: 15.49,
            cadenceMonths: 1,
            remindDays: 7,
            notes: 'Detected from spending (Expenses:Entertainment:Streaming)',
        });
    });

    it('advances a stale nextExpected into the future', () => {
        const candidate = subscriptionToRenewalCandidate({
            merchantLabel: 'Insurance Co',
            cadence: 'annual',
            status: 'active',
            nextExpected: '2026-06-01',
            currentAmount: 820,
            accountName: '',
        }, today);
        expect(candidate?.renewalDate).toBe('2027-06-01');
        expect(candidate?.remindDays).toBe(30);
        expect(candidate?.notes).toBe('Detected from spending');
    });

    it('skips stopped and weekly series', () => {
        expect(subscriptionToRenewalCandidate({
            merchantLabel: 'Old Gym',
            cadence: 'monthly',
            status: 'stopped',
            nextExpected: '2026-01-01',
            currentAmount: 30,
            accountName: '',
        }, today)).toBeNull();

        expect(subscriptionToRenewalCandidate({
            merchantLabel: 'Coffee Club',
            cadence: 'weekly',
            status: 'active',
            nextExpected: '2026-07-20',
            currentAmount: 12,
            accountName: '',
        }, today)).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Document vault linking (mocked prisma)                               */
/* ------------------------------------------------------------------ */

const BOOK = 'a'.repeat(32);
const OTHER_BOOK = 'b'.repeat(32);

function renewalRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        book_guid: BOOK,
        name: 'Auto insurance',
        renewal_date: new Date('2026-09-01T00:00:00Z'),
        amount: null,
        cadence_months: 12,
        remind_days: 30,
        source: 'manual',
        notes: null,
        dismissed_until: null,
        document_id: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

describe('parseRenewalInput documentId', () => {
    it('accepts a positive integer id', () => {
        expect(parseRenewalInput({ documentId: 12 }, { partial: true })).toEqual({ documentId: 12 });
        expect(parseRenewalInput({ documentId: '12' }, { partial: true })).toEqual({ documentId: 12 });
    });

    it('treats null and empty string as clearing the link', () => {
        expect(parseRenewalInput({ documentId: null }, { partial: true })).toEqual({ documentId: null });
        expect(parseRenewalInput({ documentId: '' }, { partial: true })).toEqual({ documentId: null });
    });

    it('leaves documentId untouched when absent', () => {
        expect(parseRenewalInput({ notes: 'x' }, { partial: true })).not.toHaveProperty('documentId');
    });

    it('rejects non-integer and non-positive ids', () => {
        expect(() => parseRenewalInput({ documentId: 0 }, { partial: true })).toThrow(RenewalError);
        expect(() => parseRenewalInput({ documentId: -3 }, { partial: true })).toThrow(RenewalError);
        expect(() => parseRenewalInput({ documentId: 1.5 }, { partial: true })).toThrow(RenewalError);
        expect(() => parseRenewalInput({ documentId: 'abc' }, { partial: true })).toThrow(RenewalError);
    });
});

describe('document linking round-trip (mocked prisma)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        entityDocs.findMany.mockResolvedValue([]);
    });

    it('createRenewal stores document_id after confirming the doc is in the book', async () => {
        entityDocs.findFirst.mockResolvedValue({ id: 42 });
        renewalsTable.create.mockResolvedValue(renewalRow({ document_id: 42 }));
        entityDocs.findMany.mockResolvedValue([{ id: 42, title: 'Policy PDF', file_name: 'policy.pdf' }]);

        const renewal = await createRenewal(BOOK, {
            name: 'Auto insurance',
            renewalDate: '2026-09-01',
            documentId: 42,
        });

        expect(entityDocs.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 42, book_guid: BOOK } }),
        );
        expect(renewalsTable.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ document_id: 42 }) }),
        );
        expect(renewal.documentId).toBe(42);
        expect(renewal.documentTitle).toBe('Policy PDF');
        expect(renewal.documentFileName).toBe('policy.pdf');
    });

    it('createRenewal rejects a document from another book', async () => {
        // Cross-book lookup misses because the where clause pins book_guid.
        entityDocs.findFirst.mockResolvedValue(null);

        await expect(createRenewal(OTHER_BOOK, {
            name: 'Auto insurance',
            renewalDate: '2026-09-01',
            documentId: 42,
        })).rejects.toThrow('Linked document not found in this book');
        expect(renewalsTable.create).not.toHaveBeenCalled();
    });

    it('updateRenewal sets a validated link and clears it with null', async () => {
        renewalsTable.findFirst.mockResolvedValue(renewalRow());
        entityDocs.findFirst.mockResolvedValue({ id: 7 });
        renewalsTable.update.mockResolvedValue(renewalRow({ document_id: 7 }));
        entityDocs.findMany.mockResolvedValue([{ id: 7, title: 'Contract', file_name: null }]);

        const linked = await updateRenewal(BOOK, 1, { documentId: 7 });
        expect(renewalsTable.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ document_id: 7 }) }),
        );
        expect(linked?.documentId).toBe(7);
        expect(linked?.documentTitle).toBe('Contract');

        // Clearing skips validation and writes null.
        entityDocs.findFirst.mockClear();
        renewalsTable.update.mockResolvedValue(renewalRow({ document_id: null }));
        entityDocs.findMany.mockResolvedValue([]);

        const cleared = await updateRenewal(BOOK, 1, { documentId: null });
        expect(entityDocs.findFirst).not.toHaveBeenCalled();
        expect(renewalsTable.update).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ document_id: null }) }),
        );
        expect(cleared?.documentId).toBeNull();
        expect(cleared?.documentTitle).toBeNull();
    });

    it('updateRenewal rejects a cross-book document without writing', async () => {
        renewalsTable.findFirst.mockResolvedValue(renewalRow());
        entityDocs.findFirst.mockResolvedValue(null);

        await expect(updateRenewal(BOOK, 1, { documentId: 999 })).rejects.toThrow(RenewalError);
        expect(renewalsTable.update).not.toHaveBeenCalled();
    });

    it('listRenewals enriches linked docs with book-scoped metadata', async () => {
        renewalsTable.findMany.mockResolvedValue([
            renewalRow({ id: 1, document_id: 42 }),
            renewalRow({ id: 2, document_id: null, name: 'Domain' }),
        ]);
        entityDocs.findMany.mockResolvedValue([{ id: 42, title: 'Policy PDF', file_name: 'policy.pdf' }]);

        const renewals = await listRenewals(BOOK);

        expect(entityDocs.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: { in: [42] }, book_guid: BOOK }),
            }),
        );
        expect(renewals[0].documentId).toBe(42);
        expect(renewals[0].documentTitle).toBe('Policy PDF');
        expect(renewals[1].documentId).toBeNull();
        expect(renewals[1].documentTitle).toBeNull();
    });

    it('listRenewals leaves a stale link title-less rather than leaking foreign metadata', async () => {
        renewalsTable.findMany.mockResolvedValue([renewalRow({ document_id: 42 })]);
        // Doc 42 exists in another book, so the scoped lookup returns nothing.
        entityDocs.findMany.mockResolvedValue([]);

        const renewals = await listRenewals(BOOK);
        expect(renewals[0].documentId).toBe(42);
        expect(renewals[0].documentTitle).toBeNull();
        expect(renewals[0].documentFileName).toBeNull();
    });
});
