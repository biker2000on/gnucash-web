/**
 * Natural-language quick-add parser tests (pure helpers, no DB, no AI).
 *
 * Fixed "today" = Sunday 2026-07-12 (UTC) so relative-date expectations are
 * deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveRelativeDate,
    validateAmount,
    validateParsedTransaction,
    buildParseMessages,
    isoDateUTC,
    MAX_PROMPT_ACCOUNTS,
    type CategoryAccount,
} from '../nl-parse';

// Sunday, 2026-07-12 (UTC)
const TODAY = new Date(Date.UTC(2026, 6, 12, 15, 30, 0));

const ACCOUNTS: CategoryAccount[] = [
    { guid: 'gas-guid-0000000000000000000000000', name: 'Expenses:Auto:Gas', account_type: 'EXPENSE' },
    { guid: 'food-guid-000000000000000000000000', name: 'Expenses:Food', account_type: 'EXPENSE' },
    { guid: 'salary-guid-0000000000000000000000', name: 'Income:Salary', account_type: 'INCOME' },
];

/* ------------------------------------------------------------------ */
/* resolveRelativeDate                                                 */
/* ------------------------------------------------------------------ */

describe('resolveRelativeDate', () => {
    it('resolves simple relative words (UTC)', () => {
        expect(resolveRelativeDate('today', TODAY)).toBe('2026-07-12');
        expect(resolveRelativeDate('now', TODAY)).toBe('2026-07-12');
        expect(resolveRelativeDate('yesterday', TODAY)).toBe('2026-07-11');
        expect(resolveRelativeDate('tomorrow', TODAY)).toBe('2026-07-13');
    });

    it('maps times of day onto calendar days', () => {
        expect(resolveRelativeDate('this morning', TODAY)).toBe('2026-07-12');
        expect(resolveRelativeDate('tonight', TODAY)).toBe('2026-07-12');
        expect(resolveRelativeDate('last night', TODAY)).toBe('2026-07-11');
    });

    it('resolves "last <weekday>" strictly before today', () => {
        // Today is Sunday; last Friday = 2026-07-10
        expect(resolveRelativeDate('last friday', TODAY)).toBe('2026-07-10');
        // "last sunday" on a Sunday means a full week back, not today
        expect(resolveRelativeDate('last sunday', TODAY)).toBe('2026-07-05');
        expect(resolveRelativeDate('last mon', TODAY)).toBe('2026-07-06');
    });

    it('resolves bare weekdays to the most recent occurrence (today included)', () => {
        expect(resolveRelativeDate('friday', TODAY)).toBe('2026-07-10');
        expect(resolveRelativeDate('on friday', TODAY)).toBe('2026-07-10');
        expect(resolveRelativeDate('sunday', TODAY)).toBe('2026-07-12'); // today
    });

    it('resolves "N days ago" and week phrases', () => {
        expect(resolveRelativeDate('3 days ago', TODAY)).toBe('2026-07-09');
        expect(resolveRelativeDate('1 day ago', TODAY)).toBe('2026-07-11');
        expect(resolveRelativeDate('a week ago', TODAY)).toBe('2026-07-05');
        expect(resolveRelativeDate('last week', TODAY)).toBe('2026-07-05');
    });

    it('passes through valid ISO dates and rejects invalid ones', () => {
        expect(resolveRelativeDate('2026-06-30', TODAY)).toBe('2026-06-30');
        expect(resolveRelativeDate('2026-02-30', TODAY)).toBeNull();
    });

    it('resolves month/day forms to the most recent past occurrence', () => {
        expect(resolveRelativeDate('7/4', TODAY)).toBe('2026-07-04');
        // Dec 25 has not happened yet in 2026 → previous year
        expect(resolveRelativeDate('12/25', TODAY)).toBe('2025-12-25');
        expect(resolveRelativeDate('7/4/2025', TODAY)).toBe('2025-07-04');
        expect(resolveRelativeDate('july 10', TODAY)).toBe('2026-07-10');
        expect(resolveRelativeDate('10 july', TODAY)).toBe('2026-07-10');
        expect(resolveRelativeDate('dec 25', TODAY)).toBe('2025-12-25');
        expect(resolveRelativeDate('july 4th, 2025', TODAY)).toBe('2025-07-04');
    });

    it('returns null for unrecognized hints and junk', () => {
        expect(resolveRelativeDate('whenever', TODAY)).toBeNull();
        expect(resolveRelativeDate('', TODAY)).toBeNull();
        expect(resolveRelativeDate(null, TODAY)).toBeNull();
        expect(resolveRelativeDate(undefined, TODAY)).toBeNull();
        expect(resolveRelativeDate('13/45', TODAY)).toBeNull();
    });

    it('formats with UTC components (no local-timezone bleed)', () => {
        // 23:30 UTC is "tomorrow" in UTC+2 local time; the resolver must stay UTC.
        const lateUTC = new Date(Date.UTC(2026, 6, 12, 23, 30, 0));
        expect(resolveRelativeDate('today', lateUTC)).toBe('2026-07-12');
        expect(isoDateUTC(lateUTC)).toBe('2026-07-12');
    });
});

/* ------------------------------------------------------------------ */
/* validateAmount                                                      */
/* ------------------------------------------------------------------ */

describe('validateAmount', () => {
    it('accepts positive numbers and rounds to 2 dp', () => {
        expect(validateAmount(6.5)).toBe(6.5);
        expect(validateAmount(40)).toBe(40);
        expect(validateAmount(6.505)).toBe(6.51);
    });

    it('accepts numeric strings with currency noise', () => {
        expect(validateAmount('6.50')).toBe(6.5);
        expect(validateAmount('$1,234.56')).toBe(1234.56);
        expect(validateAmount(' $40 ')).toBe(40);
    });

    it('rejects zero, negatives, non-numerics, and absurd values', () => {
        expect(validateAmount(0)).toBeNull();
        expect(validateAmount(-5)).toBeNull();
        expect(validateAmount('abc')).toBeNull();
        expect(validateAmount('-40')).toBeNull();
        expect(validateAmount(NaN)).toBeNull();
        expect(validateAmount(Infinity)).toBeNull();
        expect(validateAmount(2_000_000_000)).toBeNull();
        expect(validateAmount(null)).toBeNull();
        expect(validateAmount({ amount: 4 })).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* validateParsedTransaction                                           */
/* ------------------------------------------------------------------ */

describe('validateParsedTransaction', () => {
    const opts = { accounts: ACCOUNTS, today: TODAY, originalText: '$40 gas yesterday' };

    it('normalizes a full valid reply', () => {
        const result = validateParsedTransaction(
            {
                amount: 40,
                dateHint: 'yesterday',
                description: 'Gas',
                direction: 'expense',
                categoryGuid: ACCOUNTS[0].guid,
            },
            opts
        );
        expect(result).toEqual({
            ok: true,
            value: {
                amount: 40,
                date: '2026-07-11',
                description: 'Gas',
                direction: 'expense',
                suggestedCategoryGuid: ACCOUNTS[0].guid,
            },
        });
    });

    it('fails with a helpful error when the amount is missing/invalid', () => {
        const result = validateParsedTransaction({ description: 'gas' }, opts);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/amount/i);
    });

    it('nulls out a guid that is not in the book', () => {
        const result = validateParsedTransaction(
            { amount: 10, categoryGuid: 'not-a-real-guid', direction: 'expense' },
            opts
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.suggestedCategoryGuid).toBeNull();
    });

    it('nulls out a guid whose account type does not match the direction', () => {
        // Income account suggested for an expense
        const result = validateParsedTransaction(
            { amount: 10, categoryGuid: ACCOUNTS[2].guid, direction: 'expense' },
            opts
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.suggestedCategoryGuid).toBeNull();

        // Same guid is fine for income
        const income = validateParsedTransaction(
            { amount: 10, categoryGuid: ACCOUNTS[2].guid, direction: 'income' },
            opts
        );
        expect(income.ok).toBe(true);
        if (income.ok) expect(income.value.suggestedCategoryGuid).toBe(ACCOUNTS[2].guid);
    });

    it('defaults direction to expense and date to today', () => {
        const result = validateParsedTransaction({ amount: 12.34 }, opts);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.direction).toBe('expense');
            expect(result.value.date).toBe('2026-07-12');
        }
    });

    it('falls back to today when the date hint is unresolvable', () => {
        const result = validateParsedTransaction(
            { amount: 5, dateHint: 'whenever it was' },
            opts
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.date).toBe('2026-07-12');
    });

    it('falls back to the original text when description is missing', () => {
        const result = validateParsedTransaction({ amount: 40 }, opts);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.description).toBe('$40 gas yesterday');
    });

    it('accepts "date" as an alias for "dateHint"', () => {
        const result = validateParsedTransaction({ amount: 5, date: 'last friday' }, opts);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.date).toBe('2026-07-10');
    });
});

/* ------------------------------------------------------------------ */
/* buildParseMessages                                                  */
/* ------------------------------------------------------------------ */

describe('buildParseMessages', () => {
    it('embeds the account list (guid + type + name) in the system prompt', () => {
        const [system, user] = buildParseMessages('coffee 6.50 at Blue Bottle', ACCOUNTS);
        expect(system.role).toBe('system');
        expect(system.content).toContain(ACCOUNTS[0].guid);
        expect(system.content).toContain('Expenses:Auto:Gas');
        expect(system.content).toContain('INCOME');
        expect(user).toEqual({ role: 'user', content: 'coffee 6.50 at Blue Bottle' });
    });

    it('caps the number of accounts listed', () => {
        const many: CategoryAccount[] = Array.from({ length: MAX_PROMPT_ACCOUNTS + 50 }, (_, i) => ({
            guid: `guid-${i}`,
            name: `Expenses:Cat${i}`,
            account_type: 'EXPENSE',
        }));
        const [system] = buildParseMessages('x', many);
        expect(system.content).toContain(`guid-${MAX_PROMPT_ACCOUNTS - 1}`);
        expect(system.content).not.toContain(`guid-${MAX_PROMPT_ACCOUNTS} |`);
    });

    it('instructs the model to keep relative dates unresolved', () => {
        const [system] = buildParseMessages('x', ACCOUNTS);
        expect(system.content).toMatch(/do not convert relative dates/i);
    });
});
