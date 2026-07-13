import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const { db } = vi.hoisted(() => ({
    db: {
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(),
        books: { findUnique: vi.fn() },
    },
}));

vi.mock('@/lib/prisma', () => ({ default: db }));

import {
    escapeIcsText,
    foldIcsLine,
    formatIcsDate,
    formatIcsDateTime,
    buildIcs,
    scheduledTransactionEvents,
    fixedIncomeEvents,
    rmdEvents,
    CALENDAR_EVENT_TYPES,
    type IcsEvent,
    type ScheduledEventSource,
} from '../ical';
import {
    generateCalendarTokenSecret,
    hashCalendarToken,
    isValidCalendarTokenFormat,
    parseCalendarEventTypes,
    resolveCalendarFeedToken,
    createCalendarFeedToken,
} from '../calendar-tokens';

const NOW = new Date(2026, 6, 12); // 2026-07-12 local

beforeEach(() => {
    vi.clearAllMocks();
    db.$executeRawUnsafe.mockResolvedValue(0);
    db.$executeRaw.mockResolvedValue(1);
});

// ---------------------------------------------------------------------------
// ICS text escaping
// ---------------------------------------------------------------------------

describe('escapeIcsText', () => {
    it('escapes backslash, semicolon, comma, and newline', () => {
        expect(escapeIcsText('a\\b')).toBe('a\\\\b');
        expect(escapeIcsText('a;b')).toBe('a\\;b');
        expect(escapeIcsText('a,b')).toBe('a\\,b');
        expect(escapeIcsText('a\nb')).toBe('a\\nb');
        expect(escapeIcsText('a\r\nb')).toBe('a\\nb');
    });

    it('escapes backslash first so escapes are not double-escaped', () => {
        expect(escapeIcsText('\\;')).toBe('\\\\\\;');
    });

    it('leaves plain text untouched', () => {
        expect(escapeIcsText('Rent payment 2026')).toBe('Rent payment 2026');
    });
});

// ---------------------------------------------------------------------------
// Line folding
// ---------------------------------------------------------------------------

describe('foldIcsLine', () => {
    it('leaves lines of 75 octets or fewer alone', () => {
        const line = 'SUMMARY:' + 'x'.repeat(67); // exactly 75
        expect(foldIcsLine(line)).toEqual([line]);
    });

    it('folds long ASCII lines at 75 octets with a leading space continuation', () => {
        const line = 'DESCRIPTION:' + 'a'.repeat(200);
        const folded = foldIcsLine(line);
        expect(folded.length).toBeGreaterThan(1);
        for (const piece of folded) {
            expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(75);
        }
        for (const cont of folded.slice(1)) {
            expect(cont.startsWith(' ')).toBe(true);
        }
        // Unfolding (drop the leading space of continuations) reconstructs the line
        const unfolded = folded[0] + folded.slice(1).map(l => l.slice(1)).join('');
        expect(unfolded).toBe(line);
    });

    it('never splits multi-byte UTF-8 characters', () => {
        const line = 'SUMMARY:' + 'é'.repeat(120); // é = 2 octets
        const folded = foldIcsLine(line);
        for (const piece of folded) {
            expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(75);
            // A split multi-byte char would not survive an encode/decode roundtrip
            expect(Buffer.from(piece, 'utf8').toString('utf8')).toBe(piece);
        }
        const unfolded = folded[0] + folded.slice(1).map(l => l.slice(1)).join('');
        expect(unfolded).toBe(line);
    });
});

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

describe('date formatting', () => {
    it('formats Date values as YYYYMMDD', () => {
        expect(formatIcsDate(new Date(2026, 6, 5))).toBe('20260705');
        expect(formatIcsDate(new Date(2026, 0, 1))).toBe('20260101');
    });

    it('formats ISO date strings as YYYYMMDD', () => {
        expect(formatIcsDate('2026-07-15')).toBe('20260715');
        expect(formatIcsDate('2026-12-31')).toBe('20261231');
    });

    it('formats DTSTAMP timestamps as UTC basic format', () => {
        expect(formatIcsDateTime(new Date(Date.UTC(2026, 6, 12, 8, 30, 15)))).toBe('20260712T083015Z');
    });
});

// ---------------------------------------------------------------------------
// VCALENDAR building
// ---------------------------------------------------------------------------

describe('buildIcs', () => {
    const events: IcsEvent[] = [
        {
            uid: 'test-1@gnucash-web',
            date: '2026-08-01',
            summary: 'Rent, utilities; misc',
            description: 'Line one\nLine two',
        },
    ];

    it('produces a VCALENDAR wrapping VEVENTs with the required properties', () => {
        const ics = buildIcs(events, { now: NOW });
        expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
        expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
        expect(ics).toContain('VERSION:2.0');
        expect(ics).toContain('PRODID:');
        expect(ics).toContain('BEGIN:VEVENT');
        expect(ics).toContain('UID:test-1@gnucash-web');
        expect(ics).toContain('DTSTART;VALUE=DATE:20260801');
        expect(ics).toContain('DTSTAMP:');
        expect(ics).toContain('END:VEVENT');
    });

    it('uses CRLF for every line ending (no bare LF)', () => {
        const ics = buildIcs(events, { now: NOW });
        expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
        expect(ics.replace(/\r\n/g, '')).not.toContain('\r');
    });

    it('escapes SUMMARY and DESCRIPTION text', () => {
        const ics = buildIcs(events, { now: NOW });
        expect(ics).toContain('SUMMARY:Rent\\, utilities\\; misc');
        expect(ics).toContain('DESCRIPTION:Line one\\nLine two');
    });

    it('folds long content lines at 75 octets', () => {
        const ics = buildIcs([{
            uid: 'long@gnucash-web',
            date: '2026-08-01',
            summary: 'S'.repeat(300),
        }], { now: NOW });
        for (const line of ics.split('\r\n')) {
            expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
        }
    });
});

// ---------------------------------------------------------------------------
// Collector: scheduled transactions
// ---------------------------------------------------------------------------

function scheduledTx(overrides: Partial<ScheduledEventSource> = {}): ScheduledEventSource {
    return {
        guid: 'sx00000000000000000000000000sx01',
        name: 'Rent',
        enabled: true,
        endDate: null,
        lastOccur: '2026-07-01',
        remainingOccurrences: 0,
        recurrence: {
            periodType: 'month',
            mult: 1,
            periodStart: '2026-01-01',
            weekendAdjust: 'none',
        },
        splits: [
            { accountGuid: 'acct000000000000000000000000ex01', accountName: 'Expenses:Rent', amount: 1500 },
            { accountGuid: 'acct000000000000000000000000as01', accountName: 'Assets:Checking', amount: -1500 },
        ],
        ...overrides,
    };
}

describe('scheduledTransactionEvents', () => {
    it('emits monthly occurrences within the 90-day horizon only', () => {
        const events = scheduledTransactionEvents([scheduledTx()], NOW);
        // horizon = Oct 10 → Aug 1, Sep 1, Oct 1
        expect(events.map(e => formatIcsDate(e.date))).toEqual(['20260801', '20260901', '20261001']);
        expect(events[0].summary).toBe('Scheduled: Rent');
        expect(events[0].uid).toBe('sx-sx00000000000000000000000000sx01-20260801@gnucash-web');
        expect(events[0].description).toContain('Expenses:Rent: 1,500.00');
        expect(events[0].description).toContain('Assets:Checking: -1,500.00');
    });

    it('includes an occurrence falling on today itself', () => {
        const events = scheduledTransactionEvents([scheduledTx({
            lastOccur: null,
            recurrence: { periodType: 'weekly', mult: 1, periodStart: '2026-07-12', weekendAdjust: 'none' },
        })], NOW);
        expect(events.length).toBeGreaterThan(0);
        expect(formatIcsDate(events[0].date)).toBe('20260712');
    });

    it('skips disabled transactions and those without a recurrence', () => {
        expect(scheduledTransactionEvents([scheduledTx({ enabled: false })], NOW)).toEqual([]);
        expect(scheduledTransactionEvents([scheduledTx({ recurrence: null })], NOW)).toEqual([]);
    });

    it('respects the transaction end date', () => {
        const events = scheduledTransactionEvents([scheduledTx({ endDate: '2026-08-15' })], NOW);
        expect(events.map(e => formatIcsDate(e.date))).toEqual(['20260801']);
    });

    it('respects the remaining-occurrence cap', () => {
        const events = scheduledTransactionEvents([scheduledTx({ remainingOccurrences: 2 })], NOW);
        expect(events).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Collector: fixed income
// ---------------------------------------------------------------------------

describe('fixedIncomeEvents', () => {
    it('maps maturities and coupons to calendar events', () => {
        const events = fixedIncomeEvents(
            [{
                accountGuid: 'fi000000000000000000000000000001',
                accountName: 'Treasury 2Y',
                kind: 'treasury',
                maturityDate: '2026-09-30',
                faceValue: 10000,
                currentValue: 9950,
                daysUntil: 80,
            }],
            [{
                date: '2026-08-15',
                accountGuid: 'fi000000000000000000000000000001',
                accountName: 'Treasury 2Y',
                kind: 'treasury',
                amount: 212.5,
            }],
        );

        expect(events).toHaveLength(2);
        const maturity = events.find(e => e.uid.startsWith('fi-maturity-'))!;
        expect(maturity.date).toBe('2026-09-30');
        expect(maturity.summary).toBe('Treasury matures: Treasury 2Y');
        expect(maturity.description).toContain('10,000.00');

        const coupon = events.find(e => e.uid.startsWith('fi-coupon-'))!;
        expect(coupon.date).toBe('2026-08-15');
        expect(coupon.summary).toBe('Coupon payment: Treasury 2Y');
        expect(coupon.description).toContain('212.50');
    });

    it('returns an empty list for empty inputs', () => {
        expect(fixedIncomeEvents([], [])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Collector: RMD deadlines
// ---------------------------------------------------------------------------

describe('rmdEvents', () => {
    it('returns nothing without a (valid) birthday', () => {
        expect(rmdEvents(null, NOW)).toEqual([]);
        expect(rmdEvents('', NOW)).toEqual([]);
        expect(rmdEvents('not-a-date', NOW)).toEqual([]);
    });

    it('emits the April 1 first-RMD deadline and the Dec 31 deadline in the window', () => {
        // Born 1953 → start age 73 → RMD start year 2026
        const events = rmdEvents('1953-06-15', NOW);
        const uids = events.map(e => e.uid);
        expect(uids).toContain('rmd-first-2026@gnucash-web');
        expect(uids).toContain('rmd-2026@gnucash-web');

        const first = events.find(e => e.uid === 'rmd-first-2026@gnucash-web')!;
        expect(formatIcsDate(first.date)).toBe('20270401');
        const annual = events.find(e => e.uid === 'rmd-2026@gnucash-web')!;
        expect(formatIcsDate(annual.date)).toBe('20261231');
    });

    it('emits nothing before the RMD start year is near', () => {
        // Born 1965 → start age 75 → RMD start year 2040, far outside the window
        expect(rmdEvents('1965-01-01', NOW)).toEqual([]);
    });

    it('emits only the annual Dec 31 deadline for owners already past the first deadline', () => {
        // Born 1950 → start year 2023; April 1 2024 is in the past
        const events = rmdEvents('1950-05-01', NOW);
        expect(events.map(e => e.uid)).toEqual(['rmd-2026@gnucash-web']);
    });
});

// ---------------------------------------------------------------------------
// Calendar feed tokens: format, hashing, resolve
// ---------------------------------------------------------------------------

function tokenRow(overrides: Record<string, unknown> = {}) {
    const secret = 'a'.repeat(48);
    return {
        id: 3,
        user_id: 7,
        book_guid: 'book1234book1234book1234book1234',
        token_hash: hashCalendarToken(secret),
        prefix: secret.slice(0, 8),
        event_types: ['scheduled', 'rmd'],
        created_at: new Date('2026-07-01T00:00:00Z'),
        revoked_at: null,
        ...overrides,
    };
}

describe('calendar feed tokens', () => {
    it('generates 48-char lowercase hex secrets', () => {
        for (let i = 0; i < 20; i++) {
            const secret = generateCalendarTokenSecret();
            expect(secret).toMatch(/^[0-9a-f]{48}$/);
            expect(isValidCalendarTokenFormat(secret)).toBe(true);
        }
        const unique = new Set(Array.from({ length: 50 }, () => generateCalendarTokenSecret()));
        expect(unique.size).toBe(50);
    });

    it('hashes deterministically with SHA-256', () => {
        const secret = 'b'.repeat(48);
        const expected = createHash('sha256').update(secret, 'utf8').digest('hex');
        expect(hashCalendarToken(secret)).toBe(expected);
        expect(hashCalendarToken(secret)).toBe(hashCalendarToken(secret));
    });

    it('rejects malformed token formats', () => {
        expect(isValidCalendarTokenFormat('')).toBe(false);
        expect(isValidCalendarTokenFormat('a'.repeat(47))).toBe(false);
        expect(isValidCalendarTokenFormat('a'.repeat(49))).toBe(false);
        expect(isValidCalendarTokenFormat('G'.repeat(48))).toBe(false);
    });

    it('parses stored event types, dropping unknown values and defaulting to all', () => {
        expect(parseCalendarEventTypes(['scheduled', 'bogus', 'rmd'])).toEqual(['scheduled', 'rmd']);
        expect(parseCalendarEventTypes(undefined)).toEqual([...CALENDAR_EVENT_TYPES]);
        expect(parseCalendarEventTypes([])).toEqual([...CALENDAR_EVENT_TYPES]);
        expect(parseCalendarEventTypes(['nope'])).toEqual([...CALENDAR_EVENT_TYPES]);
    });

    it('resolves a valid token to its user/book/event types', async () => {
        db.$queryRaw.mockResolvedValueOnce([tokenRow()]);
        const resolved = await resolveCalendarFeedToken('a'.repeat(48));
        expect(resolved).toEqual({
            tokenId: 3,
            userId: 7,
            bookGuid: 'book1234book1234book1234book1234',
            eventTypes: ['scheduled', 'rmd'],
        });
    });

    it('rejects unknown, revoked, and malformed tokens', async () => {
        db.$queryRaw.mockResolvedValueOnce([]);
        expect(await resolveCalendarFeedToken('a'.repeat(48))).toBeNull();

        db.$queryRaw.mockResolvedValueOnce([tokenRow({ revoked_at: new Date() })]);
        expect(await resolveCalendarFeedToken('a'.repeat(48))).toBeNull();

        expect(await resolveCalendarFeedToken('not a token')).toBeNull();
    });

    it('creates a token, returning the plaintext secret exactly once', async () => {
        db.$queryRaw.mockImplementationOnce(async () => [tokenRow()]);
        const { token, secret } = await createCalendarFeedToken(
            7, 'book1234book1234book1234book1234', ['scheduled', 'rmd'],
        );
        expect(secret).toMatch(/^[0-9a-f]{48}$/);
        expect(token.userId).toBe(7);
        expect(token.eventTypes).toEqual(['scheduled', 'rmd']);
        expect(token.prefix).toHaveLength(8);
        // The record never exposes the hash or secret
        expect(JSON.stringify(token)).not.toContain(hashCalendarToken(secret));
    });
});
