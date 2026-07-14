/**
 * Membership Management Service (501c3 clubs/charities)
 *
 * CRUD + derivations over the gnucash_web_membership_* tables: membership
 * types (dues levels with renewal policy), members, dues payments, meetings
 * and attendance. Period/dues math lives in the pure module
 * '@/lib/membership' (client-safe); this service wires it to Prisma.
 *
 * BOOK SCOPING: every table carries book_guid. All queries filter by the
 * caller-provided bookGuid, all inserts set it, and cross-book id probing is
 * rejected by fetch-then-check (row.book_guid === bookGuid → else null/404).
 *
 * Dates: the @db.Date columns come back from Prisma as JS Dates at UTC
 * midnight; the API boundary speaks ISO date strings (YYYY-MM-DD). The
 * helpers isoDate()/parseDate() convert without timezone drift.
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';
import {
    computeMembershipPeriod,
    computeDuesStatus,
    RENEWAL_MODES,
    MEMBER_STATUSES,
    ATTENDANCE_STATUSES,
    PAYMENT_METHODS,
    type RenewalMode,
    type MemberStatus,
    type DuesStatus,
    type AttendanceStatus,
    type PaymentMethod,
} from '@/lib/membership';

/** Thrown for caller-fixable input problems; API routes map this to HTTP 400. */
export class MembershipValidationError extends Error {}

// ============================================
// Pure helpers (unit tested)
// ============================================

/** JS Date (UTC midnight from a @db.Date column) → ISO date string. */
export function isoDate(d: Date | string): string {
    if (typeof d === 'string') return d.slice(0, 10);
    return d.toISOString().slice(0, 10);
}

/** ISO date string → JS Date at UTC midnight (for @db.Date columns). */
export function parseDate(iso: string): Date {
    return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

/**
 * Derive a member's paid-through state from payment period_end values.
 * paidThrough = max period_end (null when never paid or only lifetime rows);
 * hasLifetime = any payment with a null period_end.
 */
export function derivePaidThrough(
    periodEnds: Array<Date | string | null>
): { paidThrough: string | null; hasLifetime: boolean } {
    let paidThrough: string | null = null;
    let hasLifetime = false;
    for (const end of periodEnds) {
        if (end === null) {
            hasLifetime = true;
            continue;
        }
        const iso = isoDate(end);
        if (paidThrough === null || iso > paidThrough) paidThrough = iso;
    }
    return { paidThrough, hasLifetime };
}

/**
 * Resolve the coverage period for a new payment: an explicit override wins
 * (periodStart given → use it verbatim, periodEnd null meaning lifetime);
 * otherwise compute from the type's renewal mode against the member's
 * current paid-through date.
 */
export function resolvePaymentPeriod(
    mode: RenewalMode,
    paidDate: string,
    paidThrough: string | null,
    override?: { periodStart: string; periodEnd: string | null }
): { periodStart: string; periodEnd: string | null } {
    if (override) {
        if (override.periodEnd !== null && override.periodEnd < override.periodStart) {
            throw new MembershipValidationError('periodEnd must be on or after periodStart');
        }
        return { periodStart: override.periodStart, periodEnd: override.periodEnd };
    }
    return computeMembershipPeriod(mode, paidDate, paidThrough);
}

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

// ============================================
// Validation schemas
// ============================================

const isoDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

export const membershipTypeInputSchema = z.object({
    name: z.string().trim().min(1, 'name is required').max(255),
    amount: z.number().min(0).default(0),
    renewalMode: z.enum(RENEWAL_MODES as [RenewalMode, ...RenewalMode[]]).default('calendar_year'),
    graceDays: z.number().int().min(0).max(3650).default(0),
    active: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
});
export type MembershipTypeInput = z.infer<typeof membershipTypeInputSchema>;

export const memberInputSchema = z.object({
    name: z.string().trim().min(1, 'name is required').max(255),
    email: z.string().trim().max(255).nullish(),
    phone: z.string().trim().max(50).nullish(),
    address: z.string().max(2048).nullish(),
    membershipTypeId: z.number().int().nullish(),
    joinedDate: isoDateSchema.nullish(),
    status: z.enum(MEMBER_STATUSES as [MemberStatus, ...MemberStatus[]]).default('active'),
    notes: z.string().max(4096).nullish(),
});
export type MemberInput = z.infer<typeof memberInputSchema>;

export const paymentInputSchema = z.object({
    membershipTypeId: z.number().int().nullish(),
    amount: z.number().min(0).nullish(),
    paidDate: isoDateSchema,
    method: z.enum(PAYMENT_METHODS as unknown as [PaymentMethod, ...PaymentMethod[]]).default('cash'),
    reference: z.string().trim().max(100).nullish(),
    notes: z.string().max(4096).nullish(),
    /** Manual period override: providing periodStart bypasses computation. */
    periodStart: isoDateSchema.nullish(),
    /** With periodStart set, null/omitted periodEnd means lifetime coverage. */
    periodEnd: isoDateSchema.nullish(),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;

export const meetingInputSchema = z.object({
    title: z.string().trim().min(1, 'title is required').max(255),
    meetingDate: isoDateSchema,
    location: z.string().trim().max(255).nullish(),
    notes: z.string().max(4096).nullish(),
});
export type MeetingInput = z.infer<typeof meetingInputSchema>;

export const attendanceEntriesSchema = z.object({
    entries: z.array(z.object({
        memberId: z.number().int(),
        status: z.enum(ATTENDANCE_STATUSES as [AttendanceStatus, ...AttendanceStatus[]]),
        notes: z.string().max(255).nullish(),
    })).max(5000),
});
export type AttendanceEntriesInput = z.infer<typeof attendanceEntriesSchema>;

/** Parse a request body against a schema, throwing MembershipValidationError. */
export function parseInput<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
    const result = schema.safeParse(body);
    if (!result.success) {
        const first = result.error.issues[0];
        const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        throw new MembershipValidationError(`${path}${first.message}`);
    }
    return result.data;
}

// ============================================
// DTOs
// ============================================

export interface MembershipTypeDTO {
    id: number;
    name: string;
    amount: number;
    renewalMode: RenewalMode;
    graceDays: number;
    active: boolean;
    sortOrder: number;
    memberCount: number;
}

export interface MemberListItemDTO {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    membershipTypeId: number | null;
    membershipTypeName: string | null;
    joinedDate: string | null;
    status: MemberStatus;
    notes: string | null;
    paidThrough: string | null;
    hasLifetime: boolean;
    duesStatus: DuesStatus;
    attendanceCount: number;
}

export interface PaymentDTO {
    id: number;
    memberId: number;
    membershipTypeId: number | null;
    membershipTypeName: string | null;
    amount: number;
    paidDate: string;
    periodStart: string;
    periodEnd: string | null;
    method: PaymentMethod;
    reference: string | null;
    notes: string | null;
}

export interface MemberAttendanceDTO {
    meetingId: number;
    meetingTitle: string;
    meetingDate: string;
    status: AttendanceStatus;
    notes: string | null;
}

export interface MemberDetailDTO extends MemberListItemDTO {
    payments: PaymentDTO[];
    attendance: MemberAttendanceDTO[];
}

export interface MeetingDTO {
    id: number;
    title: string;
    meetingDate: string;
    location: string | null;
    notes: string | null;
    presentCount: number;
    absentCount: number;
    excusedCount: number;
    recordedCount: number;
}

export interface MeetingRosterEntryDTO {
    memberId: number;
    name: string;
    memberStatus: MemberStatus;
    /** null = no attendance recorded for this meeting. */
    status: AttendanceStatus | null;
    notes: string | null;
}

export interface MeetingDetailDTO extends MeetingDTO {
    roster: MeetingRosterEntryDTO[];
}

export interface MembershipSummaryDTO {
    memberCount: number;
    activeMemberCount: number;
    duesStatusCounts: Record<DuesStatus, number>;
    duesCollectedYtd: number;
    upcomingExpirations: Array<{ id: number; name: string; paidThrough: string }>;
    recentMeetings: {
        meetingCount: number;
        /** Average present / recorded over the last 5 meetings; null when none recorded. */
        attendanceRate: number | null;
    };
}

// ============================================
// Membership types
// ============================================

type TypeRow = {
    id: number;
    name: string;
    amount: unknown;
    renewal_mode: string;
    grace_days: number;
    active: boolean;
    sort_order: number;
};

function typeToDTO(row: TypeRow, memberCount = 0): MembershipTypeDTO {
    return {
        id: row.id,
        name: row.name,
        amount: Number(row.amount),
        renewalMode: row.renewal_mode as RenewalMode,
        graceDays: row.grace_days,
        active: row.active,
        sortOrder: row.sort_order,
        memberCount,
    };
}

export async function listMembershipTypes(bookGuid: string): Promise<MembershipTypeDTO[]> {
    const [types, counts] = await Promise.all([
        prisma.gnucash_web_membership_types.findMany({
            where: { book_guid: bookGuid },
            orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        }),
        prisma.gnucash_web_members.groupBy({
            by: ['membership_type_id'],
            where: { book_guid: bookGuid },
            _count: { _all: true },
        }),
    ]);
    const countByType = new Map<number | null, number>(
        counts.map(c => [c.membership_type_id, c._count._all])
    );
    return types.map(t => typeToDTO(t, countByType.get(t.id) ?? 0));
}

export async function createMembershipType(
    bookGuid: string,
    input: MembershipTypeInput
): Promise<MembershipTypeDTO> {
    const row = await prisma.gnucash_web_membership_types.create({
        data: {
            book_guid: bookGuid,
            name: input.name,
            amount: input.amount,
            renewal_mode: input.renewalMode,
            grace_days: input.graceDays,
            active: input.active,
            sort_order: input.sortOrder,
        },
    });
    return typeToDTO(row);
}

export async function updateMembershipType(
    bookGuid: string,
    id: number,
    input: MembershipTypeInput
): Promise<MembershipTypeDTO | null> {
    const existing = await prisma.gnucash_web_membership_types.findUnique({ where: { id } });
    if (!existing || existing.book_guid !== bookGuid) return null;
    const row = await prisma.gnucash_web_membership_types.update({
        where: { id },
        data: {
            name: input.name,
            amount: input.amount,
            renewal_mode: input.renewalMode,
            grace_days: input.graceDays,
            active: input.active,
            sort_order: input.sortOrder,
            updated_at: new Date(),
        },
    });
    return typeToDTO(row);
}

/**
 * Delete a membership type. Blocked (validation error) when any member or
 * payment still references it — deactivate instead.
 */
export async function deleteMembershipType(
    bookGuid: string,
    id: number
): Promise<{ deleted: boolean } | null> {
    const existing = await prisma.gnucash_web_membership_types.findUnique({ where: { id } });
    if (!existing || existing.book_guid !== bookGuid) return null;

    const [memberRefs, paymentRefs] = await Promise.all([
        prisma.gnucash_web_members.count({
            where: { book_guid: bookGuid, membership_type_id: id },
        }),
        prisma.gnucash_web_membership_payments.count({
            where: { book_guid: bookGuid, membership_type_id: id },
        }),
    ]);
    if (memberRefs > 0 || paymentRefs > 0) {
        throw new MembershipValidationError(
            `"${existing.name}" is referenced by ${memberRefs} member(s) and ${paymentRefs} payment(s) — deactivate it instead of deleting`
        );
    }

    await prisma.gnucash_web_membership_types.delete({ where: { id } });
    return { deleted: true };
}

// ============================================
// Members
// ============================================

async function typeMapForBook(bookGuid: string) {
    const types = await prisma.gnucash_web_membership_types.findMany({
        where: { book_guid: bookGuid },
        select: { id: true, name: true, grace_days: true },
    });
    return new Map(types.map(t => [t.id, t]));
}

export async function listMembers(bookGuid: string): Promise<MemberListItemDTO[]> {
    const [members, typeMap] = await Promise.all([
        prisma.gnucash_web_members.findMany({
            where: { book_guid: bookGuid },
            include: {
                payments: { select: { period_end: true } },
                _count: { select: { attendance: true } },
            },
            orderBy: { name: 'asc' },
        }),
        typeMapForBook(bookGuid),
    ]);

    const today = todayIso();
    return members.map(m => {
        const type = m.membership_type_id != null ? typeMap.get(m.membership_type_id) : undefined;
        const { paidThrough, hasLifetime } = derivePaidThrough(m.payments.map(p => p.period_end));
        return {
            id: m.id,
            name: m.name,
            email: m.email,
            phone: m.phone,
            address: m.address,
            membershipTypeId: m.membership_type_id,
            membershipTypeName: type?.name ?? null,
            joinedDate: m.joined_date ? isoDate(m.joined_date) : null,
            status: m.status as MemberStatus,
            notes: m.notes,
            paidThrough,
            hasLifetime,
            duesStatus: computeDuesStatus(m.status, paidThrough, hasLifetime, type?.grace_days ?? 0, today),
            attendanceCount: m._count.attendance,
        };
    });
}

export async function getMember(bookGuid: string, id: number): Promise<MemberDetailDTO | null> {
    const member = await prisma.gnucash_web_members.findUnique({
        where: { id },
        include: {
            payments: { orderBy: { paid_date: 'desc' } },
            attendance: {
                include: { meeting: { select: { id: true, title: true, meeting_date: true } } },
                orderBy: { meeting: { meeting_date: 'desc' } },
            },
        },
    });
    if (!member || member.book_guid !== bookGuid) return null;

    const typeMap = await typeMapForBook(bookGuid);
    const type = member.membership_type_id != null ? typeMap.get(member.membership_type_id) : undefined;
    const { paidThrough, hasLifetime } = derivePaidThrough(member.payments.map(p => p.period_end));

    return {
        id: member.id,
        name: member.name,
        email: member.email,
        phone: member.phone,
        address: member.address,
        membershipTypeId: member.membership_type_id,
        membershipTypeName: type?.name ?? null,
        joinedDate: member.joined_date ? isoDate(member.joined_date) : null,
        status: member.status as MemberStatus,
        notes: member.notes,
        paidThrough,
        hasLifetime,
        duesStatus: computeDuesStatus(member.status, paidThrough, hasLifetime, type?.grace_days ?? 0, todayIso()),
        attendanceCount: member.attendance.length,
        payments: member.payments.map(p => ({
            id: p.id,
            memberId: p.member_id,
            membershipTypeId: p.membership_type_id,
            membershipTypeName: p.membership_type_id != null
                ? typeMap.get(p.membership_type_id)?.name ?? null
                : null,
            amount: Number(p.amount),
            paidDate: isoDate(p.paid_date),
            periodStart: isoDate(p.period_start),
            periodEnd: p.period_end ? isoDate(p.period_end) : null,
            method: p.method as PaymentMethod,
            reference: p.reference,
            notes: p.notes,
        })),
        attendance: member.attendance.map(a => ({
            meetingId: a.meeting.id,
            meetingTitle: a.meeting.title,
            meetingDate: isoDate(a.meeting.meeting_date),
            status: a.status as AttendanceStatus,
            notes: a.notes,
        })),
    };
}

/** Verify a membership-type id belongs to the book (throws otherwise). */
async function assertTypeInBook(bookGuid: string, typeId: number): Promise<void> {
    const type = await prisma.gnucash_web_membership_types.findUnique({
        where: { id: typeId },
        select: { book_guid: true },
    });
    if (!type || type.book_guid !== bookGuid) {
        throw new MembershipValidationError('Membership type not found');
    }
}

export async function createMember(bookGuid: string, input: MemberInput): Promise<MemberListItemDTO> {
    if (input.membershipTypeId != null) await assertTypeInBook(bookGuid, input.membershipTypeId);
    const row = await prisma.gnucash_web_members.create({
        data: {
            book_guid: bookGuid,
            name: input.name,
            email: input.email ?? null,
            phone: input.phone ?? null,
            address: input.address ?? null,
            membership_type_id: input.membershipTypeId ?? null,
            joined_date: input.joinedDate ? parseDate(input.joinedDate) : null,
            status: input.status,
            notes: input.notes ?? null,
        },
    });
    const created = await getMember(bookGuid, row.id);
    // Freshly created — cannot be null.
    return created as MemberDetailDTO;
}

export async function updateMember(
    bookGuid: string,
    id: number,
    input: MemberInput
): Promise<MemberDetailDTO | null> {
    const existing = await prisma.gnucash_web_members.findUnique({
        where: { id },
        select: { book_guid: true },
    });
    if (!existing || existing.book_guid !== bookGuid) return null;
    if (input.membershipTypeId != null) await assertTypeInBook(bookGuid, input.membershipTypeId);

    await prisma.gnucash_web_members.update({
        where: { id },
        data: {
            name: input.name,
            email: input.email ?? null,
            phone: input.phone ?? null,
            address: input.address ?? null,
            membership_type_id: input.membershipTypeId ?? null,
            joined_date: input.joinedDate ? parseDate(input.joinedDate) : null,
            status: input.status,
            notes: input.notes ?? null,
            updated_at: new Date(),
        },
    });
    return getMember(bookGuid, id);
}

/** Payments and attendance cascade-delete with the member. */
export async function deleteMember(bookGuid: string, id: number): Promise<{ deleted: boolean } | null> {
    const existing = await prisma.gnucash_web_members.findUnique({
        where: { id },
        select: { book_guid: true },
    });
    if (!existing || existing.book_guid !== bookGuid) return null;
    await prisma.gnucash_web_members.delete({ where: { id } });
    return { deleted: true };
}

// ============================================
// Payments
// ============================================

export interface RecordPaymentResult {
    payment: PaymentDTO;
    paidThrough: string | null;
    hasLifetime: boolean;
}

/**
 * Record a dues payment. The coverage period comes from the membership
 * type's renewal mode against the member's current paid-through date, unless
 * the input carries an explicit periodStart (manual override; periodEnd null
 * = lifetime). Amount defaults to the type's dues amount.
 */
export async function recordPayment(
    bookGuid: string,
    memberId: number,
    input: PaymentInput
): Promise<RecordPaymentResult | null> {
    const member = await prisma.gnucash_web_members.findUnique({
        where: { id: memberId },
        include: { payments: { select: { period_end: true } } },
    });
    if (!member || member.book_guid !== bookGuid) return null;

    const typeId = input.membershipTypeId ?? member.membership_type_id;
    if (typeId == null) {
        throw new MembershipValidationError(
            'Member has no membership type — pick one for this payment'
        );
    }
    const type = await prisma.gnucash_web_membership_types.findUnique({ where: { id: typeId } });
    if (!type || type.book_guid !== bookGuid) {
        throw new MembershipValidationError('Membership type not found');
    }

    const { paidThrough } = derivePaidThrough(member.payments.map(p => p.period_end));
    const period = resolvePaymentPeriod(
        type.renewal_mode as RenewalMode,
        input.paidDate,
        paidThrough,
        input.periodStart != null
            ? { periodStart: input.periodStart, periodEnd: input.periodEnd ?? null }
            : undefined
    );

    const row = await prisma.gnucash_web_membership_payments.create({
        data: {
            book_guid: bookGuid,
            member_id: memberId,
            membership_type_id: typeId,
            amount: input.amount ?? Number(type.amount),
            paid_date: parseDate(input.paidDate),
            period_start: parseDate(period.periodStart),
            period_end: period.periodEnd ? parseDate(period.periodEnd) : null,
            method: input.method,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
        },
    });

    const after = derivePaidThrough([
        ...member.payments.map(p => p.period_end),
        row.period_end,
    ]);

    return {
        payment: {
            id: row.id,
            memberId: row.member_id,
            membershipTypeId: row.membership_type_id,
            membershipTypeName: type.name,
            amount: Number(row.amount),
            paidDate: isoDate(row.paid_date),
            periodStart: isoDate(row.period_start),
            periodEnd: row.period_end ? isoDate(row.period_end) : null,
            method: row.method as PaymentMethod,
            reference: row.reference,
            notes: row.notes,
        },
        paidThrough: after.paidThrough,
        hasLifetime: after.hasLifetime,
    };
}

export async function deletePayment(bookGuid: string, id: number): Promise<{ deleted: boolean } | null> {
    const existing = await prisma.gnucash_web_membership_payments.findUnique({
        where: { id },
        select: { book_guid: true },
    });
    if (!existing || existing.book_guid !== bookGuid) return null;
    await prisma.gnucash_web_membership_payments.delete({ where: { id } });
    return { deleted: true };
}

// ============================================
// Meetings + attendance
// ============================================

function meetingCounts(attendance: Array<{ status: string }>) {
    let present = 0, absent = 0, excused = 0;
    for (const a of attendance) {
        if (a.status === 'present') present++;
        else if (a.status === 'absent') absent++;
        else if (a.status === 'excused') excused++;
    }
    return {
        presentCount: present,
        absentCount: absent,
        excusedCount: excused,
        recordedCount: attendance.length,
    };
}

export async function listMeetings(bookGuid: string): Promise<MeetingDTO[]> {
    const meetings = await prisma.gnucash_web_meetings.findMany({
        where: { book_guid: bookGuid },
        include: { attendance: { select: { status: true } } },
        orderBy: { meeting_date: 'desc' },
    });
    return meetings.map(m => ({
        id: m.id,
        title: m.title,
        meetingDate: isoDate(m.meeting_date),
        location: m.location,
        notes: m.notes,
        ...meetingCounts(m.attendance),
    }));
}

/**
 * Meeting detail for the roll-call UI: the full roster of active + honorary
 * members, plus any other member that already has an attendance record
 * (e.g. since resigned), each with their recorded status (null = unmarked).
 */
export async function getMeeting(bookGuid: string, id: number): Promise<MeetingDetailDTO | null> {
    const meeting = await prisma.gnucash_web_meetings.findUnique({
        where: { id },
        include: { attendance: true },
    });
    if (!meeting || meeting.book_guid !== bookGuid) return null;

    const recordedIds = meeting.attendance.map(a => a.member_id);
    const members = await prisma.gnucash_web_members.findMany({
        where: {
            book_guid: bookGuid,
            OR: [
                { status: { in: ['active', 'honorary'] } },
                { id: { in: recordedIds } },
            ],
        },
        select: { id: true, name: true, status: true },
        orderBy: { name: 'asc' },
    });

    const byMember = new Map(meeting.attendance.map(a => [a.member_id, a]));
    return {
        id: meeting.id,
        title: meeting.title,
        meetingDate: isoDate(meeting.meeting_date),
        location: meeting.location,
        notes: meeting.notes,
        ...meetingCounts(meeting.attendance),
        roster: members.map(m => {
            const rec = byMember.get(m.id);
            return {
                memberId: m.id,
                name: m.name,
                memberStatus: m.status as MemberStatus,
                status: rec ? (rec.status as AttendanceStatus) : null,
                notes: rec?.notes ?? null,
            };
        }),
    };
}

export async function createMeeting(bookGuid: string, input: MeetingInput): Promise<MeetingDTO> {
    const row = await prisma.gnucash_web_meetings.create({
        data: {
            book_guid: bookGuid,
            title: input.title,
            meeting_date: parseDate(input.meetingDate),
            location: input.location ?? null,
            notes: input.notes ?? null,
        },
    });
    return {
        id: row.id,
        title: row.title,
        meetingDate: isoDate(row.meeting_date),
        location: row.location,
        notes: row.notes,
        presentCount: 0,
        absentCount: 0,
        excusedCount: 0,
        recordedCount: 0,
    };
}

export async function updateMeeting(
    bookGuid: string,
    id: number,
    input: MeetingInput
): Promise<MeetingDTO | null> {
    const existing = await prisma.gnucash_web_meetings.findUnique({
        where: { id },
        select: { book_guid: true },
    });
    if (!existing || existing.book_guid !== bookGuid) return null;
    await prisma.gnucash_web_meetings.update({
        where: { id },
        data: {
            title: input.title,
            meeting_date: parseDate(input.meetingDate),
            location: input.location ?? null,
            notes: input.notes ?? null,
            updated_at: new Date(),
        },
    });
    const meetings = await listMeetings(bookGuid);
    return meetings.find(m => m.id === id) ?? null;
}

export async function deleteMeeting(bookGuid: string, id: number): Promise<{ deleted: boolean } | null> {
    const existing = await prisma.gnucash_web_meetings.findUnique({
        where: { id },
        select: { book_guid: true },
    });
    if (!existing || existing.book_guid !== bookGuid) return null;
    await prisma.gnucash_web_meetings.delete({ where: { id } });
    return { deleted: true };
}

/**
 * Replace-all attendance for a meeting: members omitted from `entries` lose
 * their record (unmarked). Meeting and all member ids must belong to the
 * book. Runs delete + insert in one transaction.
 */
export async function setAttendance(
    bookGuid: string,
    meetingId: number,
    input: AttendanceEntriesInput
): Promise<MeetingDetailDTO | null> {
    const meeting = await prisma.gnucash_web_meetings.findUnique({
        where: { id: meetingId },
        select: { book_guid: true },
    });
    if (!meeting || meeting.book_guid !== bookGuid) return null;

    const memberIds = [...new Set(input.entries.map(e => e.memberId))];
    if (memberIds.length !== input.entries.length) {
        throw new MembershipValidationError('Duplicate member in attendance entries');
    }
    if (memberIds.length > 0) {
        const found = await prisma.gnucash_web_members.count({
            where: { id: { in: memberIds }, book_guid: bookGuid },
        });
        if (found !== memberIds.length) {
            throw new MembershipValidationError('One or more members do not belong to this book');
        }
    }

    await prisma.$transaction([
        prisma.gnucash_web_meeting_attendance.deleteMany({ where: { meeting_id: meetingId } }),
        prisma.gnucash_web_meeting_attendance.createMany({
            data: input.entries.map(e => ({
                meeting_id: meetingId,
                member_id: e.memberId,
                status: e.status,
                notes: e.notes ?? null,
            })),
        }),
    ]);

    return getMeeting(bookGuid, meetingId);
}

// ============================================
// Summary (dashboard cards)
// ============================================

const EXPIRATION_WINDOW_DAYS = 60;
const RECENT_MEETING_COUNT = 5;

export async function membershipSummary(bookGuid: string): Promise<MembershipSummaryDTO> {
    const yearStart = parseDate(`${todayIso().slice(0, 4)}-01-01`);

    const [members, ytd, recentMeetings] = await Promise.all([
        listMembers(bookGuid),
        prisma.gnucash_web_membership_payments.aggregate({
            where: { book_guid: bookGuid, paid_date: { gte: yearStart } },
            _sum: { amount: true },
        }),
        prisma.gnucash_web_meetings.findMany({
            where: { book_guid: bookGuid },
            include: { attendance: { select: { status: true } } },
            orderBy: { meeting_date: 'desc' },
            take: RECENT_MEETING_COUNT,
        }),
    ]);

    const duesStatusCounts: Record<DuesStatus, number> = {
        current: 0, lifetime: 0, lapsed: 0, unpaid: 0, exempt: 0,
    };
    for (const m of members) duesStatusCounts[m.duesStatus]++;

    const today = todayIso();
    const windowEnd = isoDate(new Date(
        parseDate(today).getTime() + EXPIRATION_WINDOW_DAYS * 86400000
    ));
    const upcomingExpirations = members
        .filter(m =>
            m.status === 'active' &&
            !m.hasLifetime &&
            m.paidThrough !== null &&
            m.paidThrough >= today &&
            m.paidThrough <= windowEnd
        )
        .sort((a, b) => (a.paidThrough! < b.paidThrough! ? -1 : 1))
        .map(m => ({ id: m.id, name: m.name, paidThrough: m.paidThrough! }));

    let present = 0, recorded = 0;
    for (const meeting of recentMeetings) {
        for (const a of meeting.attendance) {
            recorded++;
            if (a.status === 'present') present++;
        }
    }

    return {
        memberCount: members.length,
        activeMemberCount: members.filter(m => m.status === 'active').length,
        duesStatusCounts,
        duesCollectedYtd: Number(ytd._sum.amount ?? 0),
        upcomingExpirations,
        recentMeetings: {
            meetingCount: recentMeetings.length,
            attendanceRate: recorded > 0 ? present / recorded : null,
        },
    };
}
