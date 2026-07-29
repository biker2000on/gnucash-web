/**
 * iCal (RFC 5545) calendar feed builder.
 *
 * Pure ICS generation (escaping, 75-octet line folding, CRLF terminators,
 * VCALENDAR/VEVENT structure with all-day DTSTART) plus pure event
 * collectors that turn already-loaded financial data into calendar events:
 *
 *   - upcoming scheduled-transaction occurrences (90 days out)
 *   - fixed-income maturities and estimated coupon payments
 *   - RMD deadlines (April 1 after the RMD start year + Dec 31 annually)
 *
 * The async `buildCalendarFeed()` orchestrator is the only part that touches
 * the database; each collector is book-scoped and independently try/caught so
 * one failing source never breaks the whole feed.
 */

import { computeNextOccurrences, type RecurrencePattern } from '@/lib/recurrence';
import { parseGnuCashDate } from '@/lib/scheduled-transactions';
import { rmdStartAge } from '@/lib/drawdown/rmd';
import type { UpcomingMaturity, CouponPaymentEstimate } from '@/lib/fixed-income';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export const CALENDAR_EVENT_TYPES = [
    'scheduled',
    'fixed_income',
    'rmd',
    'compliance',
    'renewal',
    'home',
    'invoice',
    'goal',
    'equity_comp',
    'report_schedule',
    'plan',
] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export interface IcsEvent {
    /** Globally unique, stable identifier (RFC 5545 UID). */
    uid: string;
    /** All-day event date: a Date or an ISO YYYY-MM-DD string. */
    date: Date | string;
    summary: string;
    description?: string;
}

/* ------------------------------------------------------------------ */
/* Pure ICS building blocks                                            */
/* ------------------------------------------------------------------ */

/** Escape text per RFC 5545 §3.3.11: backslash, semicolon, comma, newline. */
export function escapeIcsText(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a single content line at 75 octets (RFC 5545 §3.1). Continuation
 * lines begin with a single space, which counts toward their 75 octets.
 * Multi-byte UTF-8 characters are never split.
 */
export function foldIcsLine(line: string): string[] {
    const LIMIT = 75;
    const out: string[] = [];
    let current = '';
    let currentBytes = 0;

    for (const ch of line) {
        const chBytes = Buffer.byteLength(ch, 'utf8');
        if (currentBytes + chBytes > LIMIT) {
            out.push(current);
            current = ' ';
            currentBytes = 1;
        }
        current += ch;
        currentBytes += chBytes;
    }
    out.push(current);
    return out;
}

/** Format an all-day date value as YYYYMMDD (local date). */
export function formatIcsDate(date: Date | string): string {
    if (typeof date === 'string') {
        // ISO YYYY-MM-DD → YYYYMMDD
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
        if (m) return `${m[1]}${m[2]}${m[3]}`;
        const parsed = parseGnuCashDate(date);
        if (!parsed) throw new Error(`Unparseable ICS date: ${date}`);
        return formatIcsDate(parsed);
    }
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

/** Format a UTC timestamp as YYYYMMDDTHHMMSSZ (for DTSTAMP). */
export function formatIcsDateTime(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface BuildIcsOptions {
    calendarName?: string;
    /** Timestamp used for DTSTAMP; defaults to the current time. */
    now?: Date;
}

/**
 * Build a complete VCALENDAR document. Lines are folded at 75 octets and
 * joined with CRLF; the document ends with a trailing CRLF.
 */
export function buildIcs(events: IcsEvent[], options: BuildIcsOptions = {}): string {
    const name = options.calendarName ?? 'GnuCash Web';
    const dtstamp = formatIcsDateTime(options.now ?? new Date());

    const lines: string[] = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//GnuCash Web//Calendar Feed//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeIcsText(name)}`,
    ];

    for (const event of events) {
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${escapeIcsText(event.uid)}`);
        lines.push(`DTSTAMP:${dtstamp}`);
        lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(event.date)}`);
        lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
        if (event.description) {
            lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
        }
        lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    return lines.flatMap(foldIcsLine).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function toIsoDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatAmount(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ */
/* Collector 1: scheduled-transaction occurrences (pure)               */
/* ------------------------------------------------------------------ */

/** Structural subset of ScheduledTransaction from '@/lib/scheduled-transactions'. */
export interface ScheduledEventSource {
    guid: string;
    name: string;
    enabled: boolean;
    endDate: string | null;
    lastOccur: string | null;
    remainingOccurrences: number;
    recurrence: {
        periodType: string;
        mult: number;
        periodStart: string;
        weekendAdjust: string;
    } | null;
    splits: Array<{ accountGuid: string; accountName: string; amount: number }>;
}

export const SCHEDULED_HORIZON_DAYS = 90;

/**
 * Upcoming occurrences (today .. today + horizonDays) for enabled scheduled
 * transactions, computed the same way the scheduled-transactions page does
 * (recurrence pattern + lastOccur + endDate + remaining-occurrence cap).
 */
export function scheduledTransactionEvents(
    transactions: ScheduledEventSource[],
    now: Date,
    horizonDays: number = SCHEDULED_HORIZON_DAYS,
): IcsEvent[] {
    const today = startOfDay(now);
    const horizon = addDays(today, horizonDays);
    const events: IcsEvent[] = [];

    for (const tx of transactions) {
        if (!tx.enabled || !tx.recurrence) continue;

        const periodStart = parseGnuCashDate(tx.recurrence.periodStart);
        if (!periodStart) continue;

        const pattern: RecurrencePattern = {
            periodType: tx.recurrence.periodType,
            mult: tx.recurrence.mult || 1,
            periodStart,
            weekendAdjust: tx.recurrence.weekendAdjust || 'none',
        };

        const lastOccur = parseGnuCashDate(tx.lastOccur);
        const txEnd = parseGnuCashDate(tx.endDate);
        const effectiveEnd = txEnd && txEnd < horizon ? txEnd : horizon;
        const remaining = tx.remainingOccurrences > 0 ? tx.remainingOccurrences : null;

        // afterDate is exclusive; step back one day so today's occurrence is kept.
        const dates = computeNextOccurrences(
            pattern, lastOccur, effectiveEnd, remaining, 100, addDays(today, -1),
        );

        const description = tx.splits.length > 0
            ? tx.splits.map(s => `${s.accountName}: ${formatAmount(s.amount)}`).join('\n')
            : undefined;

        for (const date of dates) {
            events.push({
                uid: `sx-${tx.guid}-${formatIcsDate(date)}@gnucash-web`,
                date,
                summary: `Scheduled: ${tx.name}`,
                description,
            });
        }
    }

    return events;
}

/* ------------------------------------------------------------------ */
/* Collector 2: fixed-income maturities + coupons (pure)               */
/* ------------------------------------------------------------------ */

const KIND_LABELS: Record<string, string> = {
    bond: 'Bond',
    cd: 'CD',
    treasury: 'Treasury',
    ibond: 'I-Bond',
};

/** Calendar events for fixed-income maturities and estimated coupon payments. */
export function fixedIncomeEvents(
    maturities: UpcomingMaturity[],
    coupons: CouponPaymentEstimate[],
): IcsEvent[] {
    const events: IcsEvent[] = [];

    for (const m of maturities) {
        const kind = KIND_LABELS[m.kind] ?? m.kind;
        events.push({
            uid: `fi-maturity-${m.accountGuid}-${formatIcsDate(m.maturityDate)}@gnucash-web`,
            date: m.maturityDate,
            summary: `${kind} matures: ${m.accountName}`,
            description: `Face value ${formatAmount(m.faceValue)}, current value ${formatAmount(m.currentValue)}`,
        });
    }

    for (const c of coupons) {
        const kind = KIND_LABELS[c.kind] ?? c.kind;
        events.push({
            uid: `fi-coupon-${c.accountGuid}-${formatIcsDate(c.date)}@gnucash-web`,
            date: c.date,
            summary: `Coupon payment: ${c.accountName}`,
            description: `Estimated ${kind.toLowerCase()} coupon of ${formatAmount(c.amount)}`,
        });
    }

    return events;
}

/* ------------------------------------------------------------------ */
/* Collector 3: RMD deadlines (pure)                                   */
/* ------------------------------------------------------------------ */

export const RMD_HORIZON_DAYS = 365;

/**
 * RMD deadline events derived from the user's birthday:
 *   - the first RMD may be delayed until April 1 of the year AFTER the year
 *     the owner reaches the SECURE 2.0 start age, and
 *   - every RMD year's regular deadline is December 31.
 * Only events within [today, today + horizonDays] are emitted.
 */
export function rmdEvents(
    birthday: string | null,
    now: Date,
    horizonDays: number = RMD_HORIZON_DAYS,
): IcsEvent[] {
    if (!birthday || !/^\d{4}-\d{2}-\d{2}/.test(birthday)) return [];
    const birthYear = parseInt(birthday.slice(0, 4), 10);
    if (!Number.isFinite(birthYear) || birthYear < 1900 || birthYear > now.getFullYear()) return [];

    const startAge = rmdStartAge(birthYear);
    const startYear = birthYear + startAge;

    const today = startOfDay(now);
    const horizon = addDays(today, horizonDays);
    const inWindow = (d: Date) => d.getTime() >= today.getTime() && d.getTime() <= horizon.getTime();

    const events: IcsEvent[] = [];

    // First RMD deadline: April 1 of the year after the start year.
    const firstDeadline = new Date(startYear + 1, 3, 1);
    if (inWindow(firstDeadline)) {
        events.push({
            uid: `rmd-first-${startYear}@gnucash-web`,
            date: firstDeadline,
            summary: 'First RMD deadline (April 1)',
            description:
                `Deadline for your first required minimum distribution — for the year you turned ${startAge}. ` +
                'Note: taking it this late means a second RMD is also due by December 31 this year.',
        });
    }

    // Annual December 31 deadlines for every RMD year in the window.
    for (let year = Math.max(startYear, today.getFullYear() - 1); year <= horizon.getFullYear(); year++) {
        const deadline = new Date(year, 11, 31);
        if (!inWindow(deadline)) continue;
        events.push({
            uid: `rmd-${year}@gnucash-web`,
            date: deadline,
            summary: `RMD deadline for ${year} (December 31)`,
            description: `Required minimum distribution for tax year ${year} must be taken by December 31, ${year}.`,
        });
    }

    return events;
}

/* ------------------------------------------------------------------ */
/* Collector 4: compliance deadlines (pure)                            */
/* ------------------------------------------------------------------ */

export const COMPLIANCE_HORIZON_DAYS = 365;

/** Structural subset of ComplianceItem from '@/lib/compliance'. */
export interface ComplianceEventSource {
    key: string;
    title: string;
    description: string;
    /** ISO YYYY-MM-DD */
    dueDate: string;
    period: string;
}

/**
 * Calendar events for still-pending compliance deadlines within
 * [today, today + horizonDays]. `resolvedKeys` holds `${key}|${period}`
 * entries for items already marked done/dismissed — those are skipped.
 */
export function complianceDeadlineEvents(
    items: ComplianceEventSource[],
    resolvedKeys: Set<string>,
    now: Date,
    horizonDays: number = COMPLIANCE_HORIZON_DAYS,
): IcsEvent[] {
    const today = toIsoDate(startOfDay(now));
    const horizon = toIsoDate(addDays(startOfDay(now), horizonDays));

    return items
        .filter(i =>
            i.dueDate >= today &&
            i.dueDate <= horizon &&
            !resolvedKeys.has(`${i.key}|${i.period}`),
        )
        .map(i => ({
            uid: `compliance-${i.key}-${i.period}@gnucash-web`,
            date: i.dueDate,
            summary: `Due: ${i.title}`,
            description: i.description,
        }));
}

/* ------------------------------------------------------------------ */
/* Async orchestrator (DB access lives here)                           */
/* ------------------------------------------------------------------ */

function sortByDate(events: IcsEvent[]): IcsEvent[] {
    return [...events].sort((a, b) => {
        const da = typeof a.date === 'string' ? a.date : toIsoDate(a.date);
        const db = typeof b.date === 'string' ? b.date : toIsoDate(b.date);
        return da.localeCompare(db) || a.uid.localeCompare(b.uid);
    });
}

/** All account GUIDs under a book's root (no session required — feed route is public). */
export async function getAccountGuidsForBookGuid(bookGuid: string): Promise<string[]> {
    const prisma = (await import('@/lib/prisma')).default;
    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) return [];
    const rows = await prisma.$queryRaw<Array<{ guid: string }>>`
        WITH RECURSIVE account_tree AS (
            SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
            UNION ALL
            SELECT a.guid FROM accounts a
            JOIN account_tree t ON a.parent_guid = t.guid
        )
        SELECT guid FROM account_tree
    `;
    return rows.map(r => r.guid);
}

/**
 * Build the ICS document for a feed token's user/book/event-type selection.
 * Each collector is independently try/caught: a failure in one data source
 * degrades the feed instead of breaking it.
 */
export async function buildCalendarFeed(
    userId: number,
    bookGuid: string,
    eventTypes: CalendarEventType[],
    now: Date = new Date(),
): Promise<string> {
    const events: IcsEvent[] = [];
    const bookAccountGuids = await getAccountGuidsForBookGuid(bookGuid);
    const bookAccountSet = new Set(bookAccountGuids);

    if (eventTypes.includes('scheduled')) {
        try {
            const { fetchScheduledTransactions } = await import('@/lib/scheduled-transactions');
            const all = await fetchScheduledTransactions(true);
            // Book scoping: keep transactions whose resolved splits touch this book.
            const scoped = all.filter(tx => tx.splits.some(s => bookAccountSet.has(s.accountGuid)));
            events.push(...scheduledTransactionEvents(scoped, now));
        } catch (err) {
            console.warn('Calendar feed: scheduled-transaction collector failed:', err);
        }
    }

    if (eventTypes.includes('fixed_income')) {
        try {
            const { loadFixedIncomePositions, summarizeFixedIncome } = await import('@/lib/fixed-income');
            const positions = await loadFixedIncomePositions(bookAccountGuids, now);
            const summary = summarizeFixedIncome(positions, now);
            events.push(...fixedIncomeEvents(summary.upcomingMaturities, summary.couponPayments));
        } catch (err) {
            console.warn('Calendar feed: fixed-income collector failed:', err);
        }
    }

    if (eventTypes.includes('rmd')) {
        try {
            const { getPreference } = await import('@/lib/user-preferences');
            const birthday = await getPreference<string | null>(userId, 'birthday', null);
            events.push(...rmdEvents(birthday, now));
        } catch (err) {
            console.warn('Calendar feed: RMD collector failed:', err);
        }
    }

    if (eventTypes.includes('compliance')) {
        try {
            const prisma = (await import('@/lib/prisma')).default;
            const { complianceItemsForYear } = await import('@/lib/compliance');
            const { ENTITY_TYPES } = await import('@/lib/services/entity.service');

            const profile = await prisma.gnucash_web_entity_profiles.findUnique({
                where: { book_guid: bookGuid },
            });
            const entityType =
                profile && (ENTITY_TYPES as readonly string[]).includes(profile.entity_type)
                    ? (profile.entity_type as (typeof ENTITY_TYPES)[number])
                    : 'household';
            const taxState = profile?.tax_state ?? null;
            const businessActivity =
                profile?.business_activity === 'farm' ? ('farm' as const) : ('general' as const);

            const year = now.getFullYear();
            const items = [
                ...complianceItemsForYear(entityType, taxState, year, businessActivity),
                ...complianceItemsForYear(entityType, taxState, year + 1, businessActivity),
            ];
            const statusRows = await prisma.gnucash_web_compliance_status.findMany({
                where: { book_guid: bookGuid },
                select: { item_key: true, period: true },
            });
            const resolvedKeys = new Set(statusRows.map(r => `${r.item_key}|${r.period}`));
            events.push(...complianceDeadlineEvents(items, resolvedKeys, now));
            const { getFarmCertificateObligations } = await import('@/lib/tax/farm-certificates');
            const certificateItems = await getFarmCertificateObligations(bookGuid);
            events.push(...certificateItems.map(item => ({
                uid: `${item.key}@gnucash-web`,
                date: item.dueDate,
                summary: `Due: ${item.title}`,
                description: item.description,
            })));
        } catch (err) {
            console.warn('Calendar feed: compliance collector failed:', err);
        }
    }

    const timelineTypes = eventTypes.filter(type =>
        ['renewal', 'home', 'invoice', 'goal', 'equity_comp', 'report_schedule', 'plan'].includes(type),
    );
    if (timelineTypes.length > 0) {
        try {
            const { collectFinancialEventsForBook } = await import('@/lib/money-timeline/service');
            const timeline = await collectFinancialEventsForBook(userId, bookGuid, now);
            events.push(...timeline.events
                .filter(event => timelineTypes.includes(event.domain as CalendarEventType))
                .map(event => ({
                    uid: `timeline-${event.id.replace(/[^a-zA-Z0-9.-]/g, '-')}@gnucash-web`,
                    date: event.date,
                    summary: event.title,
                    description: [
                        event.description,
                        event.cashImpact === null
                            ? null
                            : `Expected cash impact: ${event.cashImpact.toFixed(2)} ${event.currency}`,
                        event.href ? `Open in GnuCash Web: ${event.href}` : null,
                    ].filter(Boolean).join('\n'),
                })));
        } catch (err) {
            console.warn('Calendar feed: Money Timeline collector failed:', err);
        }
    }

    return buildIcs(sortByDate(events), { now });
}
