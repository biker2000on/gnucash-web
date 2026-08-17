/** Raw SQL templates edited by the float8 fix must retain balanced SQL syntax. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function queryTemplate(path: string): string {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    const match = source.match(/\$queryRaw(?:<[^>]+>)?`([\s\S]*?)`;/);
    if (!match) throw new Error(`No $queryRaw template found in ${path}`);
    return match[1].replace(/\$\{[\s\S]*?\}/g, '$value');
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

describe('account balance raw SQL syntax', () => {
    it.each([
        'src/app/api/accounts/balances/route.ts',
        'src/app/api/accounts/reconcile-summary/route.ts',
    ])('has balanced SQL parentheses in %s', (path) => {
        expectBalancedSql(queryTemplate(path));
    });
});
