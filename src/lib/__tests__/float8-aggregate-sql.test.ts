/**
 * SQL-text tripwire for split-fraction aggregates corrected in the float8
 * remainder sweep. This checks query templates, not PostgreSQL arithmetic;
 * real-database parse checks remain necessary for SQL validity and grouping.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONVERTED_SOURCES = [
    ['src/lib/reports/net-worth-by-owner.ts', 1],
    ['src/lib/reports/account-summary.ts', 2],
    ['src/lib/reports/equity-statement.ts', 3],
    ['src/app/api/accounts/[guid]/transactions/route.ts', 1],
    ['src/app/api/accounts/route.ts', 2],
    ['src/lib/account-current-value.ts', 1],
    ['src/app/api/tools/debt-payoff/route.ts', 1],
    ['src/lib/insights.ts', 6],
] as const;

const NUMERIC_FRACTION = /s\.(?:quantity|value)_num::numeric\s*\/\s*NULLIF\(s\.(?:quantity|value)_denom,\s*0\)::numeric/g;
const TERMINAL_FLOAT8 = /::float8\s+AS\s+\w+/g;
const PER_SPLIT_FLOAT = /s\.(?:quantity|value)_num::(?:float8|double precision)\s*\/|CAST\(s\.(?:quantity|value)_num\s+AS\s+(?:FLOAT8|DOUBLE PRECISION)\)\s*\//i;

describe('split-fraction aggregate SQL', () => {
    it('uses numeric split arithmetic and one final float8 compatibility cast for all 17 conversions', () => {
        // One numeric fraction and one terminal compatibility cast per
        // conversion. Do not reintroduce per-split float division: repeated
        // fractions (for example seven 1/7 splits) must aggregate in numeric.
        let conversions = 0;
        for (const [file, expectedConversions] of CONVERTED_SOURCES) {
            const source = readFileSync(resolve(process.cwd(), file), 'utf8');
            expect([...source.matchAll(NUMERIC_FRACTION)]).toHaveLength(expectedConversions);
            expect([...source.matchAll(TERMINAL_FLOAT8)]).toHaveLength(expectedConversions);
            expect(source).not.toMatch(PER_SPLIT_FLOAT);
            conversions += expectedConversions;
        }
        expect(conversions).toBe(17);
    });
});
