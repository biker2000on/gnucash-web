/**
 * SCOPE OF THESE ORDERING TESTS (read before trusting them)
 *
 * They assert the ORDER in which statements are issued against a mocked
 * Prisma client: that the `FOR UPDATE` lock statement is emitted before the
 * reconcile-state read, and the read before the write. That is exactly the
 * regression that has now recurred twice, so it is worth pinning.
 *
 * They do NOT prove:
 *   - that PostgreSQL actually acquires or holds the row lock (a no-op
 *     $queryRaw would satisfy every assertion here);
 *   - that a concurrent reconcile really blocks on it;
 *   - rollback behaviour, or that the canonical guid ordering prevents a real
 *     deadlock.
 *
 * Proving those needs two real database transactions and a barrier. This repo
 * has no real-database test harness (no TEST_DATABASE_URL, no postgres service
 * in docker-compose.yml, no testcontainers, and every prisma-touching test
 * mocks the client), and building one is out of scope here — it is filed as a
 * separate follow-up.
 */
/**
 * Route tests for POST /api/splits/bulk/move — canonical lock ordering.
 *
 * The deadlock-safe ordering shared by every split-writing path is:
 * lock the parent TRANSACTION rows first (ordered by guid, FOR UPDATE),
 * then write the splits, then bump enter_date on the already-locked rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    requireRoleMock,
    getAccountGuidsForBookMock,
    withPeriodLockCheckMock,
    assertNotLockedMock,
    cacheInvalidateFromMock,
    publishDataChangeMock,
} = vi.hoisted(() => ({
    prismaMock: {
        // findFirst is the book-scoped lookup the route uses; findUnique is
        // the unscoped one it used to use, kept mocked so that reverting the
        // fix produces a meaningful assertion failure rather than a TypeError.
        accounts: { findFirst: vi.fn(), findUnique: vi.fn() },
        splits: { findMany: vi.fn(), updateMany: vi.fn() },
        transactions: { updateMany: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    getAccountGuidsForBookMock: vi.fn(),
    withPeriodLockCheckMock: vi.fn(),
    assertNotLockedMock: vi.fn(),
    cacheInvalidateFromMock: vi.fn(),
    publishDataChangeMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({
    getAccountGuidsForBook: getAccountGuidsForBookMock,
}));
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: cacheInvalidateFromMock }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: publishDataChangeMock }));
vi.mock('@/lib/services/period-lock.service', () => {
    class PeriodLockedError extends Error {
        readonly code = 'PERIOD_LOCKED';
    }
    return {
        PeriodLockedError,
        withPeriodLockCheck: withPeriodLockCheckMock,
        assertNotLocked: assertNotLockedMock,
        periodLockedResponse: vi.fn(),
    };
});

import { POST } from '../route';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SPLIT_1 = 'split000000000000000000000000001';
const SPLIT_2 = 'split000000000000000000000000002';
const SPLIT_3 = 'split000000000000000000000000003';
// Deliberately out of sorted order so the sort is observable.
const TX_B = 'transaction00000000000000000000b';
const TX_A = 'transaction00000000000000000000a';
const TARGET_ACCOUNT = 'account0000000000000000000target';
const COMMODITY = 'commodity00000000000000000000usd';
const BOOK_GUID = 'book0000000000000000000000000001';
const POST_DATE = new Date('2026-07-01T00:00:00.000Z');
// Accounts of the caller's own book, and one belonging to a DIFFERENT book.
const ACCOUNT_FROM = 'account00000000000000000000from';
const BOOK_ACCOUNTS = [ACCOUNT_FROM, TARGET_ACCOUNT];
const FOREIGN_ACCOUNT = 'account000000000000000000alien';
const FOREIGN_SPLIT = 'split000000000000000000000alien';

function moveRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost/api/splits/bulk/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function sqlText(call: unknown[]): string {
    return (call[0] as TemplateStringsArray).join('?');
}

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({
        user: { id: 1, username: 'editor' },
        role: 'edit',
        bookGuid: BOOK_GUID,
    });
    getAccountGuidsForBookMock.mockResolvedValue(BOOK_ACCOUNTS);
    prismaMock.accounts.findFirst.mockResolvedValue({
        guid: TARGET_ACCOUNT,
        commodity_guid: COMMODITY,
    });
    prismaMock.accounts.findUnique.mockResolvedValue({
        guid: TARGET_ACCOUNT,
        commodity_guid: COMMODITY,
    });
    // Pre-transaction validation read (with account + transaction includes).
    prismaMock.splits.findMany.mockResolvedValue([
        {
            guid: SPLIT_1, tx_guid: TX_B,
            account: { commodity_guid: COMMODITY },
            transaction: { post_date: POST_DATE },
        },
        {
            guid: SPLIT_2, tx_guid: TX_A,
            account: { commodity_guid: COMMODITY },
            transaction: { post_date: POST_DATE },
        },
        {
            guid: SPLIT_3, tx_guid: TX_A,
            account: { commodity_guid: COMMODITY },
            transaction: { post_date: POST_DATE },
        },
    ]);
    withPeriodLockCheckMock.mockResolvedValue(null);
    assertNotLockedMock.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(
        async (cb: (tx: unknown) => unknown) => cb(prismaMock),
    );
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.splits.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.transactions.updateMany.mockResolvedValue({ count: 2 });
    cacheInvalidateFromMock.mockResolvedValue(undefined);
});

describe('POST /api/splits/bulk/move canonical lock order', () => {
    it('locks parent TRANSACTION rows (ordered) BEFORE writing splits, then bumps enter_date', async () => {
        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1, SPLIT_2, SPLIT_3],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, updated: 3 });

        // The lock query targets transactions rows, deterministically ordered.
        const lockCalls = prismaMock.$queryRaw.mock.calls.filter(
            (call: unknown[]) => sqlText(call).includes('FOR UPDATE'),
        );
        expect(lockCalls).toHaveLength(1);
        const lockSql = sqlText(lockCalls[0]);
        expect(lockSql).toContain('FROM transactions');
        expect(lockSql).toContain('ORDER BY guid');
        expect(lockSql).not.toContain('FROM splits');
        // Distinct parent tx guids, sorted (canonical, deterministic order).
        expect(lockCalls[0][1]).toEqual([TX_A, TX_B]);

        // Ordering: transactions-row lock → splits write → enter_date bump.
        const lockOrder = prismaMock.$queryRaw.mock.invocationCallOrder[0];
        const splitsWriteOrder = prismaMock.splits.updateMany.mock.invocationCallOrder[0];
        const bumpOrder = prismaMock.transactions.updateMany.mock.invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(splitsWriteOrder);
        expect(splitsWriteOrder).toBeLessThan(bumpOrder);

        // The bump targets exactly the locked transactions.
        expect(prismaMock.transactions.updateMany).toHaveBeenCalledWith({
            where: { guid: { in: [TX_A, TX_B] } },
            data: { enter_date: expect.any(Date) },
        });
    });

    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('423s when a %s split is in the batch, before opening the transaction', async (_label, state) => {
        prismaMock.splits.findMany.mockResolvedValue([
            {
                guid: SPLIT_1, tx_guid: TX_A, account_guid: 'account00000000000000000000from',
                reconcile_state: state,
                account: { commodity_guid: COMMODITY, name: 'Assets:Checking' },
                transaction: { post_date: POST_DATE },
            },
        ]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain(SPLIT_1);
        expect(body.error).toContain('Assets:Checking');
        expect(body.error).toMatch(/unreconcile/i);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
    });

    it('423s when a split is reconciled only by the in-transaction re-read', async () => {
        // Fast-fail sees 'n', the authoritative in-transaction read sees 'y'
        // (a concurrent reconcile landed in between) — nothing may move.
        prismaMock.splits.findMany
            .mockResolvedValueOnce([
                {
                    guid: SPLIT_1, tx_guid: TX_A, account_guid: 'account00000000000000000000from',
                    reconcile_state: 'n',
                    account: { commodity_guid: COMMODITY, name: 'Assets:Checking' },
                    transaction: { post_date: POST_DATE },
                },
            ])
            .mockResolvedValueOnce([
                {
                    guid: SPLIT_1, tx_guid: TX_A, account_guid: 'account00000000000000000000from',
                    reconcile_state: 'y',
                    account: { name: 'Assets:Checking' },
                    transaction: { post_date: POST_DATE },
                },
            ]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));

        expect(response.status).toBe(423);
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
    });

    it.each([
        ['not reconciled', 'n'],
        ['cleared', 'c'],
    ])('still moves a %s split normally', async (_label, state) => {
        prismaMock.splits.findMany.mockResolvedValue([
            {
                guid: SPLIT_1, tx_guid: TX_A, account_guid: 'account00000000000000000000from',
                reconcile_state: state,
                account: { commodity_guid: COMMODITY, name: 'Assets:Checking' },
                transaction: { post_date: POST_DATE },
            },
        ]);
        prismaMock.splits.updateMany.mockResolvedValue({ count: 1 });

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));

        expect(response.status).toBe(200);
        // Belt and braces: the protected states and the book scope are in the
        // predicate too, so the write can never land on a reconciled row —
        // nor on another book's row — even without the lock.
        expect(prismaMock.splits.updateMany).toHaveBeenCalledWith({
            where: {
                guid: { in: [SPLIT_1] },
                account_guid: { in: BOOK_ACCOUNTS },
                reconcile_state: { notIn: ['y', 'f'] },
            },
            data: { account_guid: TARGET_ACCOUNT },
        });
    });

    /* TOCTOU. The guard used to sit between the in-transaction read and the
       parent FOR UPDATE lock, so a concurrent reconcile could take the lock
       first and commit 'y' after the guard had already observed 'n'. The lock
       now precedes the read. */

    it('takes the parent lock BEFORE the reconcile-state read, not after it', async () => {
        prismaMock.splits.findMany.mockResolvedValue([
            {
                guid: SPLIT_1, tx_guid: TX_A, account_guid: 'account00000000000000000000from',
                reconcile_state: 'n',
                account: { commodity_guid: COMMODITY, name: 'Assets:Checking' },
                transaction: { post_date: POST_DATE },
            },
        ]);
        prismaMock.splits.updateMany.mockResolvedValue({ count: 1 });

        await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));

        const lockOrder = prismaMock.$queryRaw.mock.invocationCallOrder[0];
        // findMany call 0 is the pre-transaction validation read; call 1 is
        // the authoritative in-transaction read the guard runs on.
        const guardReadOrder = prismaMock.splits.findMany.mock.invocationCallOrder[1];
        const writeOrder = prismaMock.splits.updateMany.mock.invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(guardReadOrder);
        expect(guardReadOrder).toBeLessThan(writeOrder);
    });

    it('423s when the write predicate excludes a row the guard read as unreconciled', async () => {
        // The losing interleaving: guard reads 'n', the row becomes 'y', the
        // predicate then excludes it and updateMany reports fewer rows than
        // requested. That must be a 423, never a quietly short "updated" count.
        prismaMock.splits.findMany.mockResolvedValue([
            {
                guid: SPLIT_1, tx_guid: TX_A, account_guid: 'account00000000000000000000from',
                reconcile_state: 'n',
                account: { commodity_guid: COMMODITY, name: 'Assets:Checking' },
                transaction: { post_date: POST_DATE },
            },
        ]);
        prismaMock.splits.updateMany.mockResolvedValue({ count: 0 });
        // Reads, in order: (1) pre-transaction validation, (2) the guard's
        // in-transaction read — still stale 'n', (3) the post-write
        // diagnostic, which now sees the committed 'y'.
        const stale = {
            guid: SPLIT_1, tx_guid: TX_A, account_guid: 'account00000000000000000000from',
            reconcile_state: 'n',
            account: { commodity_guid: COMMODITY, name: 'Assets:Checking' },
            transaction: { post_date: POST_DATE },
        };
        prismaMock.splits.findMany
            .mockResolvedValueOnce([stale])
            .mockResolvedValueOnce([stale])
            .mockResolvedValueOnce([{
                guid: SPLIT_1, tx_guid: TX_A, account_guid: 'account00000000000000000000from',
                reconcile_state: 'y',
                account: { name: 'Assets:Checking' },
            }]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain(SPLIT_1);
        // The enter_date bump never ran — the whole transaction rolled back.
        expect(prismaMock.transactions.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a currency mismatch before opening the transaction', async () => {
        prismaMock.splits.findMany.mockResolvedValue([
            {
                guid: SPLIT_1, tx_guid: TX_A,
                account: { commodity_guid: 'commodity000000000000000000other' },
                transaction: { post_date: POST_DATE },
            },
        ]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));

        expect(response.status).toBe(400);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
    });
});

/**
 * BOOK SCOPING — the guids in the request body are attacker-controlled.
 *
 * These tests use a Prisma fake that HONOURS the `where` clause instead of
 * returning a canned row list, because that is the only way they can fail when
 * the fix is reverted: a mock that ignores `where` returns the foreign split
 * either way and every assertion below would still pass against the
 * vulnerable route. The fake also keeps `accounts.findUnique` (the unscoped
 * lookup the vulnerable route used) working, so a reverted route reaches a
 * 200 and the test fails on the status, not on a TypeError.
 */
interface FakeSplit {
    guid: string;
    tx_guid: string;
    account_guid: string;
    reconcile_state: string;
}

const ACCOUNT_COMMODITIES: Record<string, string> = {
    [ACCOUNT_FROM]: COMMODITY,
    [TARGET_ACCOUNT]: COMMODITY,
    // Same commodity as the caller's book, so a currency mismatch can never
    // stand in for the book check the test is actually asserting.
    [FOREIGN_ACCOUNT]: COMMODITY,
};

function whereMatches(row: FakeSplit, where: any): boolean {
    if (!where) return true;
    if (where.guid?.in && !where.guid.in.includes(row.guid)) return false;
    if (where.account_guid?.in && !where.account_guid.in.includes(row.account_guid)) return false;
    if (where.reconcile_state?.in && !where.reconcile_state.in.includes(row.reconcile_state)) return false;
    if (where.reconcile_state?.notIn && where.reconcile_state.notIn.includes(row.reconcile_state)) return false;
    // assertNoReconciledSplits addresses splits via an OR of guid/tx_guid.
    if (where.OR && !where.OR.some((clause: any) => whereMatches(row, clause))) return false;
    if (where.tx_guid?.in && !where.tx_guid.in.includes(row.tx_guid)) return false;
    return true;
}

/**
 * Wire the prisma mock up to a mutable row store that respects `where`.
 * `afterRead(callIndex, rows)` runs after each splits.findMany, so a test can
 * simulate a split leaving the book between the pre-check and the locked read.
 */
function installBookAwareDb(
    rows: FakeSplit[],
    afterRead?: (callIndex: number, rows: FakeSplit[]) => void,
) {
    let readCount = 0;
    prismaMock.splits.findMany.mockImplementation(async ({ where }: any) => {
        const hit = rows.filter(r => whereMatches(r, where)).map(r => ({
            ...r,
            account: {
                commodity_guid: ACCOUNT_COMMODITIES[r.account_guid],
                name: `Account ${r.account_guid}`,
            },
            transaction: { post_date: POST_DATE },
        }));
        afterRead?.(readCount++, rows);
        return hit;
    });
    prismaMock.splits.updateMany.mockImplementation(async ({ where, data }: any) => {
        const hit = rows.filter(r => whereMatches(r, where));
        for (const r of hit) r.account_guid = data.account_guid;
        return { count: hit.length };
    });
    prismaMock.accounts.findFirst.mockImplementation(async ({ where }: any) => {
        const guid = where?.guid?.equals;
        const scope: string[] | undefined = where?.guid?.in;
        if (!guid || !(guid in ACCOUNT_COMMODITIES)) return null;
        if (scope && !scope.includes(guid)) return null;
        return { guid, commodity_guid: ACCOUNT_COMMODITIES[guid] };
    });
    // The unscoped lookup the vulnerable route used — present so a reverted
    // route still reaches a 200 and these tests fail on the assertion.
    prismaMock.accounts.findUnique.mockImplementation(async ({ where }: any) => {
        const guid = where?.guid;
        if (!guid || !(guid in ACCOUNT_COMMODITIES)) return null;
        return { guid, commodity_guid: ACCOUNT_COMMODITIES[guid] };
    });
    return rows;
}

function ownSplit(guid: string, tx = TX_A): FakeSplit {
    return { guid, tx_guid: tx, account_guid: ACCOUNT_FROM, reconcile_state: 'n' };
}

function foreignSplit(): FakeSplit {
    return { guid: FOREIGN_SPLIT, tx_guid: TX_B, account_guid: FOREIGN_ACCOUNT, reconcile_state: 'n' };
}

describe('POST /api/splits/bulk/move book scoping', () => {
    it('moves a split that is inside the caller book', async () => {
        const rows = installBookAwareDb([ownSplit(SPLIT_1)]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, updated: 1 });
        expect(rows[0].account_guid).toBe(TARGET_ACCOUNT);
        expect(getAccountGuidsForBookMock).toHaveBeenCalledWith(BOOK_GUID);
        // Both the read and the WRITE carry the book constraint — the write
        // predicate is what actually keeps another book's row unreachable.
        expect(prismaMock.splits.updateMany).toHaveBeenCalledWith({
            where: {
                guid: { in: [SPLIT_1] },
                account_guid: { in: BOOK_ACCOUNTS },
                reconcile_state: { notIn: ['y', 'f'] },
            },
            data: { account_guid: TARGET_ACCOUNT },
        });
    });

    it('404s a split belonging to ANOTHER book, moving nothing', async () => {
        const rows = installBookAwareDb([foreignSplit()]);

        const response = await POST(moveRequest({
            splitGuids: [FOREIGN_SPLIT],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Some splits not found in this book');
        // Rejected before the transaction ever opens; the row is untouched.
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
        expect(rows[0].account_guid).toBe(FOREIGN_ACCOUNT);
        expect(publishDataChangeMock).not.toHaveBeenCalled();
    });

    it('404s a target account belonging to ANOTHER book, moving nothing', async () => {
        const rows = installBookAwareDb([ownSplit(SPLIT_1)]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: FOREIGN_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(404);
        // Distinct from the split message, so the caller learns which end of
        // the move was rejected — without learning whether the guid exists.
        expect(body.error).toBe('Target account not found in this book');
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
        expect(rows[0].account_guid).toBe(ACCOUNT_FROM);
    });

    it('rejects a MIXED batch atomically — the in-book split does not move either', async () => {
        const rows = installBookAwareDb([ownSplit(SPLIT_1), foreignSplit()]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1, FOREIGN_SPLIT],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Some splits not found in this book');
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
        expect(rows.map(r => r.account_guid)).toEqual([ACCOUNT_FROM, FOREIGN_ACCOUNT]);
    });

    it('404s when the book resolves to NO accounts, without relying on an empty IN', async () => {
        const rows = installBookAwareDb([ownSplit(SPLIT_1)]);
        getAccountGuidsForBookMock.mockResolvedValue([]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Target account not found in this book');
        // Fails closed before any query runs — the guarantee does not depend
        // on how the ORM renders `in: []`.
        expect(prismaMock.accounts.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.splits.findMany).not.toHaveBeenCalled();
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(rows[0].account_guid).toBe(ACCOUNT_FROM);
    });

    it('does not treat a DUPLICATED guid in the body as a missing split', async () => {
        const rows = installBookAwareDb([ownSplit(SPLIT_1), ownSplit(SPLIT_2, TX_B)]);

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1, SPLIT_1, SPLIT_2],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        // 3 guids requested, 2 distinct rows: the counts are compared after
        // deduping, so this is a plain success, not a spurious 404/423.
        expect(response.status).toBe(200);
        expect(body).toEqual({ success: true, updated: 2 });
        expect(prismaMock.splits.updateMany).toHaveBeenCalledWith({
            where: {
                guid: { in: [SPLIT_1, SPLIT_2] },
                account_guid: { in: BOOK_ACCOUNTS },
                reconcile_state: { notIn: ['y', 'f'] },
            },
            data: { account_guid: TARGET_ACCOUNT },
        });
        expect(rows.every(r => r.account_guid === TARGET_ACCOUNT)).toBe(true);
    });

    it('404s from INSIDE the transaction when a split leaves the book after the pre-check', async () => {
        // The pre-transaction read sees an in-book split; by the time the
        // parent lock is held and the authoritative read runs, the split has
        // been re-parented into another book. The in-transaction guard — not
        // the pre-check — is what must catch this.
        const rows = installBookAwareDb([ownSplit(SPLIT_1)], (callIndex, live) => {
            if (callIndex === 0) live[0].account_guid = FOREIGN_ACCOUNT;
        });

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Some splits not found in this book');
        // We got past the pre-check and into the transaction...
        expect(prismaMock.$transaction).toHaveBeenCalled();
        expect(prismaMock.$queryRaw).toHaveBeenCalled();
        // ...but nothing was written, and the enter_date bump never ran.
        expect(prismaMock.splits.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.transactions.updateMany).not.toHaveBeenCalled();
        expect(rows[0].account_guid).toBe(FOREIGN_ACCOUNT);
    });

    it('404s — and names NO foreign account — when the row leaves the book AND is reconciled', async () => {
        // The leak this guards. Both predicates on the write exclude the row
        // at once: it has left the book AND become reconciled. Diagnosing the
        // reconcile state first would answer with a 423 naming an account in
        // SOMEONE ELSE'S book. The book scope must be ruled out first, so the
        // answer is the same 404 any other out-of-book split gets.
        const rows = installBookAwareDb([ownSplit(SPLIT_1)], (callIndex, live) => {
            if (callIndex === 1) {
                live[0].account_guid = FOREIGN_ACCOUNT;
                live[0].reconcile_state = 'y';
            }
        });

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body).toEqual({ error: 'Some splits not found in this book' });
        // Nothing about the foreign account leaks: not its guid, not the name
        // the 423 message would have embedded, not the 423 code itself.
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(FOREIGN_ACCOUNT);
        expect(serialized).not.toContain('Account ' + FOREIGN_ACCOUNT);
        expect(serialized).not.toContain('RECONCILED_SPLIT');
        expect(serialized).not.toMatch(/unreconcile/i);
        // Rolled back: no enter_date bump, and the row never moved.
        expect(prismaMock.transactions.updateMany).not.toHaveBeenCalled();
        expect(rows[0].account_guid).toBe(FOREIGN_ACCOUNT);
    });

    it('still returns the actionable 423 — naming the account — for an IN-BOOK reconciled split', async () => {
        // The counterpart to the test above: the diagnostic re-read is book
        // scoped, but for a split that is still in this book it must keep
        // naming the split and its account, or the 423 stops being actionable.
        installBookAwareDb([ownSplit(SPLIT_1)], (callIndex, live) => {
            if (callIndex === 1) live[0].reconcile_state = 'y';
        });

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain(SPLIT_1);
        expect(body.error).toContain(`Account ${ACCOUNT_FROM}`);
        expect(body.error).toMatch(/unreconcile/i);
    });

    it('404s when only the WRITE predicate excludes an out-of-book row', async () => {
        // Belt and braces: both reads see the split as in-book (stale), so the
        // book constraint on the updateMany itself is the last line of
        // defence. A short count with nothing reconciled must be a 404, never
        // a quietly short "updated".
        const rows = installBookAwareDb([ownSplit(SPLIT_1)], (callIndex, live) => {
            // Move it out of book only after BOTH reads have been served.
            if (callIndex === 1) live[0].account_guid = FOREIGN_ACCOUNT;
        });

        const response = await POST(moveRequest({
            splitGuids: [SPLIT_1],
            targetAccountGuid: TARGET_ACCOUNT,
        }));
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.error).toBe('Some splits not found in this book');
        expect(prismaMock.splits.updateMany).toHaveBeenCalled();
        // The write matched nothing and the transaction rolled back.
        expect(rows[0].account_guid).toBe(FOREIGN_ACCOUNT);
        expect(prismaMock.transactions.updateMany).not.toHaveBeenCalled();
    });
});
