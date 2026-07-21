import { describe, it, expect } from 'vitest';
import { pickCurrentBudget, budgetRange, budgetCovers, inferStartFromName } from '../budget-select';
import { parseBackupSettings, isBackupDue, defaultBackupSettings } from '../backup';

const budget = (guid: string, startIso: string, numPeriods: number, periodType = 'month', mult = 1) => ({
    guid,
    num_periods: numPeriods,
    recurrences: [{
        recurrence_mult: mult,
        recurrence_period_type: periodType,
        recurrence_period_start: new Date(startIso),
    }],
});

const NOW = new Date('2026-07-12T12:00:00Z');

describe('budgetRange / budgetCovers', () => {
    it('computes a 12-month budget range', () => {
        const range = budgetRange(budget('a', '2026-01-01T00:00:00Z', 12))!;
        expect(range.start.toISOString()).toContain('2026-01-01');
        expect(range.end.toISOString()).toContain('2027-01-01');
        expect(budgetCovers(budget('a', '2026-01-01T00:00:00Z', 12), NOW)).toBe(true);
    });

    it('handles weekly and yearly period types', () => {
        const weekly = budgetRange(budget('w', '2026-07-01T00:00:00Z', 4, 'week'))!;
        expect((weekly.end.getTime() - weekly.start.getTime()) / 86400000).toBe(28);
        const yearly = budgetRange(budget('y', '2024-01-01T00:00:00Z', 3, 'year'))!;
        expect(yearly.end.toISOString()).toContain('2027-01-01');
    });

    it('returns null without a recurrence', () => {
        expect(budgetRange({ guid: 'x', num_periods: 12, recurrences: [] })).toBeNull();
    });
});

describe('pickCurrentBudget', () => {
    it('prefers the budget covering now over older ones — the 2014 bug', () => {
        const budgets = [
            budget('2014', '2014-01-01T00:00:00Z', 12),
            budget('2026', '2026-01-01T00:00:00Z', 12),
            budget('2025', '2025-01-01T00:00:00Z', 12),
        ];
        expect(pickCurrentBudget(budgets, NOW)?.guid).toBe('2026');
    });

    it('falls back to the most recently ended budget', () => {
        const budgets = [
            budget('2014', '2014-01-01T00:00:00Z', 12),
            budget('2024', '2024-01-01T00:00:00Z', 12),
        ];
        expect(pickCurrentBudget(budgets, NOW)?.guid).toBe('2024');
    });

    it('falls back to the soonest upcoming budget when none cover or precede', () => {
        const budgets = [
            budget('2028', '2028-01-01T00:00:00Z', 12),
            budget('2027', '2027-01-01T00:00:00Z', 12),
        ];
        expect(pickCurrentBudget(budgets, NOW)?.guid).toBe('2027');
    });

    it('when several cover now, the latest-starting wins', () => {
        const budgets = [
            budget('multi-year', '2025-01-01T00:00:00Z', 36),
            budget('2026', '2026-01-01T00:00:00Z', 12),
        ];
        expect(pickCurrentBudget(budgets, NOW)?.guid).toBe('2026');
    });

    it('returns first budget when none have recurrences, null for empty', () => {
        expect(pickCurrentBudget([{ guid: 'only', num_periods: 12 }], NOW)?.guid).toBe('only');
        expect(pickCurrentBudget([], NOW)).toBeNull();
    });
});

describe('name-year fallback (budgets without recurrence rows)', () => {
    it('inferStartFromName finds a 4-digit year, else null', () => {
        expect(inferStartFromName('2026 Annual Budget')?.toISOString()).toContain('2026-01-01');
        expect(inferStartFromName('Budget 2014')?.toISOString()).toContain('2014-01-01');
        expect(inferStartFromName('Road to Retirement')).toBeNull();
        expect(inferStartFromName(undefined)).toBeNull();
    });

    it('budgetRange falls back to the name year with monthly periods', () => {
        const range = budgetRange({ guid: 'x', num_periods: 12, name: '2026 Annual Budget', recurrences: [] })!;
        expect(range.start.toISOString()).toContain('2026-01-01');
        expect(range.end.toISOString()).toContain('2027-01-01');
    });

    it('pickCurrentBudget prefers the covering budget by name year — the prod blank-start case', () => {
        const noRec = (guid: string, name: string) => ({ guid, name, num_periods: 12, recurrences: [] });
        const budgets = [
            noRec('2014', '2014 Budget'),
            noRec('2026', '2026 Annual Budget'),
            noRec('2025', '2025 Budget'),
        ];
        expect(pickCurrentBudget(budgets, NOW)?.guid).toBe('2026');
    });
});

describe('backup settings', () => {
    it('parses valid settings and clamps garbage to defaults', () => {
        expect(parseBackupSettings({ frequency: 'weekly', hourUtc: 5, retention: 14 })).toEqual({
            frequency: 'weekly', hourUtc: 5, retention: 14,
        });
        const defaults = defaultBackupSettings();
        expect(parseBackupSettings({ frequency: 'hourly', hourUtc: 99, retention: -2 })).toEqual(defaults);
        expect(parseBackupSettings(null)).toEqual(defaults);
    });

    it('isBackupDue honors frequency', () => {
        const sunday = new Date('2026-07-12T02:30:00Z');   // Sunday
        const monday = new Date('2026-07-13T02:30:00Z');
        const first = new Date('2026-08-01T02:30:00Z');
        expect(isBackupDue('daily', monday)).toBe(true);
        expect(isBackupDue('weekly', sunday)).toBe(true);
        expect(isBackupDue('weekly', monday)).toBe(false);
        expect(isBackupDue('monthly', first)).toBe(true);
        expect(isBackupDue('monthly', monday)).toBe(false);
    });
});
