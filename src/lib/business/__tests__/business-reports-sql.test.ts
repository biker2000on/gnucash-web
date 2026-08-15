/**
 * SQL-text tripwire for the money aggregates in business-reports.ts.
 *
 * This checks the query templates, not PostgreSQL's arithmetic or loader
 * behavior. The real-database parse check remains necessary because a query
 * can have this text shape yet still fail due to grouping or schema errors.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BUSINESS_REPORTS_SOURCE = readFileSync(
    resolve(process.cwd(), 'src/lib/business/business-reports.ts'),
    'utf8',
);

describe('business report money SQL', () => {
    it('casts each completed money sum to float8 only after numeric split arithmetic', () => {
        const finalFloatCasts = [...BUSINESS_REPORTS_SOURCE.matchAll(/::float8\s+AS\s+\w+/g)];

        // Twelve report values cross the SQL boundary as numbers. Do not add a
        // per-split float cast: fractions such as seven 1/7 splits must be
        // summed exactly by PostgreSQL before this final compatibility cast.
        expect(finalFloatCasts).toHaveLength(12);

        for (const finalCast of finalFloatCasts) {
            const sumStart = BUSINESS_REPORTS_SOURCE.lastIndexOf('SUM(', finalCast.index);
            const aggregate = BUSINESS_REPORTS_SOURCE.slice(sumStart, finalCast.index);

            expect(sumStart).toBeGreaterThanOrEqual(0);
            expect(aggregate).toContain('value_num::numeric / NULLIF(');
            expect(aggregate).toContain('value_denom, 0)::numeric');
            expect(aggregate).not.toContain('value_num::float8');
            expect(aggregate).not.toContain('value_denom::float8');
        }
    });
});
