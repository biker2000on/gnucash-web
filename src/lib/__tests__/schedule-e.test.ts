/**
 * Schedule E (rental property) — pure-logic tests.
 *
 *   - mapRentalAccountToLine: keyword heuristic per line, rule-order
 *     specificity (mortgage vs other interest, repairs vs maintenance),
 *     path fallback, unmapped → null.
 *   - buildScheduleE override precedence: a valid manual override wins over
 *     the keyword heuristic; an invalid override falls back.
 *   - depreciationForYear: straight-line + mid-month convention math for
 *     the first year, a full year, the disposal year, 27.5 vs 39 recovery,
 *     land-value exclusion, and out-of-range years.
 *   - buildScheduleE multi-property rollup: subtree expansion, per-property
 *     nets, combined totals, first-property-wins overlap dedupe.
 *   - validateProperties: guid/line/asset validation.
 */

import { describe, it, expect, vi } from 'vitest';

// schedule-e.ts imports the prisma client for its SQL loaders; these tests
// exercise only the pure logic, so stub the client out (repo convention —
// see stock-valuation.test.ts / net-worth-by-owner.test.ts).
vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
    buildScheduleE,
    depreciationForYear,
    isValidScheduleELine,
    mapRentalAccountToLine,
    validateProperties,
    ScheduleEValidationError,
    type DepreciableAsset,
    type ScheduleEAccountInput,
    type ScheduleEProperty,
} from '../reports/schedule-e';

const GUID_A = 'a'.repeat(32);
const GUID_B = 'b'.repeat(32);
const GUID_C = 'c'.repeat(32);
const GUID_D = 'd'.repeat(32);
const GUID_E = 'e'.repeat(32);
const GUID_F = 'f'.repeat(32);

const acct = (
    guid: string,
    path: string,
    total: number,
    type: 'INCOME' | 'EXPENSE' = 'EXPENSE',
): ScheduleEAccountInput => ({
    guid,
    name: path.split(':').pop()!,
    path,
    type,
    total,
});

const property = (
    id: string,
    name: string,
    accountGuids: string[],
    extras: Partial<Pick<ScheduleEProperty, 'overrides' | 'assets'>> = {},
): ScheduleEProperty => ({
    id,
    name,
    accountGuids,
    overrides: extras.overrides ?? {},
    assets: extras.assets ?? [],
});

const asset = (overrides: Partial<DepreciableAsset> = {}): DepreciableAsset => ({
    id: '1'.repeat(32),
    description: 'Building',
    costBasis: 275000,
    landValue: 0,
    inServiceDate: '2026-05-15',
    method: 'residential',
    disposalDate: null,
    ...overrides,
});

/* ------------------------------------------------------------------ */
/* Keyword heuristic                                                    */
/* ------------------------------------------------------------------ */

describe('mapRentalAccountToLine', () => {
    const cases: Array<[string, string | null]> = [
        ['Advertising', '5'],
        ['Mileage', '6'],
        ['Auto Expenses', '6'],
        ['Cleaning', '7'],
        ['Landscaping', '7'],
        ['Commissions', '8'],
        ['Insurance', '9'],
        ['Legal Fees', '10'],
        ['Accounting', '10'],
        ['Management Fees', '11'],
        ['Property Management', '11'],
        ['Mortgage Interest', '12'],
        ['Loan Interest', '13'],
        ['Repairs', '14'],
        ['Supplies', '15'],
        ['Property Taxes', '16'],
        ['Utilities', '17'],
        ['Electric', '17'],
        ['HOA Dues', null],
        ['Miscellaneous', null],
    ];

    for (const [name, expected] of cases) {
        it(`maps "${name}" to line ${expected ?? 'null (→ 19 Other)'}`, () => {
            expect(mapRentalAccountToLine(name, `Expenses:Rental:${name}`)).toBe(expected);
        });
    }

    it('prefers mortgage interest (12) over the generic interest rule (13)', () => {
        expect(mapRentalAccountToLine('Mortgage Interest', 'Expenses:Mortgage Interest')).toBe('12');
        expect(mapRentalAccountToLine('Interest', 'Expenses:Interest')).toBe('13');
    });

    it('sends "Repairs & Maintenance" to Repairs (14), plain maintenance to 7', () => {
        expect(mapRentalAccountToLine('Repairs & Maintenance', 'Expenses:Repairs & Maintenance')).toBe('14');
        expect(mapRentalAccountToLine('Maintenance', 'Expenses:Maintenance')).toBe('7');
    });

    it('falls back to the full path when the leaf name has no keyword', () => {
        // Leaf "123 Main St" says nothing; the parent "Repairs" does.
        expect(mapRentalAccountToLine('123 Main St', 'Expenses:Rental:Repairs:123 Main St')).toBe('14');
    });

    it('keeps "Taxi" out of the taxes line', () => {
        expect(mapRentalAccountToLine('Taxi', 'Expenses:Taxi')).not.toBe('16');
    });
});

describe('isValidScheduleELine', () => {
    it('accepts expense lines 5–19', () => {
        expect(isValidScheduleELine('5')).toBe(true);
        expect(isValidScheduleELine('18')).toBe(true);
        expect(isValidScheduleELine('19')).toBe(true);
    });

    it('rejects the income line, unknown lines, and non-strings', () => {
        expect(isValidScheduleELine('3')).toBe(false); // income, not overridable
        expect(isValidScheduleELine('20')).toBe(false);
        expect(isValidScheduleELine('')).toBe(false);
        expect(isValidScheduleELine(null)).toBe(false);
        expect(isValidScheduleELine(14)).toBe(false);
    });
});

/* ------------------------------------------------------------------ */
/* Manual override precedence                                           */
/* ------------------------------------------------------------------ */

describe('buildScheduleE override precedence', () => {
    const accounts = [
        acct(GUID_A, 'Expenses:Rental:Repairs', 1200),
        acct(GUID_B, 'Expenses:Rental:HOA Dues', 600),
    ];

    it('routes an account to the chosen line, overriding the keyword guess', () => {
        // "Repairs" keyword-maps to 14; override it to Cleaning and maintenance (7).
        const report = buildScheduleE(
            2026,
            [property('p1', 'Main St', [GUID_A, GUID_B], { overrides: { [GUID_A]: '7' } })],
            accounts,
        );
        const byLine = new Map(report.properties[0].lines.map((l) => [l.line, l]));
        expect(byLine.get('14')!.amount).toBe(0);
        expect(byLine.get('7')!.amount).toBe(1200);
        expect(report.properties[0].overriddenCount).toBe(1);
        const detail = byLine.get('7')!.accounts[0];
        expect(detail.suggestedLine).toBe('14');
        expect(detail.mappedLine).toBe('7');
    });

    it('maps an otherwise-unmapped account off line 19', () => {
        const report = buildScheduleE(
            2026,
            [property('p1', 'Main St', [GUID_A, GUID_B], { overrides: { [GUID_B]: '19' } })],
            accounts,
        );
        const prop = report.properties[0];
        const byLine = new Map(prop.lines.map((l) => [l.line, l]));
        expect(byLine.get('19')!.amount).toBe(600);
        // Overridden — not counted as an unmapped keyword miss.
        expect(prop.overriddenCount).toBe(1);
        expect(prop.unmappedCount).toBe(0);
    });

    it('ignores an invalid override line and falls back to the keyword', () => {
        const report = buildScheduleE(
            2026,
            [property('p1', 'Main St', [GUID_A], { overrides: { [GUID_A]: 'bogus' } })],
            accounts,
        );
        const byLine = new Map(report.properties[0].lines.map((l) => [l.line, l]));
        expect(byLine.get('14')!.amount).toBe(1200);
        expect(report.properties[0].overriddenCount).toBe(0);
    });

    it('leaves unmatched accounts on line 19 and counts them as unmapped', () => {
        const report = buildScheduleE(2026, [property('p1', 'Main St', [GUID_B])], accounts);
        const prop = report.properties[0];
        const byLine = new Map(prop.lines.map((l) => [l.line, l]));
        expect(byLine.get('19')!.amount).toBe(600);
        expect(prop.unmappedCount).toBe(1);
    });
});

/* ------------------------------------------------------------------ */
/* Depreciation — straight line, mid-month convention                   */
/* ------------------------------------------------------------------ */

describe('depreciationForYear', () => {
    it('first year (residential, in service May): 7.5 mid-month months', () => {
        // 275,000 / 27.5 = 10,000/yr; May → (12.5 − 5)/12 × 10,000 = 6,250.
        expect(depreciationForYear(asset(), 2026)).toBe(6250);
    });

    it('full year residential: basis / 27.5', () => {
        expect(depreciationForYear(asset(), 2027)).toBe(10000);
    });

    it('disposal year: disposal month counts half', () => {
        // Disposed March 2030 → (3 − 0.5)/12 × 10,000 = 2,083.33.
        expect(depreciationForYear(asset({ disposalDate: '2030-03-10' }), 2030)).toBe(2083.33);
    });

    it('39-year commercial: first year (in service January) and full year', () => {
        const office = asset({
            costBasis: 390000,
            inServiceDate: '2026-01-05',
            method: 'commercial',
        });
        // 390,000 / 39 = 10,000/yr; January → (12.5 − 1)/12 × 10,000 = 9,583.33.
        expect(depreciationForYear(office, 2026)).toBe(9583.33);
        expect(depreciationForYear(office, 2027)).toBe(10000);
    });

    it('27.5 vs 39 differ on the same basis and dates', () => {
        const residential = asset({ costBasis: 100000, inServiceDate: '2026-01-05' });
        const commercial = asset({
            costBasis: 100000,
            inServiceDate: '2026-01-05',
            method: 'commercial',
        });
        expect(depreciationForYear(residential, 2027)).toBe(3636.36); // 100k / 27.5
        expect(depreciationForYear(commercial, 2027)).toBe(2564.1); // 100k / 39
    });

    it('excludes the land value from the depreciable basis', () => {
        const withLand = asset({ costBasis: 330000, landValue: 55000 });
        expect(depreciationForYear(withLand, 2027)).toBe(10000); // (330k − 55k) / 27.5
    });

    it('returns 0 before the in-service year and after the disposal year', () => {
        expect(depreciationForYear(asset(), 2025)).toBe(0);
        expect(depreciationForYear(asset({ disposalDate: '2030-03-10' }), 2031)).toBe(0);
    });

    it('in-service and disposal in the same month yields 0 (half in, half out)', () => {
        expect(
            depreciationForYear(asset({ disposalDate: '2026-05-30' }), 2026),
        ).toBe(0);
    });

    it('returns 0 for a fully non-depreciable basis or a malformed date', () => {
        expect(depreciationForYear(asset({ landValue: 275000 }), 2027)).toBe(0);
        expect(depreciationForYear(asset({ inServiceDate: 'not-a-date' }), 2027)).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/* Multi-property rollup                                                */
/* ------------------------------------------------------------------ */

describe('buildScheduleE multi-property rollup', () => {
    const accounts = [
        // Property 1 subtrees: Income:Rental:Main St + Expenses:Rental:Main St
        acct(GUID_A, 'Income:Rental:Main St', -24000, 'INCOME'),
        acct(GUID_B, 'Expenses:Rental:Main St', 0), // placeholder root, no activity
        acct(GUID_C, 'Expenses:Rental:Main St:Repairs', 3000),
        acct(GUID_D, 'Expenses:Rental:Main St:Insurance', 1500),
        // Property 2 subtree
        acct(GUID_E, 'Income:Rental:Oak Ave', -18000, 'INCOME'),
        acct(GUID_F, 'Expenses:Rental:Oak Ave:Utilities', 2400),
    ];

    const properties = [
        property('p1', '123 Main St', [GUID_A, GUID_B], {
            assets: [asset()], // 6,250 of 2026 depreciation
        }),
        property('p2', '456 Oak Ave', [GUID_E, GUID_F]),
    ];

    it('expands subtrees, splits per property, and combines totals', () => {
        const report = buildScheduleE(2026, properties, accounts);
        expect(report.properties).toHaveLength(2);

        const [p1, p2] = report.properties;
        expect(p1.rentsReceived).toBe(24000);
        const p1Lines = new Map(p1.lines.map((l) => [l.line, l]));
        expect(p1Lines.get('14')!.amount).toBe(3000); // child via path prefix
        expect(p1Lines.get('9')!.amount).toBe(1500);
        expect(p1Lines.get('18')!.amount).toBe(6250); // asset depreciation
        expect(p1.assetDepreciation).toBe(6250);
        expect(p1.totalExpenses).toBe(10750);
        expect(p1.netIncome).toBe(13250);

        expect(p2.rentsReceived).toBe(18000);
        expect(p2.totalExpenses).toBe(2400);
        expect(p2.netIncome).toBe(15600);

        expect(report.totals.rentsReceived).toBe(42000);
        expect(report.totals.totalExpenses).toBe(13150);
        expect(report.totals.depreciation).toBe(6250);
        expect(report.totals.netIncome).toBe(28850);
    });

    it('assigns an account claimed by two properties to the first only', () => {
        const overlapping = [
            property('p1', 'First', [GUID_C]),
            property('p2', 'Second', [GUID_C, GUID_F]),
        ];
        const report = buildScheduleE(2026, overlapping, accounts);
        const [p1, p2] = report.properties;
        expect(p1.totalExpenses).toBe(3000); // repairs claimed by p1
        expect(p2.totalExpenses).toBe(2400); // utilities only — no double count
        expect(report.totals.totalExpenses).toBe(5400);
    });

    it('ignores selected roots that are not in the account list', () => {
        const report = buildScheduleE(
            2026,
            [property('p1', 'Ghost', ['9'.repeat(32)])],
            accounts,
        );
        expect(report.properties[0].rentsReceived).toBe(0);
        expect(report.properties[0].totalExpenses).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/* validateProperties                                                   */
/* ------------------------------------------------------------------ */

describe('validateProperties', () => {
    const book = new Set([GUID_A, GUID_B]);

    it('normalizes a valid property and keeps a provided id', () => {
        const [p] = validateProperties(
            [
                {
                    id: GUID_C,
                    name: '  Main St  ',
                    accountGuids: [GUID_A, GUID_A, GUID_B],
                    overrides: { [GUID_A]: '14' },
                    assets: [asset()],
                },
            ],
            book,
        );
        expect(p.id).toBe(GUID_C);
        expect(p.name).toBe('Main St');
        expect(p.accountGuids).toEqual([GUID_A, GUID_B]); // deduped
        expect(p.overrides).toEqual({ [GUID_A]: '14' });
        expect(p.assets).toHaveLength(1);
    });

    it('generates an id when none is provided', () => {
        const [p] = validateProperties([{ name: 'Main St', accountGuids: [] }], book);
        expect(p.id).toMatch(/^[0-9a-f]{32}$/i);
    });

    it('rejects a missing name, out-of-book guids, and bad override lines', () => {
        expect(() => validateProperties([{ name: '' }], book)).toThrow(ScheduleEValidationError);
        expect(() =>
            validateProperties([{ name: 'X', accountGuids: [GUID_C] }], book),
        ).toThrow(ScheduleEValidationError);
        expect(() =>
            validateProperties([{ name: 'X', overrides: { [GUID_A]: '3' } }], book),
        ).toThrow(ScheduleEValidationError);
    });

    it('rejects malformed assets', () => {
        const bad = (patch: Partial<DepreciableAsset>) => () =>
            validateProperties([{ name: 'X', assets: [{ ...asset(), ...patch }] }], book);
        expect(bad({ description: '' })).toThrow(ScheduleEValidationError);
        expect(bad({ costBasis: 0 })).toThrow(ScheduleEValidationError);
        expect(bad({ landValue: 999999 })).toThrow(ScheduleEValidationError);
        expect(bad({ inServiceDate: '05/15/2026' })).toThrow(ScheduleEValidationError);
        expect(bad({ method: 'macrs' as DepreciableAsset['method'] })).toThrow(
            ScheduleEValidationError,
        );
        expect(bad({ disposalDate: '2020-01-01' })).toThrow(ScheduleEValidationError);
    });
});
