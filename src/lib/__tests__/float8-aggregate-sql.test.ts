/**
 * SQL-text tripwire for split-fraction aggregates. This checks query templates,
 * not PostgreSQL arithmetic; real-database parse checks remain necessary for
 * SQL validity and grouping.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(process.cwd(), 'src');

interface DivisionException {
    path: string;
    unguarded: number;
    perSplitFloat: number;
    kind?: 'prompt-guidance';
}

// Each exception names a concrete source and its current match counts. Exact
// counts make new sites fail and make fixed sites require removal from this list.
const DEFERRED_SPLIT_DIVISIONS: DivisionException[] = [
    { path: 'app/api/accounts/[guid]/balance/route.ts', unguarded: 2, perSplitFloat: 0 },
    { path: 'app/api/business/990/route.ts', unguarded: 1, perSplitFloat: 0 },
    { path: 'app/api/dashboard/custom-widget/route.ts', unguarded: 3, perSplitFloat: 0 },
    { path: 'app/api/fire/social-security/route.ts', unguarded: 1, perSplitFloat: 0 },
    { path: 'app/api/payslips/[id]/match/route.ts', unguarded: 2, perSplitFloat: 2 },
    { path: 'app/api/tax/estimated/route.ts', unguarded: 1, perSplitFloat: 0 },
    { path: 'app/api/tools/drawdown/prefill/route.ts', unguarded: 2, perSplitFloat: 0 },
    { path: 'lib/services/mortgage.service.ts', unguarded: 1, perSplitFloat: 0 },
    { path: 'lib/services/payslip-post.service.ts', unguarded: 2, perSplitFloat: 2 },
    { path: 'lib/tax/book-income.ts', unguarded: 1, perSplitFloat: 0 },
    { path: 'lib/tax/tax-schedule.ts', unguarded: 1, perSplitFloat: 0 },
    // This is non-executable LLM prompt prose, not a code exemption. Follow up
    // separately to teach generated SQL in this file and ai-query/generate.ts
    // to use NULLIF for corrupt splits.
    { path: 'lib/ai-query/schema-context.ts', unguarded: 2, perSplitFloat: 0, kind: 'prompt-guidance' },
];

const SPLIT_REFERENCE = String.raw`(?:[A-Za-z_]\w*\.)?`;
const FLOAT_CAST = String.raw`(?:float|real|float4|float8|double precision)`;
const NUMERIC_OR_FLOAT_CAST = String.raw`(?:numeric|${FLOAT_CAST})`;
const NUMERATOR = String.raw`(?:${SPLIT_REFERENCE}(?:quantity|value)_num(?:\s*::\s*${NUMERIC_OR_FLOAT_CAST})?|CAST\(\s*${SPLIT_REFERENCE}(?:quantity|value)_num\s+AS\s+DECIMAL\s*\))`;
const PER_SPLIT_FLOAT = new RegExp(String.raw`(?:${SPLIT_REFERENCE}(?:quantity|value)_num\s*::\s*${FLOAT_CAST}|CAST\(\s*${SPLIT_REFERENCE}(?:quantity|value)_num\s+AS\s+${FLOAT_CAST}\s*\))\s*/`, 'gi');
const UNGUARDED_SPLIT_DENOMINATOR = new RegExp(String.raw`${NUMERATOR}\s*/\s*(?:CAST\(\s*)?${SPLIT_REFERENCE}(?:quantity|value)_denom(?:\s*::\s*${NUMERIC_OR_FLOAT_CAST})?`, 'gi');

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && /\.tsx?$/.test(path) && !path.replaceAll('\\', '/').includes('/__tests__/')
            ? [path]
            : [];
    });
}

function countMatches(source: string, pattern: RegExp, promptGuidance: boolean): number {
    // Silent escape hatches: Prisma.sql fragments composed elsewhere, division
    // over a view/CTE alias, and $queryRawUnsafe single-quoted SQL strings.
    return [...source.matchAll(pattern)].filter((match) => {
        if (promptGuidance) return true;
        const templateStart = source.lastIndexOf('`', match.index);
        const templateEnd = source.indexOf('`', match.index);
        return templateStart !== -1
            && templateEnd !== -1
            && /\b(?:FROM|JOIN)\s+splits\b/i.test(source.slice(templateStart, templateEnd));
    }).length;
}

function actualDivisionSites(): DivisionException[] {
    return sourceFiles(SOURCE_ROOT).flatMap((file) => {
        const path = relative(SOURCE_ROOT, file).replaceAll('\\', '/');
        const exception = DEFERRED_SPLIT_DIVISIONS.find((entry) => entry.path === path);
        const source = readFileSync(file, 'utf8');
        const promptGuidance = exception?.kind === 'prompt-guidance';
        const unguarded = countMatches(source, UNGUARDED_SPLIT_DENOMINATOR, promptGuidance);
        const perSplitFloat = countMatches(source, PER_SPLIT_FLOAT, promptGuidance);
        return unguarded > 0 || perSplitFloat > 0
            ? [{ path, unguarded, perSplitFloat, ...(promptGuidance ? { kind: 'prompt-guidance' as const } : {}) }]
            : [];
    }).sort((a, b) => a.path.localeCompare(b.path));
}

const expectedDivisionSites = () => [...DEFERRED_SPLIT_DIVISIONS]
    .sort((a, b) => a.path.localeCompare(b.path));

describe('split-fraction aggregate SQL', () => {
    // This scan intentionally covers SQL template text only. It does not catch
    // TypeScript Number(x_num) / Number(x_denom) arithmetic (including
    // trading-accounts.ts:427 and AccountLedger.tsx:923); audit separately.
    it('keeps the deferred split-division site inventory exact', () => {
        expect(actualDivisionSites()).toEqual(expectedDivisionSites());
    });
});
