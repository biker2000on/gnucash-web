/**
 * `AccountService` is a check-then-insert on (parent_guid, name) with no DB
 * arbiter behind it: a unique index on accounts(parent_guid, name) cannot
 * exist, because scheduled-transaction templates share (parent, '') by design
 * (src/lib/db-init.ts, ACCOUNTS_SIBLING_NAME_INDEX). So the per-(parent, name)
 * advisory lock is the ONLY thing standing between two concurrent "New
 * account" clicks and a book with two identically-named siblings — which the
 * name-resolving importers (personal-import, qif, settlement-import) would then
 * post into arbitrarily.
 *
 * `create` is not the only door into that state. RENAME and REPARENT put an
 * EXISTING account on a (parent, name) key just as effectively, so `update` and
 * `move` claim the destination key the same way — otherwise the duplicate
 * `create` refuses simply arrives by a different route, which is the state the
 * dropped index used to make impossible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, txMock, logAuditMock } = vi.hoisted(() => {
    // NOTE: no `$transaction` on the tx double — that absence is exactly what
    // marks an interactive-transaction client, and what stops the advisory-lock
    // helper from refusing the lock. See book-lock-transaction-scope.test.ts.
    const txMock = {
        accounts: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
        slots: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
        // `locked` is boolean for pg_try_advisory_xact_lock and null for the
        // ::text-cast pg_advisory_xact_lock — both helpers share this double.
        $queryRaw: vi.fn(async (): Promise<Array<{ locked: boolean | null }>> => [{ locked: true }]),
        $executeRaw: vi.fn(),
    };
    return {
        txMock,
        prismaMock: {
            accounts: { findUnique: vi.fn(), findFirst: vi.fn() },
            commodities: { findUnique: vi.fn() },
            splits: { count: vi.fn() },
            books: { findFirst: vi.fn() },
            $queryRaw: vi.fn(),
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

/** GnuCash guids are exactly 32 chars, and the service validates that. */
const g = (label: string) => label.padEnd(32, '0');

const SELF = g('self');
const ROOT = g('root');
const BOOK = g('book');
const OTHER = g('other');
const NEW_PARENT = g('newparent');

/** Existing row `update`/`move` read before deciding anything. */
const existingAccount = (over: Record<string, unknown> = {}) => ({
    guid: SELF,
    name: 'Groceries',
    parent_guid: PARENT,
    commodity_guid: COMMODITY,
    account_type: 'EXPENSE',
    code: '',
    description: '',
    hidden: 0,
    placeholder: 0,
    ...over,
});

/**
 * What the LOCKED in-transaction read of the account returns — the row
 * `lockAccountKey` hands back after its `SELECT ... FOR UPDATE`.
 *
 * It is a separate knob from the pre-transaction snapshot on purpose. Holding
 * the two equal is the uncontended case; setting them differently is the ONLY
 * way to express, at this tier, "another writer committed in between", which is
 * exactly the interleaving that made the previous fixed-snapshot version of
 * this file unable to see the bug.
 */
let lockedRow: { name: string; parent_guid: string | null } = {
    name: 'Groceries',
    parent_guid: PARENT,
};

/**
 * Point both reads of the account at the same row: the ordinary case, where
 * nothing commits between the pre-transaction read and the locked one.
 */
function accountIs(over: Record<string, unknown> = {}) {
    const row = existingAccount(over);
    prismaMock.accounts.findUnique.mockResolvedValue(row);
    lockedRow = { name: row.name as string, parent_guid: row.parent_guid as string | null };
}

/**
 * Every lock the service took, in order, as
 * `['try:book:<guid>', 'row:<guid>', 'lock:account:<parent>:<name>']`. All
 * three go through `$queryRaw`, and telling them apart is the point: the order
 * IS the deadlock-freedom argument (see `lockAccountKey` on lock ordering).
 */
function recordLocks(): string[] {
    const locks: string[] = [];
    txMock.$queryRaw.mockImplementation(async (...args: unknown[]) => {
        const sql = Array.isArray(args[0]) ? (args[0] as string[]).join('?') : String(args[0]);
        if (sql.includes('FOR UPDATE')) {
            locks.push(`row:${String(args[1])}`);
            // `SELECT 1 AS locked` — the value is unused; only the wait matters.
            return [{ locked: true }];
        }
        const kind = sql.includes('pg_try_advisory_xact_lock') ? 'try' : 'lock';
        locks.push(`${kind}:${String(args[1])}`);
        return [{ locked: true }];
    });
    return locks;
}

beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txMock));
    prismaMock.accounts.findUnique.mockResolvedValue({ guid: PARENT });
    prismaMock.commodities.findUnique.mockResolvedValue({ guid: COMMODITY, fraction: 100 });
    prismaMock.splits.count.mockResolvedValue(0);
    // resolveBookLockGuidForAccount: root walk, then the owning book.
    prismaMock.$queryRaw.mockResolvedValue([{ guid: ROOT }]);
    prismaMock.books.findFirst.mockResolvedValue({ guid: BOOK });
    txMock.$queryRaw.mockResolvedValue([{ locked: true }]);
    txMock.accounts.findFirst.mockResolvedValue(null);
    lockedRow = { name: 'Groceries', parent_guid: PARENT };
    // Two callers, two shapes: `lockAccountKey` re-reads the account itself
    // under the row lock, and `assertReparentIsAcyclic` walks up from the
    // destination parent.
    txMock.accounts.findUnique.mockImplementation(
        async ({ where }: { where: { guid: string } }) =>
            where.guid === SELF
                ? { guid: SELF, ...lockedRow }
                : { guid: where.guid, parent_guid: null },
    );
    txMock.accounts.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
    txMock.accounts.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
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

describe('AccountService.update — rename lands on the same sibling key', () => {
    it('refuses a rename onto a name a sibling already holds', async () => {
        accountIs();
        txMock.accounts.findFirst.mockResolvedValue({ guid: OTHER });

        await expect(AccountService.update(SELF, { name: 'Utilities' }))
            // Byte-for-byte the message `create` refuses with, so the UI has one
            // string to recognise and the route maps both to the same 400.
            .rejects.toThrow('An account named "Utilities" already exists under this parent');
        expect(txMock.accounts.update).not.toHaveBeenCalled();
    });

    it('claims the DESTINATION name, not the current one, and locks before re-checking', async () => {
        accountIs();
        const locks = recordLocks();
        const order: string[] = [];
        txMock.accounts.findFirst.mockImplementation(async () => { order.push('recheck'); return null; });
        txMock.accounts.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
            order.push('update');
            return data;
        });

        await AccountService.update(SELF, { name: 'Utilities' });

        // A rename is not a reparent, so no book lock — the row lock on the
        // account being renamed, then the one name lock, keyed on where the
        // account is GOING.
        expect(locks).toEqual([`row:${SELF}`, `lock:account:${PARENT}:Utilities`]);
        expect(order).toEqual(['recheck', 'update']);
    });

    it('excludes the account itself, so a no-op rename is not a self-clash', async () => {
        accountIs();

        await AccountService.update(SELF, { name: 'Utilities' });

        expect(txMock.accounts.findFirst).toHaveBeenCalledWith({
            where: { parent_guid: PARENT, name: 'Utilities', guid: { not: SELF } },
            select: { guid: true },
        });
    });

    it('takes no lock at all when the payload touches neither name nor parent', async () => {
        accountIs();
        const locks = recordLocks();

        await AccountService.update(SELF, { description: 'just a description' });

        // Not even the row lock: an update that writes neither half of the key
        // cannot land the account on a different one, whatever else commits.
        expect(locks).toEqual([]);
        expect(txMock.accounts.update).toHaveBeenCalledTimes(1);
    });

    it('takes book lock, then row lock, then name lock when reparenting', async () => {
        accountIs();
        const locks = recordLocks();
        await AccountService.update(SELF, { parent_guid: NEW_PARENT });

        // The ordering that makes deadlock impossible: book lock (non-blocking,
        // one per operation at most), then the row lock on the account being
        // changed, then the name lock (one per operation, on the destination
        // only). Never the reverse — see `lockAccountKey`.
        expect(locks).toEqual([
            `try:book:${BOOK}`,
            `row:${SELF}`,
            `lock:account:${NEW_PARENT}:Groceries`,
        ]);
    });

    it('refuses a reparent that collides under the new parent', async () => {
        accountIs();
        txMock.accounts.findFirst.mockResolvedValue({ guid: OTHER });

        await expect(
            AccountService.update(SELF, { parent_guid: NEW_PARENT }),
        ).rejects.toThrow('An account named "Groceries" already exists under this parent');
        expect(txMock.accounts.update).not.toHaveBeenCalled();
    });

    it('refuses a rename of an account that was deleted before the row lock', async () => {
        prismaMock.accounts.findUnique.mockResolvedValue(existingAccount());
        txMock.accounts.findUnique.mockImplementation(
            async ({ where }: { where: { guid: string } }) =>
                where.guid === SELF ? null : { guid: where.guid, parent_guid: null },
        );

        await expect(AccountService.update(SELF, { name: 'Utilities' }))
            .rejects.toThrow(`Account not found: ${SELF}`);
        expect(txMock.accounts.update).not.toHaveBeenCalled();
    });
});

/**
 * The stale-destination interleavings.
 *
 * A sibling key has two halves and every mutation writes only ONE of them, so a
 * destination computed from a read taken BEFORE the transaction can be
 * invalidated by a concurrent write to the other half — and the key the row
 * actually lands on is then one nothing locked and nothing re-checked.
 *
 * What this tier can and cannot show: the fake below models "the pre-
 * transaction read saw A, the locked read saw B", and asserts the service keys
 * its claim off B. That is a real assertion about which read feeds the key, and
 * it is exactly what the previous fixed-snapshot version of this file could not
 * make. It is NOT a proof of mutual exclusion — a double cannot demonstrate row
 * locking whatever it returns. That proof is
 * account-rename-reparent-race.integration.test.ts, which drives both
 * interleavings through real Postgres on two real connections and shows the
 * duplicate landing without this fix.
 */
describe('AccountService — the destination key comes from the LOCKED read', () => {
    it('rename-during-move: claims under the parent a concurrent move committed', async () => {
        // Pre-transaction snapshot: still under PARENT.
        prismaMock.accounts.findUnique.mockResolvedValue(existingAccount());
        // By the time the row lock is granted, a concurrent move has committed
        // parent_guid = NEW_PARENT. The rename writes `name` only, so the row
        // LANDS on (NEW_PARENT, 'Utilities') — which is therefore the key that
        // has to be claimed.
        lockedRow = { name: 'Groceries', parent_guid: NEW_PARENT };
        const locks = recordLocks();

        await AccountService.update(SELF, { name: 'Utilities' });

        expect(locks).toEqual([`row:${SELF}`, `lock:account:${NEW_PARENT}:Utilities`]);
        expect(txMock.accounts.findFirst).toHaveBeenCalledWith({
            where: { parent_guid: NEW_PARENT, name: 'Utilities', guid: { not: SELF } },
            select: { guid: true },
        });
    });

    it('rename-during-move: refuses when that parent already holds the name', async () => {
        prismaMock.accounts.findUnique.mockResolvedValue(existingAccount());
        lockedRow = { name: 'Groceries', parent_guid: NEW_PARENT };
        txMock.accounts.findFirst.mockResolvedValue({ guid: OTHER });

        await expect(AccountService.update(SELF, { name: 'Utilities' }))
            .rejects.toThrow('An account named "Utilities" already exists under this parent');
        expect(txMock.accounts.update).not.toHaveBeenCalled();
    });

    it('move-during-rename: claims the name a concurrent rename committed', async () => {
        // Pre-transaction snapshot: still named 'Groceries'.
        prismaMock.accounts.findUnique.mockResolvedValue(existingAccount());
        // A concurrent rename committed first. The move writes `parent_guid`
        // only, so the row lands on (NEW_PARENT, 'Utilities') — claiming
        // (NEW_PARENT, 'Groceries') would lock a key it never occupies.
        lockedRow = { name: 'Utilities', parent_guid: PARENT };
        const locks = recordLocks();

        await AccountService.move(SELF, NEW_PARENT);

        expect(locks).toEqual([
            `try:book:${BOOK}`,
            `row:${SELF}`,
            `lock:account:${NEW_PARENT}:Utilities`,
        ]);
        expect(txMock.accounts.findFirst).toHaveBeenCalledWith({
            where: { parent_guid: NEW_PARENT, name: 'Utilities', guid: { not: SELF } },
            select: { guid: true },
        });
    });

    it('move-during-rename: refuses when the new parent already holds that name', async () => {
        prismaMock.accounts.findUnique.mockResolvedValue(existingAccount());
        lockedRow = { name: 'Utilities', parent_guid: PARENT };
        txMock.accounts.findFirst.mockResolvedValue({ guid: OTHER });

        await expect(AccountService.move(SELF, NEW_PARENT))
            .rejects.toThrow('An account named "Utilities" already exists under this parent');
        expect(txMock.accounts.update).not.toHaveBeenCalled();
    });

    it('move-during-move: no claim when a concurrent move already landed it there', async () => {
        // The destination is where the account already is by the time the row
        // lock is granted, so this move writes nothing that changes the key.
        prismaMock.accounts.findUnique.mockResolvedValue(existingAccount());
        lockedRow = { name: 'Groceries', parent_guid: NEW_PARENT };
        const locks = recordLocks();

        await AccountService.move(SELF, NEW_PARENT);

        expect(locks).toEqual([`try:book:${BOOK}`, `row:${SELF}`]);
        expect(txMock.accounts.findFirst).not.toHaveBeenCalled();
    });
});

describe('AccountService.move — reparent lands on the destination sibling key', () => {
        it('refuses a move onto an occupied (parent, name)', async () => {
        accountIs();
        txMock.accounts.findFirst.mockResolvedValue({ guid: OTHER });

        await expect(AccountService.move(SELF, NEW_PARENT))
            .rejects.toThrow('An account named "Groceries" already exists under this parent');
        expect(txMock.accounts.update).not.toHaveBeenCalled();
    });

    it('locks book, then row, then destination name, and excludes itself', async () => {
        accountIs();
        const locks = recordLocks();

        await AccountService.move(SELF, NEW_PARENT);

        expect(locks).toEqual([
            `try:book:${BOOK}`,
            `row:${SELF}`,
            `lock:account:${NEW_PARENT}:Groceries`,
        ]);
        expect(txMock.accounts.findFirst).toHaveBeenCalledWith({
            where: { parent_guid: NEW_PARENT, name: 'Groceries', guid: { not: SELF } },
            select: { guid: true },
        });
    });

    it('takes no NAME lock when the parent does not change', async () => {
        // Vacating a key cannot create a duplicate under it, and a move to the
        // same parent moves nothing — so there is no destination key to claim.
        // The row lock is still taken: "the parent does not change" is a claim
        // about the LOCKED row, and reading it is what the lock is for.
        accountIs();
        const locks = recordLocks();

        await AccountService.move(SELF, PARENT);

        expect(locks).toEqual([`try:book:${BOOK}`, `row:${SELF}`]);
    });

    it('does not claim a key for a scheduled-transaction template row', async () => {
        // Template children are all named '' under their per-SX root and are
        // SUPPOSED to share a key — refusing them as duplicates would break
        // exactly the shape the missing unique index exists to protect.
        accountIs({ name: '' });
        const locks = recordLocks();

        await AccountService.move(SELF, NEW_PARENT);

        expect(locks).toEqual([`try:book:${BOOK}`, `row:${SELF}`]);
        expect(txMock.accounts.findFirst).not.toHaveBeenCalled();
    });

    it('takes no name lock when moving to the top level', async () => {
        // parent_guid null: the account becomes a root, sibling of nothing.
        accountIs();
        const locks = recordLocks();

        await AccountService.move(SELF, null);

        expect(locks).toEqual([`try:book:${BOOK}`, `row:${SELF}`]);
        expect(txMock.accounts.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a move of an account deleted between the pre-check and the row lock', async () => {
        prismaMock.accounts.findUnique.mockResolvedValue(existingAccount());
        txMock.accounts.findUnique.mockImplementation(
            async ({ where }: { where: { guid: string } }) =>
                where.guid === SELF ? null : { guid: where.guid, parent_guid: null },
        );

        await expect(AccountService.move(SELF, NEW_PARENT))
            .rejects.toThrow(`Account not found: ${SELF}`);
        expect(txMock.accounts.update).not.toHaveBeenCalled();
    });
});
