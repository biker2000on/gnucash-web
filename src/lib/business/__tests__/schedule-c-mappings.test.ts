/**
 * Schedule C mapping overrides — pure-logic tests.
 *
 *   - partitionMappingChanges: valid upsert, null → delete, invalid line
 *     rejected, out-of-book / malformed guid rejected.
 *   - isValidScheduleCLine membership.
 *   - buildScheduleC override precedence: a valid override wins over the
 *     keyword heuristic and moves the account's amount to the chosen line;
 *     an invalid override falls back to keyword; omitting overrides is a
 *     no-op regression of the keyword-only behavior.
 */

import { describe, it, expect } from 'vitest';
import { buildScheduleC, type ScheduleCAccountInput } from '../business-reports';
import {
    isValidScheduleCLine,
    partitionMappingChanges,
    ScheduleCMappingValidationError,
} from '../schedule-c-mappings';

const GUID_A = 'a'.repeat(32);
const GUID_B = 'b'.repeat(32);

const acct = (
    guid: string,
    name: string,
    total: number,
    type: 'INCOME' | 'EXPENSE' = 'EXPENSE',
): ScheduleCAccountInput => ({
    guid,
    name,
    path: `${type === 'INCOME' ? 'Income' : 'Expenses'}:${name}`,
    type,
    total,
});

/* ------------------------------------------------------------------ */
/* isValidScheduleCLine                                                 */
/* ------------------------------------------------------------------ */

describe('isValidScheduleCLine', () => {
    it('accepts labelled expense lines', () => {
        expect(isValidScheduleCLine('8')).toBe(true);
        expect(isValidScheduleCLine('24b')).toBe(true);
        expect(isValidScheduleCLine('27a')).toBe(true);
    });

    it('rejects the income line, unknown lines, and non-strings', () => {
        expect(isValidScheduleCLine('1')).toBe(false); // income, not overridable
        expect(isValidScheduleCLine('99')).toBe(false);
        expect(isValidScheduleCLine('')).toBe(false);
        expect(isValidScheduleCLine(null)).toBe(false);
        expect(isValidScheduleCLine(8)).toBe(false);
    });
});

/* ------------------------------------------------------------------ */
/* partitionMappingChanges                                             */
/* ------------------------------------------------------------------ */

describe('partitionMappingChanges', () => {
    const book = new Set([GUID_A, GUID_B]);

    it('collects a valid line as an upsert', () => {
        const { upserts, deletes } = partitionMappingChanges(
            [{ accountGuid: GUID_A, line: '18' }],
            book,
        );
        expect(upserts).toEqual([{ accountGuid: GUID_A, line: '18' }]);
        expect(deletes).toEqual([]);
    });

    it('treats a null line as a delete (unmap)', () => {
        const { upserts, deletes } = partitionMappingChanges(
            [{ accountGuid: GUID_B, line: null }],
            book,
        );
        expect(upserts).toEqual([]);
        expect(deletes).toEqual([GUID_B]);
    });

    it('rejects an invalid Schedule C line', () => {
        expect(() =>
            partitionMappingChanges([{ accountGuid: GUID_A, line: '999' }], book),
        ).toThrow(ScheduleCMappingValidationError);
    });

    it('rejects the income line 1 as an override target', () => {
        expect(() =>
            partitionMappingChanges([{ accountGuid: GUID_A, line: '1' }], book),
        ).toThrow(ScheduleCMappingValidationError);
    });

    it('rejects an out-of-book account guid', () => {
        expect(() =>
            partitionMappingChanges([{ accountGuid: 'c'.repeat(32), line: '18' }], book),
        ).toThrow(ScheduleCMappingValidationError);
    });

    it('rejects a malformed (wrong length) guid', () => {
        expect(() =>
            partitionMappingChanges([{ accountGuid: 'short', line: '18' }], book),
        ).toThrow(ScheduleCMappingValidationError);
    });
});

/* ------------------------------------------------------------------ */
/* buildScheduleC override precedence                                  */
/* ------------------------------------------------------------------ */

describe('buildScheduleC with overrides', () => {
    it('routes an account to the chosen line, overriding the keyword guess', () => {
        // "Advertising" keyword-maps to line 8; override it to Office (18).
        const report = buildScheduleC(
            2025,
            [acct(GUID_A, 'Advertising', 2000)],
            { [GUID_A]: '18' },
        );
        const byLine = new Map(report.lines.map((l) => [l.line, l]));
        expect(byLine.get('8')!.amount).toBe(0);
        expect(byLine.get('18')!.amount).toBe(2000);
        expect(report.overriddenCount).toBe(1);
        expect(report.unmappedCount).toBe(0);
        const detail = byLine.get('18')!.accounts[0];
        expect(detail.suggestedLine).toBe('8');
        expect(detail.mappedLine).toBe('18');
    });

    it('maps an otherwise-unmapped account and keeps it off 27a', () => {
        const report = buildScheduleC(
            2025,
            [acct(GUID_A, 'Mystery Costs', 500)],
            { [GUID_A]: '22' },
        );
        const byLine = new Map(report.lines.map((l) => [l.line, l]));
        expect(byLine.get('22')!.amount).toBe(500);
        expect(byLine.get('27a')!.amount).toBe(0);
        expect(report.unmappedCount).toBe(0);
        expect(report.overriddenCount).toBe(1);
    });

    it('totals reflect an override moving spend onto a 50% meals line', () => {
        // Supplies (line 22, full deduction) overridden to Meals (24b, 50%).
        const full = buildScheduleC(2025, [
            acct(GUID_A, 'Consulting', -10000, 'INCOME'),
            acct(GUID_B, 'Supplies', 1000),
        ]);
        expect(full.totalExpenses).toBe(1000);
        expect(full.netProfit).toBe(9000);

        const overridden = buildScheduleC(
            2025,
            [
                acct(GUID_A, 'Consulting', -10000, 'INCOME'),
                acct(GUID_B, 'Supplies', 1000),
            ],
            { [GUID_B]: '24b' },
        );
        const meals = overridden.lines.find((l) => l.line === '24b')!;
        expect(meals.amount).toBe(1000);
        expect(meals.deductible).toBe(500);
        expect(overridden.totalExpenses).toBe(500);
        expect(overridden.netProfit).toBe(9500);
    });

    it('ignores an invalid override line and falls back to the keyword', () => {
        const report = buildScheduleC(
            2025,
            [acct(GUID_A, 'Advertising', 2000)],
            { [GUID_A]: 'bogus' },
        );
        const byLine = new Map(report.lines.map((l) => [l.line, l]));
        expect(byLine.get('8')!.amount).toBe(2000); // keyword line, not overridden
        expect(report.overriddenCount).toBe(0);
    });

    it('omitting overrides preserves keyword-only behavior (regression)', () => {
        const accounts = [
            acct(GUID_A, 'Advertising', 2000),
            acct(GUID_B, 'Mystery Costs', 300),
        ];
        const withDefault = buildScheduleC(2025, accounts);
        const withEmpty = buildScheduleC(2025, accounts, {});
        expect(withDefault).toEqual(withEmpty);

        const byLine = new Map(withDefault.lines.map((l) => [l.line, l]));
        expect(byLine.get('8')!.amount).toBe(2000);
        expect(byLine.get('27a')!.amount).toBe(300);
        expect(withDefault.unmappedCount).toBe(1);
        expect(withDefault.overriddenCount).toBe(0);
    });
});
