/**
 * `AccountService.create` is a check-then-insert on (parent_guid, name) with no
 * DB arbiter behind it: a unique index on accounts(parent_guid, name) cannot
 * exist, because scheduled-transaction templates share (parent, '') by design
 * (src/lib/db-init.ts, ACCOUNTS_SIBLING_NAME_INDEX). So the per-(parent, name)
 * advisory lock is the ONLY thing standing between two concurrent "New
 * account" clicks and a book with two identically-named siblings — which the
 * name-resolving importers (personal-import, qif, settlement-import) would then
 * post into arbitrarily.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, txMock, logAuditMock } = vi.hoisted(() => {
    // NOTE: no `$transaction` on the tx double — that absence is exactly what
    // marks an interactive-transaction client, and what stops the advisory-lock
    // helper from refusing the lock. See book-lock-transaction-scope.test.ts.
    const txMock = {
        accounts: { findFirst: vi.fn(), create: vi.fn() },
        slots: { create: vi.fn() },
        $queryRaw: vi.fn(async () => [{ locked: null }]),
        $executeRaw: vi.fn(),
    };
    return {
        txMock,
        prismaMock: {
            accounts: { findUnique: vi.fn(), findFirst: vi.fn() },
            commodities: { findUnique: vi.fn() },
            $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(txMock)),
        },
        logAuditMock: vi.fn(),
    };
});

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/services/audit.service', () => ({ logAudit: logAuditMock }));

import { AccountService } from '@/lib/services/account.service';

const PARENT = 'parent00000000000000000000000001';
const COMMODITY = 'usd00000000000000000000000000001';

const input = (over: Record<string, unknown> = {}) => ({
    name: 'Groceries',
    account_type: 'EXPENSE',
    parent_guid: PARENT,
    commodity_guid: COMMODITY,
    code: '',
    description: '',
    hidden: 0,
    placeholder: 0,
    commodity_scu: 100,
    non_std_scu: 0,
    ...over,
} as Parameters<typeof AccountService.create>[0]);

beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txMock));
    prismaMock.accounts.findUnique.mockResolvedValue({ guid: PARENT });
    prismaMock.commodities.findUnique.mockResolvedValue({ guid: COMMODITY, fraction: 100 });
    txMock.accounts.findFirst.mockResolvedValue(null);
    txMock.accounts.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
});

describe('AccountService.create — sibling-name serialization', () => {
    it('takes the per-(parent, name) lock BEFORE looking for a clash', async () => {
        const order: string[] = [];
        const sent: string[] = [];
        txMock.$queryRaw.mockImplementation(async (...args: unknown[]) => {
            order.push('lock');
            sent.push(Array.isArray(args[0]) ? (args[0] as string[]).join('?') : String(args[0]));
            return [{ locked: null }];
        });
        txMock.accounts.findFirst.mockImplementation(async () => { order.push('recheck'); return null; });
        txMock.accounts.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
            order.push('create');
            return data;
        });

        await AccountService.create(input());

        // Re-checking before the lock would prove nothing: the losing writer
        // reads "absent", waits, and then inserts the duplicate anyway.
        expect(order).toEqual(['lock', 'recheck', 'create']);
        expect(sent[0]).toContain('pg_advisory_xact_lock');
    });

    it('refuses to create a second account with the same name under one parent', async () => {
        txMock.accounts.findFirst.mockResolvedValue({ guid: 'winner00000000000000000000000001' });

        await expect(AccountService.create(input()))
            .rejects.toThrow('An account named "Groceries" already exists under this parent');
        expect(txMock.accounts.create).not.toHaveBeenCalled();
    });

    it('allows the same name under a different parent', async () => {
        await AccountService.create(input({ parent_guid: 'parent00000000000000000000000002' }));

        expect(txMock.accounts.create).toHaveBeenCalledTimes(1);
        expect(txMock.accounts.findFirst).toHaveBeenCalledWith({
            where: { parent_guid: 'parent00000000000000000000000002', name: 'Groceries' },
            select: { guid: true },
        });
    });

    it('skips the sibling check for a parentless (root) account', async () => {
        // The ROOT account is nobody's sibling, and there is no parent to key
        // the lock on.
        await AccountService.create(input({ parent_guid: null, account_type: 'ROOT' }));

        expect(txMock.$queryRaw).not.toHaveBeenCalled();
        expect(txMock.accounts.findFirst).not.toHaveBeenCalled();
        expect(txMock.accounts.create).toHaveBeenCalledTimes(1);
    });
});
