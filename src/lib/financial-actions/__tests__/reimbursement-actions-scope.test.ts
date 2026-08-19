/**
 * Audit finding S5 — the Action Center must not surface another book's
 * employees. `gnucash_web_reimbursement_requests` is book-scoped, but it joins
 * the native `employees` table, which is not. The reimbursement source
 * therefore constrains the join to the employees this book owns.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { prismaMock, queryCalls, querySql } = vi.hoisted(() => {
    const queryCalls: unknown[][] = [];
    const querySql: string[] = [];
    const prismaMock = {
        gnucash_web_business_entity_ownership: { findMany: vi.fn() },
        $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            queryCalls.push(values);
            querySql.push(strings.join('?'));
            return [];
        }),
    };
    return { prismaMock, queryCalls, querySql };
});

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));

import { reimbursementActions } from '../sources';

const BOOK_A = 'a'.repeat(32);
const EMP_A = '1'.repeat(32);
const EMP_B = '2'.repeat(32);

beforeEach(() => {
    vi.clearAllMocks();
    queryCalls.length = 0;
    querySql.length = 0;
});

describe('Action Center reimbursement source book scope', () => {
    it('produces nothing when the book owns no employees', async () => {
        // The ownership join is inside the SQL now, so the empty result comes
        // from the database rather than from an early return.
        await expect(reimbursementActions(BOOK_A)).resolves.toEqual([]);
    });

    it('constrains the employee join to the owning book inside the SQL', async () => {
        await reimbursementActions(BOOK_A);

        expect(querySql).toHaveLength(1);
        const sql = querySql[0];
        // Scoping rides in the query as a join against the ownership view,
        // not as a materialized guid list handed back to the database.
        expect(sql).toContain('gnucash_web_employee_ownership');
        expect(sql).toMatch(/eo\.entity_guid\s*=\s*r\.employee_guid/);
        expect(sql).toMatch(/eo\.book_guid\s*=\s*\?/);

        // The book is bound as a parameter; no employee guid array is shipped.
        expect(queryCalls[0]).toContain(BOOK_A);
        expect(queryCalls[0].some(v => Array.isArray(v))).toBe(false);
        expect(JSON.stringify(queryCalls[0])).not.toContain(EMP_A);
        expect(JSON.stringify(queryCalls[0])).not.toContain(EMP_B);
    });

    it('never issues the query without the ownership join', async () => {
        await reimbursementActions(BOOK_A);
        for (const sql of querySql) {
            expect(sql).toContain('gnucash_web_employee_ownership');
        }
    });
});
