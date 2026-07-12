/**
 * Natural-language quick-add parsing helpers.
 *
 * Pure functions supporting the /api/ai/parse-transaction endpoint:
 *  - relative-date resolution ("yesterday", "last friday", "this morning"),
 *    done server-side in UTC so the model never has to know today's date
 *  - amount validation
 *  - validation of the model's JSON reply, including checking the suggested
 *    category GUID against the book's real expense/income accounts
 *
 * Everything here is deterministic and side-effect free (exported for unit
 * tests in src/lib/__tests__/nl-parse.test.ts).
 */

export type NlDirection = 'expense' | 'income';

export interface ParsedNlTransaction {
    /** Positive decimal amount, rounded to 2 dp */
    amount: number;
    /** Resolved absolute date, YYYY-MM-DD (UTC) */
    date: string;
    description: string;
    direction: NlDirection;
    /** Category GUID validated against the book, or null when none matched */
    suggestedCategoryGuid: string | null;
}

export interface CategoryAccount {
    guid: string;
    name: string;
    account_type: string; // 'EXPENSE' | 'INCOME'
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** Format a Date as YYYY-MM-DD using its UTC components. */
export function isoDateUTC(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function addDaysUTC(d: Date, days: number): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

const WEEKDAYS = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
] as const;

const MONTHS: Record<string, number> = {
    january: 0, jan: 0,
    february: 1, feb: 1,
    march: 2, mar: 2,
    april: 3, apr: 3,
    may: 4,
    june: 5, jun: 5,
    july: 6, jul: 6,
    august: 7, aug: 7,
    september: 8, sep: 8, sept: 8,
    october: 9, oct: 9,
    november: 10, nov: 10,
    december: 11, dec: 11,
};

function weekdayIndex(word: string): number {
    const w = word.toLowerCase();
    return WEEKDAYS.findIndex(d => d === w || d.slice(0, 3) === w);
}

function isValidYmd(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const d = new Date(Date.UTC(year, month - 1, day));
    return (
        d.getUTCFullYear() === year &&
        d.getUTCMonth() === month - 1 &&
        d.getUTCDate() === day
    );
}

/**
 * Resolve a natural-language date hint to an absolute YYYY-MM-DD (UTC),
 * relative to `today`. Returns null when the hint isn't recognized (callers
 * should fall back to today).
 *
 * Conventions (expense capture is about the recent past):
 *  - "today", "now", "this morning/afternoon/evening", "tonight"  → today
 *  - "yesterday", "last night"                                    → today - 1
 *  - "tomorrow"                                                   → today + 1
 *  - "N days ago", "a week ago", "last week"                      → today - N
 *  - bare weekday ("friday", "on fri")   → most recent occurrence, today included
 *  - "last <weekday>"                    → most recent occurrence strictly before today
 *  - "2026-07-10", "7/10", "7/10/2026", "july 10", "10 july"      → that date
 *    (month/day forms without a year resolve to the most recent past occurrence)
 */
export function resolveRelativeDate(hint: string | null | undefined, today: Date): string | null {
    if (!hint || typeof hint !== 'string') return null;
    const text = hint.trim().toLowerCase().replace(/[.,!?]+$/g, '');
    if (!text) return null;

    // Absolute ISO date
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
        const [, y, m, d] = iso;
        return isValidYmd(+y, +m, +d) ? `${y}-${m}-${d}` : null;
    }

    // Simple relative words
    if (/^(today|now|this (morning|afternoon|evening|noon)|tonight|earlier today)$/.test(text)) {
        return isoDateUTC(today);
    }
    if (/^(yesterday|last night|yesterday (morning|afternoon|evening))$/.test(text)) {
        return isoDateUTC(addDaysUTC(today, -1));
    }
    if (text === 'tomorrow') {
        return isoDateUTC(addDaysUTC(today, 1));
    }
    if (/^(a|one) week ago$/.test(text) || text === 'last week') {
        return isoDateUTC(addDaysUTC(today, -7));
    }
    const daysAgo = text.match(/^(\d{1,3}) days? ago$/);
    if (daysAgo) {
        return isoDateUTC(addDaysUTC(today, -parseInt(daysAgo[1], 10)));
    }

    // Weekdays: "last friday" (strictly before today) / "friday" / "on friday"
    const lastWeekday = text.match(/^last\s+([a-z]+)$/);
    if (lastWeekday) {
        const target = weekdayIndex(lastWeekday[1]);
        if (target >= 0) {
            const diff = (today.getUTCDay() - target + 7) % 7 || 7;
            return isoDateUTC(addDaysUTC(today, -diff));
        }
        return null;
    }
    const bareWeekday = text.match(/^(?:on\s+|this\s+)?([a-z]+)$/);
    if (bareWeekday) {
        const target = weekdayIndex(bareWeekday[1]);
        if (target >= 0) {
            const diff = (today.getUTCDay() - target + 7) % 7; // 0 = today
            return isoDateUTC(addDaysUTC(today, -diff));
        }
        // fall through: might be a month name alone (unsupported) or noise
    }

    // US numeric dates: M/D or M/D/YYYY
    const slash = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (slash) {
        const month = parseInt(slash[1], 10);
        const day = parseInt(slash[2], 10);
        let year = slash[3] ? parseInt(slash[3], 10) : today.getUTCFullYear();
        if (slash[3] && slash[3].length === 2) year += 2000;
        if (!isValidYmd(year, month, day)) return null;
        if (!slash[3]) {
            // No year given: pick the most recent past occurrence.
            const candidate = new Date(Date.UTC(year, month - 1, day));
            if (candidate > today) year -= 1;
        }
        return isValidYmd(year, month, day)
            ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            : null;
    }

    // "july 10", "july 10 2026", "10 july", "jul 10th"
    const monthDay =
        text.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/) ||
        text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:,?\s+(\d{4}))?$/);
    if (monthDay) {
        const first = monthDay[1];
        const second = monthDay[2];
        const monthWord = /^\d/.test(first) ? second : first;
        const dayWord = /^\d/.test(first) ? first : second;
        const monthIdx = MONTHS[monthWord];
        if (monthIdx !== undefined) {
            const day = parseInt(dayWord, 10);
            let year = monthDay[3] ? parseInt(monthDay[3], 10) : today.getUTCFullYear();
            if (!isValidYmd(year, monthIdx + 1, day)) return null;
            if (!monthDay[3]) {
                const candidate = new Date(Date.UTC(year, monthIdx, day));
                if (candidate > today) year -= 1;
            }
            return isValidYmd(year, monthIdx + 1, day)
                ? `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                : null;
        }
    }

    return null;
}

/* ------------------------------------------------------------------ */
/* Amounts                                                             */
/* ------------------------------------------------------------------ */

const MAX_AMOUNT = 1_000_000_000;

/**
 * Validate an amount coming back from the model. Accepts a number or a
 * numeric string (optionally with $ and thousands separators). Returns the
 * positive value rounded to 2 dp, or null when unusable.
 */
export function validateAmount(value: unknown): number | null {
    let n: number;
    if (typeof value === 'number') {
        n = value;
    } else if (typeof value === 'string') {
        const cleaned = value.replace(/[$,\s]/g, '');
        if (!/^\d*\.?\d+$/.test(cleaned)) return null;
        n = parseFloat(cleaned);
    } else {
        return null;
    }
    if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
    return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

export interface ValidateNlOptions {
    /** Expense + income accounts of the active book (guid check) */
    accounts: CategoryAccount[];
    /** "Now" used for relative-date resolution */
    today: Date;
    /** Original user text (description fallback) */
    originalText?: string;
}

export type ValidateNlResult =
    | { ok: true; value: ParsedNlTransaction }
    | { ok: false; error: string };

/**
 * Validate the model's JSON reply and normalize it into a ParsedNlTransaction.
 * The suggested category GUID is only kept when it exists in the provided
 * account list AND its account type matches the parsed direction.
 */
export function validateParsedTransaction(
    raw: Record<string, unknown>,
    options: ValidateNlOptions
): ValidateNlResult {
    const amount = validateAmount(raw.amount);
    if (amount === null) {
        return { ok: false, error: 'Could not find an amount in that text. Try including a number, e.g. "$40 gas yesterday".' };
    }

    const direction: NlDirection = raw.direction === 'income' ? 'income' : 'expense';

    const dateHint =
        typeof raw.date === 'string'
            ? raw.date
            : typeof raw.dateHint === 'string'
                ? raw.dateHint
                : null;
    const date = resolveRelativeDate(dateHint, options.today) ?? isoDateUTC(options.today);

    let description =
        typeof raw.description === 'string' ? raw.description.trim().slice(0, 200) : '';
    if (!description) {
        description = (options.originalText ?? '').trim().slice(0, 200);
    }

    let suggestedCategoryGuid: string | null = null;
    const rawGuid = typeof raw.categoryGuid === 'string' ? raw.categoryGuid.trim() : '';
    if (rawGuid) {
        const wantedType = direction === 'expense' ? 'EXPENSE' : 'INCOME';
        const match = options.accounts.find(a => a.guid === rawGuid);
        if (match && match.account_type === wantedType) {
            suggestedCategoryGuid = match.guid;
        }
    }

    return {
        ok: true,
        value: { amount, date, description, direction, suggestedCategoryGuid },
    };
}

/* ------------------------------------------------------------------ */
/* Prompt building                                                     */
/* ------------------------------------------------------------------ */

/** Cap on how many category accounts we list in the prompt. */
export const MAX_PROMPT_ACCOUNTS = 200;

/**
 * Build the chat messages for the parse call. The model returns relative
 * dates verbatim (as `dateHint`) — resolution to an absolute date happens
 * server-side in resolveRelativeDate, against the request-time "today".
 */
export function buildParseMessages(
    text: string,
    accounts: CategoryAccount[]
): Array<{ role: 'system' | 'user'; content: string }> {
    const list = accounts
        .slice(0, MAX_PROMPT_ACCOUNTS)
        .map(a => `${a.guid} | ${a.account_type} | ${a.name}`)
        .join('\n');

    const system = [
        'You parse a short natural-language note about a personal financial transaction into JSON.',
        'Reply with ONLY a JSON object, no markdown fences, using exactly these keys:',
        '{',
        '  "amount": number,            // positive decimal, no currency symbol',
        '  "dateHint": string,          // the date words from the text, verbatim (e.g. "yesterday", "last friday", "7/4"); "today" if none',
        '  "description": string,       // short human description including the merchant if mentioned',
        '  "direction": "expense" | "income",',
        '  "categoryGuid": string|null  // the guid of the best-matching account from the list below, or null',
        '}',
        'Do NOT convert relative dates to absolute dates — return the date words as written.',
        'Pick categoryGuid only from the provided list; the account type must match the direction.',
        'Available category accounts (guid | type | name):',
        list || '(none)',
    ].join('\n');

    return [
        { role: 'system', content: system },
        { role: 'user', content: text },
    ];
}
