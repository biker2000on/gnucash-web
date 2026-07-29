/**
 * AccountService reparent locking — the per-book advisory lock is a
 * NON-BLOCKING try-lock: when another book-wide operation (scrub-all, XML
 * import, ...) holds it, the service throws BookBusyError (mapped to 409 by
 * the routes) instead of queueing until Prisma's transaction timeout turns
 * the wait into an opaque P2028/500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    tryAcquireBookLockMock,
    resolveBookLockGuidForAccountMock,
    logAuditMock,
} = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findUnique: vi.fn(), update: vi.fn() },
        commodities: { findUnique: vi.fn() },
        splits: { count: vi.fn() },
        slots: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
        $transaction: vi.fn(),
        $executeRaw: vi.fn(),
        $queryRaw: vi.fn(),
    },
    tryAcquireBookLockMock: vi.fn(),
    resolveBookLockGuidForAccountMock: vi.fn(),
    logAuditMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/book-lock', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/book-lock')>();
    return {
        ...actual,
        tryAcquireBookLock: tryAcquireBookLockMock,
        resolveBookLockGuidForAccount: resolveBookLockGuidForAccountMock,
    };
});
vi.mock('@/lib/services/audit.service', () => ({ logAudit: logAuditMock }));

import { AccountService } from '@/lib/services/account.service';
import { BookBusyError } from '@/lib/book-lock';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ACCOUNT = 'account000000000000000000000000a';
const NEW_PARENT = 'account000000000000000000000000b';
const BOOK = 'book0000000000000000000000000001';

beforeEach(() => {
    vi.clearAllMocks();
    resolveBookLockGuidForAccountMock.mockResolvedValue(BOOK);
    prismaMock.$transaction.mockImplementation(
        async (cb: (tx: unknown) => unknown) => cb(prismaMock),
    );
    prismaMock.accounts.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.guid === ACCOUNT) {
            return {
                guid: ACCOUNT, name: 'Groceries', code: '', description: '',
                hidden: 0, placeholder: 0, parent_guid: null,
                commodity_guid: 'c'.repeat(32),
            };
        }
        if (where.guid === NEW_PARENT) {
            return { guid: NEW_PARENT, name: 'Expenses', parent_guid: null };
        }
        return null;
    });
    prismaMock.accounts.update.mockResolvedValue({
        guid: ACCOUNT, name: 'Groceries', code: '', description: '',
        hidden: 0, placeholder: 0, parent_guid: NEW_PARENT,
        commodity_guid: 'c'.repeat(32), commodity: null, parent: null,
    });
});

describe('AccountService.move book lock', () => {
    it('throws BookBusyError (no write) when the book lock is held by another operation', async () => {
        tryAcquireBookLockMock.mockResolvedValue(false);

        await expect(AccountService.move(ACCOUNT, NEW_PARENT)).rejects.toBeInstanceOf(BookBusyError);
        expect(tryAcquireBookLockMock).toHaveBeenCalledWith(prismaMock, BOOK);
        expect(prismaMock.accounts.update).not.toHaveBeenCalled();
    });

    it('moves the account when the try-lock succeeds', async () => {
        tryAcquireBookLockMock.mockResolvedValue(true);

        const result: any = await AccountService.move(ACCOUNT, NEW_PARENT);
        expect(result.parent_guid).toBe(NEW_PARENT);
        expect(prismaMock.accounts.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { guid: ACCOUNT },
            data: { parent_guid: NEW_PARENT },
        }));
    });
});

describe('AccountService.update book lock', () => {
    it('throws BookBusyError on a reparenting update when the book lock is held', async () => {
        tryAcquireBookLockMock.mockResolvedValue(false);

        await expect(
            AccountService.update(ACCOUNT, { parent_guid: NEW_PARENT }),
        ).rejects.toBeInstanceOf(BookBusyError);
        expect(prismaMock.accounts.update).not.toHaveBeenCalled();
    });

    it('does not take the book lock for a non-reparenting update', async () => {
        await AccountService.update(ACCOUNT, { name: 'Food' });

        expect(resolveBookLockGuidForAccountMock).not.toHaveBeenCalled();
        expect(tryAcquireBookLockMock).not.toHaveBeenCalled();
        expect(prismaMock.accounts.update).toHaveBeenCalled();
    });
});
