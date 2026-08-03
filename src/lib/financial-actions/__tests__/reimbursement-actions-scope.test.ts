/**
 * Audit finding S5 — the Action Center must not surface another book's
 * employees. `gnucash_web_reimbursement_requests` is book-scoped, but it joins
 * the native `employees` table, which is not. The reimbursement source
 * therefore constrains the join to the employees this book owns.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { prismaMock, queryCalls } = vi.hoisted(() => {
    const queryCalls: unknown[][] = [];
    const prismaMock = {
        gnucash_web_business_entity_ownership: { findMany: vi.fn() },
        $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            queryCalls.push(values);
            return [];
        }),
    };
    return { prismaMock, queryCalls };
});

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));

import { reimbursementActions } from '../sources';

const BOOK_A = 'a'.repeat(32);
const EMP_A = '1'.repeat(32);
const EMP_B = '2'.repeat(32);

beforeEach(() => {
    vi.clearAllMocks();
    queryCalls.length = 0;
});

describe('Action Center reimbursement source book scope', () => {
    it('produces nothing, and runs no query, when the book owns no employees', async () => {
        prismaMock.gnucash_web_business_entity_ownership.findMany.mockResolvedValue([]);

        await expect(reimbursementActions(BOOK_A)).resolves.toEqual([]);
        // An empty ownership set must never degrade into an unfiltered join.
        expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('constrains the employee join to the owning book', async () => {
        prismaMock.gnucash_web_business_entity_ownership.findMany.mockResolvedValue([
            { entity_guid: EMP_A },
        ]);

        await reimbursementActions(BOOK_A);

        expect(prismaMock.gnucash_web_business_entity_ownership.findMany).toHaveBeenCalledWith({
            where: { entity_type: 'employee', book_guid: BOOK_A },
            select: { entity_guid: true },
        });
        expect(queryCalls).toHaveLength(1);
        expect(queryCalls[0]).toContainEqual([EMP_A]);
        expect(JSON.stringify(queryCalls[0])).not.toContain(EMP_B);
    });
});
