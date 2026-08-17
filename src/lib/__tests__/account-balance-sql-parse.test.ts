/**
 * Parenthesis-balance check for the specific raw SQL templates edited by the
 * float8 fix. This is not a SQL parser: it is blind to wrong keywords, bad
 * casts, missing commas, and wrong COALESCE arity, and it miscounts parentheses
 * inside string literals and comments. Real PostgreSQL parse checks remain
 * necessary for SQL validity.
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
    const template = matches[0];
    expect(template, `${path} ${anchor} query must not be empty`).not.toBe('');
    expect(template, `${path} query must contain its ${anchor} anchor`).toContain(anchor);
    return template;
}

function expectBalancedSql(sql: string) {
    expect(sql, 'SQL template must not be empty').not.toBe('');
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
        ['src/app/api/accounts/balances/route.ts', 'period_balance'],
        ['src/app/api/accounts/reconcile-summary/route.ts', 'completed_sessions'],
    ])('selects and balances the intended query in %s', (path, anchor) => {
        const sql = queryTemplate(path, anchor);
        expectBalancedSql(sql);
    });
});
