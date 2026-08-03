/**
 * Audit finding S5 — cross-book isolation for employees.
 *
 * `employees` is a native GnuCash table with no book_guid, so every entry
 * point resolves scope through gnucash_web_business_entity_ownership. The
 * load-bearing properties: a foreign employee is invisible to list, reads as
 * not found for get/update/delete, and a newly created employee is attributed
 * to the creating book inside the same transaction as the insert.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, prismaMock } = vi.hoisted(() => {
    interface OwnershipRow { entity_type: string; entity_guid: string; book_guid: string }
    const store = {
        ownership: [] as OwnershipRow[],
        employees: [] as Record<string, unknown>[],
    };

    const matchesEmployeeWhere = (row: Record<string, unknown>, where: Record<string, unknown>) => {
        const guid = where.guid as { in?: string[] } | undefined;
        if (guid?.in && !guid.in.includes(row.guid as string)) return false;
        if (where.active !== undefined && row.active !== where.active) return false;
        return true;
    };

    const prismaMock = {
        gnucash_web_business_entity_ownership: {
            create: vi.fn(async ({ data }: { data: OwnershipRow }) => {
                store.ownership.push({ ...data });
                return data;
            }),
            findUnique: vi.fn(async ({ where }: {
                where: { entity_type_entity_guid: { entity_type: string; entity_guid: string } };
            }) => {
                const key = where.entity_type_entity_guid;
                const hit = store.ownership.find(
                    r => r.entity_type === key.entity_type && r.entity_guid === key.entity_guid,
                );
                return hit ? { book_guid: hit.book_guid } : null;
            }),
            findMany: vi.fn(async ({ where }: { where: { entity_type: string; book_guid: string } }) =>
                store.ownership
                    .filter(r => r.entity_type === where.entity_type && r.book_guid === where.book_guid)
                    .map(r => ({ entity_guid: r.entity_guid })),
            ),
            deleteMany: vi.fn(async ({ where }: { where: { entity_type: string; entity_guid: string } }) => {
                for (let i = store.ownership.length - 1; i >= 0; i--) {
                    const row = store.ownership[i];
                    if (row.entity_type === where.entity_type && row.entity_guid === where.entity_guid) {
                        store.ownership.splice(i, 1);
                    }
                }
                return { count: 1 };
            }),
        },
        employees: {
            findMany: vi.fn(async (args: { where?: Record<string, unknown>; select?: unknown } = {}) =>
                store.employees.filter(row => matchesEmployeeWhere(row, args.where ?? {})),
            ),
            findUnique: vi.fn(async ({ where }: { where: { guid: string } }) =>
                store.employees.find(row => row.guid === where.guid) ?? null,
            ),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                store.employees.push({ ...data });
                return data;
            }),
            update: vi.fn(async ({ where, data }: {
                where: { guid: string };
                data: Record<string, unknown>;
            }) => {
                const row = store.employees.find(r => r.guid === where.guid)!;
                Object.assign(row, data);
                return row;
            }),
            delete: vi.fn(async ({ where }: { where: { guid: string } }) => {
                const index = store.employees.findIndex(r => r.guid === where.guid);
                return store.employees.splice(index, 1)[0];
            }),
        },
        commodities: {
            findFirst: vi.fn(async () => ({ guid: 'f'.repeat(32) })),
            findMany: vi.fn(async () => [{ guid: 'f'.repeat(32), mnemonic: 'USD' }]),
        },
        invoices: {
            groupBy: vi.fn(async () => []),
            count: vi.fn(async () => 0),
        },
        $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
    };

    return { store, prismaMock };
});

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));

import {
    listEmployees,
    getEmployee,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    employeeInputSchema,
} from '../employees.service';

const BOOK_A = 'a'.repeat(32);
const BOOK_B = 'b'.repeat(32);
const EMP_A = '1'.repeat(32);
const EMP_B = '2'.repeat(32);

function employeeRow(guid: string, username: string) {
    return {
        guid,
        id: guid === EMP_A ? '000001' : '000002',
        username,
        language: '',
        acl: '',
        active: 1,
        currency: 'f'.repeat(32),
        ccard_guid: null,
        workday_num: 800n,
        workday_denom: 100n,
        rate_num: 0n,
        rate_denom: 100n,
        addr_name: username,
        addr_addr1: null,
        addr_addr2: null,
        addr_addr3: null,
        addr_addr4: null,
        addr_phone: null,
        addr_fax: null,
        addr_email: null,
    };
}

function input(username: string) {
    return employeeInputSchema.parse({ username });
}

beforeEach(() => {
    vi.clearAllMocks();
    store.ownership.length = 0;
    store.employees.length = 0;
    store.employees.push(employeeRow(EMP_A, 'ann'), employeeRow(EMP_B, 'bob'));
    store.ownership.push(
        { entity_type: 'employee', entity_guid: EMP_A, book_guid: BOOK_A },
        { entity_type: 'employee', entity_guid: EMP_B, book_guid: BOOK_B },
    );
});

describe('employee book scoping', () => {
    it('lists only the requesting book\'s employees', async () => {
        const listed = await listEmployees(BOOK_A);
        expect(listed.map(e => e.guid)).toEqual([EMP_A]);

        const other = await listEmployees(BOOK_B);
        expect(other.map(e => e.guid)).toEqual([EMP_B]);
    });

    it('returns an empty list without querying when the book owns none', async () => {
        store.ownership.length = 0;
        await expect(listEmployees(BOOK_A)).resolves.toEqual([]);
        // An empty ownership set must never degrade into an unfiltered read.
        expect(prismaMock.employees.findMany).not.toHaveBeenCalled();
    });

    it('reads a foreign employee as not found', async () => {
        await expect(getEmployee(BOOK_A, EMP_B)).resolves.toBeNull();
        await expect(getEmployee(BOOK_A, EMP_A)).resolves.toMatchObject({ guid: EMP_A });
    });

    it('treats an unattributed employee as foreign, not as public', async () => {
        store.ownership.length = 0;
        await expect(getEmployee(BOOK_A, EMP_A)).resolves.toBeNull();
        await expect(getEmployee(BOOK_B, EMP_A)).resolves.toBeNull();
    });

    it('updates nothing and reports not found for a foreign guid', async () => {
        await expect(updateEmployee(BOOK_A, EMP_B, input('hijacked'))).resolves.toBeNull();
        expect(prismaMock.employees.update).not.toHaveBeenCalled();
        expect(store.employees.find(r => r.guid === EMP_B)!.username).toBe('bob');
    });

    it('deletes nothing and reports not found for a foreign guid', async () => {
        await expect(deleteEmployee(BOOK_A, EMP_B)).resolves.toBeNull();
        expect(prismaMock.employees.delete).not.toHaveBeenCalled();
        expect(prismaMock.employees.update).not.toHaveBeenCalled();
        expect(store.employees).toHaveLength(2);
        expect(store.ownership).toHaveLength(2);
    });

    it('deletes an owned employee together with its ownership row', async () => {
        await expect(deleteEmployee(BOOK_A, EMP_A)).resolves.toEqual({
            deleted: true,
            deactivated: false,
        });
        expect(store.employees.map(r => r.guid)).toEqual([EMP_B]);
        expect(store.ownership.map(r => r.entity_guid)).toEqual([EMP_B]);
    });

    it('records ownership for the creating book, in the insert transaction', async () => {
        const created = await createEmployee(BOOK_A, input('cara'));

        expect(prismaMock.$transaction).toHaveBeenCalledOnce();
        expect(store.ownership).toContainEqual({
            entity_type: 'employee',
            entity_guid: created.guid,
            book_guid: BOOK_A,
        });
        await expect(getEmployee(BOOK_B, created.guid)).resolves.toBeNull();
        await expect(getEmployee(BOOK_A, created.guid)).resolves.toMatchObject({ username: 'cara' });
    });
});
