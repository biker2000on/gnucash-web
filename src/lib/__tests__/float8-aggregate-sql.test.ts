/**
 * SQL-text tripwire for split-fraction aggregates. This checks query templates,
 * not PostgreSQL arithmetic; real-database parse checks remain necessary for
 * SQL validity and grouping.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(process.cwd(), 'src');

// These pre-existing endpoints are deliberately outside this float8 remainder
// fix. Keep this allowlist explicit so a new unguarded split division fails.
const KNOWN_OUT_OF_SCOPE_UNGUARDED_DIVISIONS = new Set([
    'app/api/accounts/[guid]/balance/route.ts',
    'app/api/business/990/route.ts',
    'app/api/dashboard/custom-widget/route.ts',
    'app/api/fire/social-security/route.ts',
    'app/api/payslips/[id]/match/route.ts',
    'app/api/tax/estimated/route.ts',
    'app/api/tools/drawdown/prefill/route.ts',
    'lib/ai-query/schema-context.ts', // Documentation, not an executed query.
    'lib/services/mortgage.service.ts',
    'lib/services/payslip-post.service.ts',
    'lib/tax/book-income.ts',
    'lib/tax/tax-schedule.ts',
]);

const PER_SPLIT_FLOAT = /(?:s\.(?:quantity|value)_num\s*::\s*(?:float8|double precision)|CAST\(s\.(?:quantity|value)_num\s+AS\s+(?:FLOAT8|DOUBLE PRECISION)\))\s*\//i;
const UNGUARDED_SPLIT_DENOMINATOR = /(?:s\.(?:quantity|value)_num(?:\s*::\s*(?:numeric|float|float8|double precision))?|CAST\(\s*s\.(?:quantity|value)_num\s+AS\s+DECIMAL\s*\))\s*\/\s*(?:CAST\(\s*)?s\.(?:quantity|value)_denom\b/i;

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && path.endsWith('.ts') && !path.includes('/__tests__/')
            ? [path]
            : [];
    });
}

describe('split-fraction aggregate SQL', () => {
    it('contains no per-split float8 division anywhere under src', () => {
        for (const file of sourceFiles(SOURCE_ROOT)) {
            expect(readFileSync(file, 'utf8'), relative(SOURCE_ROOT, file)).not.toMatch(PER_SPLIT_FLOAT);
        }
    });

    it('does not add an unguarded split denominator division', () => {
        const unguardedFiles = sourceFiles(SOURCE_ROOT)
            .filter((file) => UNGUARDED_SPLIT_DENOMINATOR.test(readFileSync(file, 'utf8')))
            .map((file) => relative(SOURCE_ROOT, file));

        expect(unguardedFiles.every(
            (file) => KNOWN_OUT_OF_SCOPE_UNGUARDED_DIVISIONS.has(file),
        )).toBe(true);
    });
});
