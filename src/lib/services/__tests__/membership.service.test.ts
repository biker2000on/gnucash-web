import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addDays } from '@/lib/membership';

const { members, types, payments, meetings, attendance } = vi.hoisted(() => {
    const model = (...methods: string[]) =>
        Object.fromEntries(methods.map(m => [m, vi.fn()]));
    return {
        members: model('findUnique', 'findMany', 'create', 'update', 'delete', 'count', 'groupBy'),
        types: model('findUnique', 'findMany', 'create', 'update', 'delete'),
        payments: model('findUnique', 'findMany', 'create', 'delete', 'count', 'aggregate'),
        meetings: model('findUnique', 'findMany', 'create', 'update', 'delete'),
        attendance: model('deleteMany', 'createMany'),
    };
});

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_members: members,
        gnucash_web_membership_types: types,
        gnucash_web_membership_payments: payments,
        gnucash_web_meetings: meetings,
        gnucash_web_meeting_attendance: attendance,
        $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    },
}));

import {
    isoDate,
    parseDate,
    derivePaidThrough,
    resolvePaymentPeriod,
    parseInput,
    paymentInputSchema,
    recordPayment,
    deleteMembershipType,
    listMembers,
    MembershipValidationError,
} from '../membership.service';

const BOOK = 'b'.repeat(32);
const OTHER_BOOK = 'c'.repeat(32);

function resetAll() {
    for (const model of [members, types, payments, meetings, attendance]) {
        for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset();
    }
}

beforeEach(resetAll);

// ============================================
// Pure helpers
// ============================================

describe('isoDate / parseDate', () => {
    it('round-trips an ISO date through a UTC-midnight Date', () => {
        expect(isoDate(parseDate('2026-03-15'))).toBe('2026-03-15');
        expect(isoDate(parseDate('2026-12-31'))).toBe('2026-12-31');
    });

    it('passes strings through, truncating to the date part', () => {
        expect(isoDate('2026-07-04T12:34:56Z')).toBe('2026-07-04');
    });
});

describe('derivePaidThrough', () => {
    it('returns null / no-lifetime for a member with no payments', () => {
        expect(derivePaidThrough([])).toEqual({ paidThrough: null, hasLifetime: false });
    });

    it('takes the max period_end across payments', () => {
        const result = derivePaidThrough([
            parseDate('2024-12-31'),
            parseDate('2026-12-31'),
            parseDate('2025-12-31'),
        ]);
        expect(result).toEqual({ paidThrough: '2026-12-31', hasLifetime: false });
    });

    it('flags lifetime on a null period_end without losing the dated max', () => {
        const result = derivePaidThrough([parseDate('2025-12-31'), null]);
        expect(result).toEqual({ paidThrough: '2025-12-31', hasLifetime: true });
    });

    it('handles a lifetime-only payment history', () => {
        expect(derivePaidThrough([null])).toEqual({ paidThrough: null, hasLifetime: true });
    });
});

describe('resolvePaymentPeriod', () => {
    it('computes from the renewal mode when no override is given', () => {
        expect(resolvePaymentPeriod('calendar_year', '2026-03-10', null))
            .toEqual({ periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    });

    it('rolls a calendar-year renewal to next year when already covered', () => {
        expect(resolvePaymentPeriod('calendar_year', '2026-11-15', '2026-12-31'))
            .toEqual({ periodStart: '2027-01-01', periodEnd: '2027-12-31' });
    });

    it('extends an anniversary renewal from the paid-through date', () => {
        expect(resolvePaymentPeriod('anniversary', '2026-06-01', '2026-06-30'))
            .toEqual({ periodStart: '2026-07-01', periodEnd: '2027-06-30' });
    });

    it('uses an explicit override verbatim, including a lifetime (null) end', () => {
        expect(resolvePaymentPeriod('calendar_year', '2026-03-10', '2026-12-31', {
            periodStart: '2026-02-01',
            periodEnd: '2026-08-31',
        })).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-08-31' });

        expect(resolvePaymentPeriod('anniversary', '2026-03-10', null, {
            periodStart: '2026-03-10',
            periodEnd: null,
        })).toEqual({ periodStart: '2026-03-10', periodEnd: null });
    });

    it('rejects an override whose end precedes its start', () => {
        expect(() => resolvePaymentPeriod('anniversary', '2026-03-10', null, {
            periodStart: '2026-03-10',
            periodEnd: '2026-03-09',
        })).toThrow(MembershipValidationError);
    });
});

// ============================================
// recordPayment (mocked prisma)
// ============================================

function mockMember(overrides: Record<string, unknown> = {}) {
    return {
        id: 7,
        book_guid: BOOK,
        name: 'Alice',
        membership_type_id: 3,
        payments: [] as Array<{ period_end: Date | null }>,
        ...overrides,
    };
}

function mockType(overrides: Record<string, unknown> = {}) {
    return {
        id: 3,
        book_guid: BOOK,
        name: 'Individual',
        amount: '25.00',
        renewal_mode: 'calendar_year',
        grace_days: 0,
        active: true,
        sort_order: 0,
        ...overrides,
    };
}

function echoCreate() {
    payments.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 99,
        ...data,
    }));
}

describe('recordPayment', () => {
    it('computes the period from the type renewal mode and derives new paidThrough', async () => {
        members.findUnique.mockResolvedValue(mockMember({
            payments: [{ period_end: parseDate('2025-12-31') }],
        }));
        types.findUnique.mockResolvedValue(mockType());
        echoCreate();

        const input = parseInput(paymentInputSchema, { paidDate: '2026-02-01', method: 'check' });
        const result = await recordPayment(BOOK, 7, input);

        expect(result).not.toBeNull();
        expect(result!.payment.periodStart).toBe('2026-01-01');
        expect(result!.payment.periodEnd).toBe('2026-12-31');
        expect(result!.paidThrough).toBe('2026-12-31');
        expect(result!.hasLifetime).toBe(false);
        // Amount defaults to the type's dues amount.
        expect(result!.payment.amount).toBe(25);
        expect(payments.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                book_guid: BOOK,
                member_id: 7,
                membership_type_id: 3,
                period_start: parseDate('2026-01-01'),
                period_end: parseDate('2026-12-31'),
            }),
        }));
    });

    it('rolls an early calendar-year renewal into the next year', async () => {
        members.findUnique.mockResolvedValue(mockMember({
            payments: [{ period_end: parseDate('2026-12-31') }],
        }));
        types.findUnique.mockResolvedValue(mockType());
        echoCreate();

        const input = parseInput(paymentInputSchema, { paidDate: '2026-11-20' });
        const result = await recordPayment(BOOK, 7, input);

        expect(result!.payment.periodStart).toBe('2027-01-01');
        expect(result!.payment.periodEnd).toBe('2027-12-31');
        expect(result!.paidThrough).toBe('2027-12-31');
    });

    it('records a lifetime payment with a null period end', async () => {
        members.findUnique.mockResolvedValue(mockMember());
        types.findUnique.mockResolvedValue(mockType({ renewal_mode: 'lifetime', amount: '500.00' }));
        echoCreate();

        const input = parseInput(paymentInputSchema, { paidDate: '2026-05-01' });
        const result = await recordPayment(BOOK, 7, input);

        expect(result!.payment.periodEnd).toBeNull();
        expect(result!.hasLifetime).toBe(true);
        expect(result!.paidThrough).toBeNull();
        expect(result!.payment.amount).toBe(500);
    });

    it('honors an explicit period override and an explicit amount', async () => {
        members.findUnique.mockResolvedValue(mockMember({
            payments: [{ period_end: parseDate('2026-12-31') }],
        }));
        types.findUnique.mockResolvedValue(mockType());
        echoCreate();

        const input = parseInput(paymentInputSchema, {
            paidDate: '2026-06-01',
            amount: 10,
            periodStart: '2024-01-01',
            periodEnd: '2024-12-31',
        });
        const result = await recordPayment(BOOK, 7, input);

        expect(result!.payment.periodStart).toBe('2024-01-01');
        expect(result!.payment.periodEnd).toBe('2024-12-31');
        expect(result!.payment.amount).toBe(10);
        // Backdated payment does not shrink the existing paid-through.
        expect(result!.paidThrough).toBe('2026-12-31');
    });

    it('rejects a payment when neither member nor input carries a membership type', async () => {
        members.findUnique.mockResolvedValue(mockMember({ membership_type_id: null }));
        const input = parseInput(paymentInputSchema, { paidDate: '2026-05-01' });
        await expect(recordPayment(BOOK, 7, input)).rejects.toThrow(MembershipValidationError);
    });

    it('returns null (404) for a member in another book', async () => {
        members.findUnique.mockResolvedValue(mockMember({ book_guid: OTHER_BOOK }));
        const input = parseInput(paymentInputSchema, { paidDate: '2026-05-01' });
        expect(await recordPayment(BOOK, 7, input)).toBeNull();
    });

    it('rejects a membership type belonging to another book', async () => {
        members.findUnique.mockResolvedValue(mockMember());
        types.findUnique.mockResolvedValue(mockType({ book_guid: OTHER_BOOK }));
        const input = parseInput(paymentInputSchema, { paidDate: '2026-05-01' });
        await expect(recordPayment(BOOK, 7, input)).rejects.toThrow(MembershipValidationError);
    });
});

// ============================================
// listMembers dues derivation (mocked prisma)
// ============================================

describe('listMembers', () => {
    it('derives paidThrough, applies grace days, and maps type names', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const lastWeek = addDays(today, -7);
        const farFuture = addDays(today, 365);

        members.findMany.mockResolvedValue([
            {
                id: 1, name: 'Current Carla', email: null, phone: null, address: null,
                membership_type_id: 3, joined_date: null, status: 'active', notes: null,
                payments: [{ period_end: parseDate(farFuture) }],
                _count: { attendance: 4 },
            },
            {
                id: 2, name: 'Graced Gary', email: null, phone: null, address: null,
                membership_type_id: 9, joined_date: null, status: 'active', notes: null,
                payments: [{ period_end: parseDate(lastWeek) }],
                _count: { attendance: 0 },
            },
            {
                id: 3, name: 'Lapsed Lucy', email: null, phone: null, address: null,
                membership_type_id: 3, joined_date: null, status: 'active', notes: null,
                payments: [{ period_end: parseDate(lastWeek) }],
                _count: { attendance: 1 },
            },
            {
                id: 4, name: 'Honorary Hank', email: null, phone: null, address: null,
                membership_type_id: null, joined_date: null, status: 'honorary', notes: null,
                payments: [],
                _count: { attendance: 2 },
            },
        ]);
        types.findMany.mockResolvedValue([
            { id: 3, name: 'Individual', grace_days: 0 },
            { id: 9, name: 'Family', grace_days: 30 },
        ]);

        const result = await listMembers(BOOK);

        expect(result.map(m => [m.name, m.duesStatus])).toEqual([
            ['Current Carla', 'current'],
            ['Graced Gary', 'current'],   // expired 7 days ago, 30-day grace
            ['Lapsed Lucy', 'lapsed'],    // expired 7 days ago, no grace
            ['Honorary Hank', 'exempt'],
        ]);
        expect(result[0].membershipTypeName).toBe('Individual');
        expect(result[0].paidThrough).toBe(farFuture);
        expect(result[0].attendanceCount).toBe(4);
        expect(result[3].membershipTypeName).toBeNull();
    });
});

// ============================================
// deleteMembershipType referential guard
// ============================================

describe('deleteMembershipType', () => {
    it('blocks deletion while members or payments reference the type', async () => {
        types.findUnique.mockResolvedValue(mockType());
        members.count.mockResolvedValue(2);
        payments.count.mockResolvedValue(0);

        await expect(deleteMembershipType(BOOK, 3)).rejects.toThrow(/deactivate/i);
        expect(types.delete).not.toHaveBeenCalled();
    });

    it('deletes an unreferenced type', async () => {
        types.findUnique.mockResolvedValue(mockType());
        members.count.mockResolvedValue(0);
        payments.count.mockResolvedValue(0);
        types.delete.mockResolvedValue(mockType());

        expect(await deleteMembershipType(BOOK, 3)).toEqual({ deleted: true });
        expect(types.delete).toHaveBeenCalledWith({ where: { id: 3 } });
    });

    it('returns null for a type in another book', async () => {
        types.findUnique.mockResolvedValue(mockType({ book_guid: OTHER_BOOK }));
        expect(await deleteMembershipType(BOOK, 3)).toBeNull();
        expect(types.delete).not.toHaveBeenCalled();
    });
});
