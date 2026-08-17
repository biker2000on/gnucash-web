/**
 * Structural SQL check for raw templates edited by the float8 fix. This checks
 * template selection and parentheses, not PostgreSQL grammar; real-database
 * parse checks remain necessary for SQL validity and grouping.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function queryTemplate(path: string, anchor: string): string {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    const templates = [...source.matchAll(/\$queryRaw(?:<[^>]+>)?`([\s\S]*?)`;/g)]
        .map((match) => match[1].replace(/\$\{[\s\S]*?\}/g, '$value'));
    const matches = templates.filter((template) => template.includes(anchor));
    expect(matches, `${path} must have exactly one ${anchor} query`).toHaveLength(1);
    return matches[0];
}

function expectBalancedSql(sql: string) {
    let depth = 0;
    for (const character of sql) {
        if (character === '(') depth++;
        if (character === ')') depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
}

describe('account balance raw SQL structure', () => {
    it.each([
        ['src/app/api/accounts/balances/route.ts', 'total_balance'],
        ['src/app/api/accounts/balances/route.ts', 'period_balance'],
        ['src/app/api/accounts/reconcile-summary/route.ts', 'reconcile_state'],
        ['src/app/api/accounts/reconcile-summary/route.ts', 'SELECT DISTINCT ON (commodity_guid)'],
    ])('selects and balances the intended query in %s', (path, anchor) => {
        const sql = queryTemplate(path, anchor);
        expect(sql.length).toBeGreaterThan(200);
        expectBalancedSql(sql);
    });
});
