/**
 * ASI-5-009 (race half) — unit coverage for the half of the fix a real
 * database cannot easily stage: what happens when a create loses to a writer
 * that never took the advisory lock and a unique key is the thing that rejects
 * it — the commodities key on every database, and a (parent_guid, name) key on
 * a database where one exists (an operator's; db-init itself deliberately keeps
 * none, because scheduled-transaction templates share (parent, '')).
 *
 * The concurrency itself is proven in simplefin-create-race.integration.test.ts
 * against real PostgreSQL. Nothing here fakes a lock, and nothing here decides
 * who wins: each test scripts one SCENARIO (the database says "duplicate", or
 * says something else) and checks what the service does about it. That
 * distinction matters — a fake that implemented the exclusion rule would only
 * ever be testing itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PARENT = 'p'.repeat(32);
const ROOT = 'r'.repeat(32);
const BOOK = 'b'.repeat(32);
const WINNER = 'w'.repeat(32);
const COMMODITY = 'c'.repeat(32);

const mocks = vi.hoisted(() => ({
    prisma: {} as Record<string, unknown>,
    acquireNamedXactLock: vi.fn(async () => true),
    accountNameLockKey: vi.fn((parent: string, name: string) => `account:${parent}:${name}`),
    commodityLockKey: vi.fn((ns: string, mnemonic: string) => `commodity:${ns}:${mnemonic}`),
}));

vi.mock('@/lib/prisma', () => ({
    default: mocks.prisma,
    generateGuid: () => 'n'.repeat(32),
}));

vi.mock('@/lib/book-lock', () => ({
    acquireNamedXactLock: mocks.acquireNamedXactLock,
    accountNameLockKey: mocks.accountNameLockKey,
    commodityLockKey: mocks.commodityLockKey,
}));

import {
    getOrCreateCashChild,
    getOrCreateChildAccount,
    isUniqueViolationOn,
} from '../simplefin-sync.service';

/** The exact error Prisma 7 + the pg adapter raise for these two indexes. */
function uniqueViolation(constraint: string, fields: string[]) {
    return Object.assign(new Error('Invalid `prisma.accounts.create()` invocation'), {
        code: 'P2002',
        meta: {
            modelName: 'accounts',
            driverAdapterError: {
                name: 'DriverAdapterError',
                cause: {
                    originalCode: '23505',
                    originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
                    kind: 'UniqueConstraintViolation',
                    constraint: { fields },
                },
            },
        },
    });
}

const accountsConflict = () => uniqueViolation('uq_accounts_parent_name', ['parent_guid', 'name']);

/** Passthrough transaction: the lock is mocked, so there is nothing to fake. */
function transaction(tx: Record<string, unknown>) {
    return (operation: (client: Record<string, unknown>) => Promise<unknown>) => operation(tx);
}

describe('SimpleFin create-if-missing: losing to a writer that skipped the lock', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of Object.keys(mocks.prisma)) delete mocks.prisma[key];
    });

    describe('Cash child', () => {
        /**
         * `findFirst` answers by call order because that is what the scenario
         * IS: absent, still absent inside the transaction, then present once
         * the other writer has committed. Nothing here decides who wins.
         */
        function installCashScript(cashRowsInOrder: Array<{ guid: string } | null>, createImpl: () => Promise<unknown>) {
            let cashLookups = 0;
            const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
                if (where.name === 'Cash') return cashRowsInOrder[cashLookups++] ?? null;
                // The parent lookup.
                return { guid: PARENT, account_type: 'BANK', commodity_guid: COMMODITY, commodity_scu: 100 };
            });
            const create = vi.fn(createImpl);
            Object.assign(mocks.prisma, {
                accounts: { findFirst, create },
                $transaction: transaction({ accounts: { findFirst, create } }),
            });
            return { findFirst, create };
        }

        it('adopts the account the winner created instead of failing the import', async () => {
            const { create } = installCashScript(
                [null, null, { guid: WINNER }],
                async () => { throw accountsConflict(); },
            );
            const created = { count: 0 };

            await expect(getOrCreateCashChild(PARENT, BOOK, new Set([PARENT]), created))
                .resolves.toBe(WINNER);

            expect(create).toHaveBeenCalledTimes(1);
            // The loser created nothing; counting it would invalidate caches
            // for an account it did not make.
            expect(created.count).toBe(0);
            expect(mocks.accountNameLockKey).toHaveBeenCalledWith(PARENT, 'Cash');
        });

        it('rethrows when the conflict left nothing to adopt', async () => {
            // No surviving row means the collision was not this account being
            // created twice. Returning some other guid here would import money
            // into the wrong account; the import must fail loudly instead.
            installCashScript([null, null, null], async () => { throw accountsConflict(); });

            await expect(getOrCreateCashChild(PARENT, BOOK, new Set([PARENT])))
                .rejects.toMatchObject({ code: 'P2002' });
        });

        it('rethrows an unrelated database error rather than swallowing it', async () => {
            installCashScript(
                [null, null, { guid: WINNER }],
                async () => { throw Object.assign(new Error('deadlock detected'), { code: 'P2034' }); },
            );

            await expect(getOrCreateCashChild(PARENT, BOOK, new Set([PARENT])))
                .rejects.toThrow('deadlock detected');
        });

        it('counts exactly one creation when it wins the race', async () => {
            const { create } = installCashScript([null, null], async () => ({}));
            const created = { count: 0 };

            await expect(getOrCreateCashChild(PARENT, BOOK, new Set([PARENT]), created))
                .resolves.toBe('n'.repeat(32));
            expect(create).toHaveBeenCalledTimes(1);
            expect(created.count).toBe(1);
        });
    });

    describe('symbol child', () => {
        function installSymbolScript(
            symbolLookupsInOrder: Array<Array<{ guid: string }>>,
            createImpl: () => Promise<unknown>,
        ) {
            let lookups = 0;
            const queryRaw = vi.fn(async () => symbolLookupsInOrder[lookups++] ?? []);
            const create = vi.fn(createImpl);
            const client = {
                accounts: { create },
                commodities: { findFirst: vi.fn(async () => ({ guid: COMMODITY, fraction: 10000 })) },
                $queryRaw: queryRaw,
            };
            Object.assign(mocks.prisma, { ...client, $transaction: transaction(client) });
            return { create, queryRaw };
        }

        it('adopts the sibling carrying the same symbol', async () => {
            const created = { count: 0 };
            installSymbolScript(
                [[], [], [{ guid: WINNER }]],
                async () => { throw accountsConflict(); },
            );

            await expect(
                getOrCreateChildAccount(PARENT, 'aapl', 'Apple', BOOK, new Set([PARENT]), created),
            ).resolves.toBe(WINNER);
            expect(created.count).toBe(0);
            expect(mocks.accountNameLockKey).toHaveBeenCalledWith(PARENT, 'AAPL');
        });

        it('refuses to adopt a same-named sibling holding a different security', async () => {
            // The name collided but no child carries this symbol: the existing
            // "AAPL" tracks some other commodity. Routing this symbol's
            // transactions into it would be a silent mis-import, so the error
            // surfaces and the sync reports the account it could not resolve.
            installSymbolScript([[], [], []], async () => { throw accountsConflict(); });

            await expect(
                getOrCreateChildAccount(PARENT, 'AAPL', 'Apple', BOOK, new Set([PARENT])),
            ).rejects.toMatchObject({ code: 'P2002' });
        });

        it('refuses to touch a parent outside the synced book', async () => {
            installSymbolScript([[]], async () => ({}));

            await expect(
                getOrCreateChildAccount(PARENT, 'AAPL', 'Apple', BOOK, new Set([ROOT])),
            ).rejects.toThrow(`Parent account ${PARENT} is not in book ${BOOK}`);
        });
    });

    describe('isUniqueViolationOn', () => {
        it('recognizes the index by name and by column tuple', () => {
            expect(isUniqueViolationOn(accountsConflict(), ['uq_accounts_parent_name'])).toBe(true);
            expect(isUniqueViolationOn(accountsConflict(), ['"parent_guid","name"'])).toBe(true);
            expect(
                isUniqueViolationOn(
                    Object.assign(new Error('x'), { code: 'P2002', meta: { target: ['parent_guid', 'name'] } }),
                    ['"parent_guid","name"'],
                ),
            ).toBe(true);
        });

        it('does not claim a different constraint, or a non-unique failure', () => {
            expect(isUniqueViolationOn(accountsConflict(), ['uq_commodities_namespace_mnemonic'])).toBe(false);
            expect(
                isUniqueViolationOn(
                    uniqueViolation('uq_commodities_namespace_mnemonic', ['namespace', 'mnemonic']),
                    ['uq_accounts_parent_name', '"parent_guid","name"'],
                ),
            ).toBe(false);
            expect(isUniqueViolationOn(new Error('uq_accounts_parent_name is fine'), ['uq_accounts_parent_name'])).toBe(false);
            expect(isUniqueViolationOn(null, ['uq_accounts_parent_name'])).toBe(false);
        });
    });
});
