import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { ancestorCte, MAX_ACCOUNT_DEPTH } from '../ancestor-cte';

/** Collapse whitespace so the assertions read on structure, not indentation. */
function flatten(sql: Prisma.Sql): string {
    return sql.sql.replace(/\s+/g, ' ').trim();
}

describe('ancestorCte', () => {
    const fragment = ancestorCte('account-guid');

    it('walks parent_guid upward from the given account under the name account_ancestors', () => {
        expect(flatten(fragment)).toContain('WITH RECURSIVE account_ancestors AS (');
        expect(flatten(fragment)).toContain('FROM accounts WHERE guid =');
        expect(flatten(fragment)).toContain(
            'JOIN account_ancestors ON parent.guid = account_ancestors.parent_guid',
        );
    });

    it('exposes guid, parent_guid and a depth that starts at 1 on the account itself', () => {
        expect(flatten(fragment)).toContain('SELECT guid, parent_guid, 1 AS depth');
        expect(flatten(fragment)).toContain(
            'SELECT parent.guid, parent.parent_guid, account_ancestors.depth + 1',
        );
    });

    /**
     * The reason the fragment is shared at all: an accounts table with a
     * parent cycle makes an unbounded recursive walk spin until the statement
     * timeout, and the guard used to have to be right in three separate
     * copies.
     */
    it('keeps the depth guard, bound as a parameter rather than inlined', () => {
        expect(flatten(fragment)).toContain('WHERE account_ancestors.depth <');
        expect(fragment.values).toContain(MAX_ACCOUNT_DEPTH);
        expect(MAX_ACCOUNT_DEPTH).toBe(200);
    });

    it('binds the starting guid as a parameter, never as literal SQL text', () => {
        const injected = ancestorCte("x'; DROP TABLE accounts; --");
        expect(injected.sql).not.toContain('DROP TABLE');
        expect(injected.values).toContain("x'; DROP TABLE accounts; --");
    });

    it('composes into a consuming query with the CTE ahead of the SELECT', () => {
        const composed = Prisma.sql`
            ${ancestorCte('account-guid')}
            SELECT guid FROM account_ancestors ORDER BY depth DESC LIMIT 1
        `;
        const text = flatten(composed);
        expect(text.indexOf('WITH RECURSIVE')).toBeLessThan(text.indexOf('SELECT guid FROM account_ancestors'));
        expect(composed.values).toEqual(['account-guid', MAX_ACCOUNT_DEPTH]);
    });
});
