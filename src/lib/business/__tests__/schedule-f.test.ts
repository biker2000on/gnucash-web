/**
 * Schedule F builder + mapping validation — pure function tests.
 */

import { describe, expect, it } from 'vitest';
import {
    buildScheduleF,
    mapFarmExpenseAccountToLine,
    mapFarmIncomeAccountToLine,
    isValidScheduleFLine,
    type ScheduleFAccountInput,
} from '../schedule-f';
import {
    partitionMappingChanges,
    ScheduleFMappingValidationError,
} from '../schedule-f-mappings';

const GUID_A = 'a'.repeat(32);
const GUID_B = 'b'.repeat(32);
const GUID_C = 'c'.repeat(32);

function acct(
    guid: string,
    name: string,
    type: 'INCOME' | 'EXPENSE',
    total: number,
    path?: string,
): ScheduleFAccountInput {
    return { guid, name, path: path ?? `${type === 'INCOME' ? 'Income' : 'Expenses'}:${name}`, type, total };
}

describe('mapFarmExpenseAccountToLine — apiary keyword rules', () => {
    it('maps the farm template account names onto sensible lines', () => {
        expect(mapFarmExpenseAccountToLine('Feed & Syrup', 'Expenses:Feed & Syrup')).toBe('16');
        expect(mapFarmExpenseAccountToLine('Medications & Mite Treatments', '')).toBe('31');
        expect(mapFarmExpenseAccountToLine('Jars & Packaging', '')).toBe('28');
        expect(mapFarmExpenseAccountToLine('Gasoline & Fuel', '')).toBe('19');
        expect(mapFarmExpenseAccountToLine('Vehicle & Truck', '')).toBe('10');
        expect(mapFarmExpenseAccountToLine('Insurance', '')).toBe('20');
        expect(mapFarmExpenseAccountToLine('Repairs & Maintenance', '')).toBe('25');
        expect(mapFarmExpenseAccountToLine('Land Rent & Lease', '')).toBe('24b');
        expect(mapFarmExpenseAccountToLine('Custom Hire', '')).toBe('13');
        expect(mapFarmExpenseAccountToLine('Freight & Trucking', '')).toBe('18');
        expect(mapFarmExpenseAccountToLine('Taxes & Licenses', '')).toBe('29');
        expect(mapFarmExpenseAccountToLine('Utilities', '')).toBe('30');
        expect(mapFarmExpenseAccountToLine('Bee Purchases (Queens & Packages)', '')).toBe('32');
    });

    it('children inherit the parent category via the path', () => {
        expect(mapFarmExpenseAccountToLine('Winter', 'Expenses:Farm:Feed & Syrup:Winter')).toBe('16');
    });

    it('returns null with no match', () => {
        expect(mapFarmExpenseAccountToLine('Miscellaneous', 'Expenses:Miscellaneous')).toBeNull();
    });
});

describe('mapFarmIncomeAccountToLine', () => {
    it('classifies apiary income accounts', () => {
        expect(mapFarmIncomeAccountToLine('Honey Sales', '')).toBeNull(); // → default line 2
        expect(mapFarmIncomeAccountToLine('Pollination Services', '')).toBe('8');
        expect(mapFarmIncomeAccountToLine('Ag Program Payments', '')).toBe('4a');
        expect(mapFarmIncomeAccountToLine('Custom Hire Income', '')).toBe('7');
    });
});

describe('buildScheduleF', () => {
    it('negates income sign, defaults income to line 2, totals net profit', () => {
        const report = buildScheduleF(2025, [
            acct(GUID_A, 'Honey Sales', 'INCOME', -12_000),
            acct(GUID_B, 'Feed & Syrup', 'EXPENSE', 1_500),
            acct(GUID_C, 'Jars & Packaging', 'EXPENSE', 800),
        ]);
        expect(report.grossIncome).toBe(12_000);
        const line2 = report.incomeLines.find((l) => l.line === '2')!;
        expect(line2.amount).toBe(12_000);
        expect(report.expenseLines.find((l) => l.line === '16')!.amount).toBe(1_500);
        expect(report.expenseLines.find((l) => l.line === '28')!.amount).toBe(800);
        expect(report.totalExpenses).toBe(2_300);
        expect(report.netProfit).toBe(9_700);
    });

    it('manual override wins over the keyword line and is counted', () => {
        const report = buildScheduleF(
            2025,
            [acct(GUID_B, 'Feed & Syrup', 'EXPENSE', 1_500)],
            { [GUID_B]: '32' },
        );
        expect(report.expenseLines.find((l) => l.line === '32')!.amount).toBe(1_500);
        expect(report.expenseLines.find((l) => l.line === '16')!.amount).toBe(0);
        expect(report.overriddenCount).toBe(1);
    });

    it('unmatched expenses fall to line 32 and are counted unmapped', () => {
        const report = buildScheduleF(2025, [
            acct(GUID_B, 'Miscellaneous', 'EXPENSE', 100),
        ]);
        expect(report.expenseLines.find((l) => l.line === '32')!.amount).toBe(100);
        expect(report.unmappedCount).toBe(1);
    });

    it('skips near-zero totals and ignores invalid stored overrides', () => {
        const report = buildScheduleF(
            2025,
            [
                acct(GUID_A, 'Honey Sales', 'INCOME', -0.001),
                acct(GUID_B, 'Feed & Syrup', 'EXPENSE', 200),
            ],
            { [GUID_B]: '99' }, // invalid → keyword fallback
        );
        expect(report.grossIncome).toBe(0);
        expect(report.expenseLines.find((l) => l.line === '16')!.amount).toBe(200);
        expect(report.overriddenCount).toBe(0);
    });
});

describe('isValidScheduleFLine', () => {
    it('accepts expense lines and rejects income/aggregate/unknown lines', () => {
        expect(isValidScheduleFLine('16')).toBe(true);
        expect(isValidScheduleFLine('24b')).toBe(true);
        expect(isValidScheduleFLine('2')).toBe(false);
        expect(isValidScheduleFLine('9')).toBe(false);
        expect(isValidScheduleFLine('99')).toBe(false);
        expect(isValidScheduleFLine(null)).toBe(false);
    });
});

describe('partitionMappingChanges', () => {
    const book = new Set([GUID_A, GUID_B]);

    it('splits valid changes into upserts and deletes', () => {
        const result = partitionMappingChanges(
            [
                { accountGuid: GUID_A, line: '16' },
                { accountGuid: GUID_B, line: null },
            ],
            book,
        );
        expect(result.upserts).toEqual([{ accountGuid: GUID_A, line: '16' }]);
        expect(result.deletes).toEqual([GUID_B]);
    });

    it('throws on out-of-book guids and invalid lines', () => {
        expect(() =>
            partitionMappingChanges([{ accountGuid: GUID_C, line: '16' }], book),
        ).toThrow(ScheduleFMappingValidationError);
        expect(() =>
            partitionMappingChanges([{ accountGuid: GUID_A, line: '9' }], book),
        ).toThrow(ScheduleFMappingValidationError);
    });
});
