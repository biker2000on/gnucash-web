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
    // The account-key funnel in account-lock-order.ts locks through this.
    acquireAccountKeyLockUnchecked: mocks.acquireNamedXactLock,
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

        it('matches the constraint EXACTLY, not as a substring', () => {
            // A constraint whose name merely CONTAINS ours is a different
            // constraint. Adopting its "winner" would silently import into
            // whatever row that other key happened to protect — the failure a
            // substring test cannot distinguish from a real recovery.
            for (const impostor of [
                'uq_accounts_parent_name_v2',
                'tmp_uq_accounts_parent_name',
                'uq_accounts_parent_name_lower',
            ]) {
                expect(
                    isUniqueViolationOn(uniqueViolation(impostor, ['parent_guid', 'name', 'code']), [
                        'uq_accounts_parent_name',
                    ]),
                ).toBe(false);
            }

            // Likewise for the column-tuple form: a superset of our columns is
            // a different key.
            expect(
                isUniqueViolationOn(
                    Object.assign(new Error('x'), {
                        code: 'P2002',
                        meta: { target: ['parent_guid', 'name', 'code'] },
                    }),
                    ['"parent_guid","name"'],
                ),
            ).toBe(false);

            // The exact name still matches, from either surface form.
            expect(isUniqueViolationOn(accountsConflict(), ['uq_accounts_parent_name'])).toBe(true);
        });

        it('reads the raw node-postgres error shape too', () => {
            // The importers and db-init talk to Postgres through `pg`, not
            // Prisma: no P2002, a `constraint` field, and 23505.
            const raw = Object.assign(
                new Error('duplicate key value violates unique constraint "uq_accounts_parent_name"'),
                { code: '23505', constraint: 'uq_accounts_parent_name', table: 'accounts' },
            );
            expect(isUniqueViolationOn(raw, ['uq_accounts_parent_name'])).toBe(true);
            expect(isUniqueViolationOn(raw, ['uq_commodities_namespace_mnemonic'])).toBe(false);
        });

        it('does not claim a non-unique failure that happens to name the index', () => {
            // e.g. a check-constraint or FK error whose text mentions the index.
            const notUnique = Object.assign(
                new Error('constraint "uq_accounts_parent_name" cannot be dropped'),
                { code: '2BP01' },
            );
            expect(isUniqueViolationOn(notUnique, ['uq_accounts_parent_name'])).toBe(false);
        });

        it('survives a cyclic error graph instead of hanging', () => {
            const err = accountsConflict() as Error & { self?: unknown };
            err.self = err;
            expect(isUniqueViolationOn(err, ['uq_accounts_parent_name'])).toBe(true);
        });

        /**
         * Inspecting an error must never BECOME the error.
         *
         * This predicate only ever runs on the failure path, and reading a
         * property is not inert: an enumerable getter can throw, and a Proxy
         * can throw from `get`, from `ownKeys`, or by being revoked. If any of
         * that escaped, `adoptUniqueConflictWinner` would propagate the
         * ACCESSOR's error and the real database error — the thing the
         * operator needs to see — would be gone. So every hostile shape below
         * has to come back as a plain `false`, which sends the caller down its
         * `throw err` branch with the ORIGINAL error intact.
         */
        describe('hostile error shapes cannot hijack the failure', () => {
            const boom = () => { throw new Error('accessor exploded'); };

            it('does not leak a throwing enumerable getter', () => {
                const err = accountsConflict();
                Object.defineProperty(err, 'detail', { enumerable: true, get: boom });
                // Still recognised: the constraint identity lives in sibling
                // properties this walk can still read.
                expect(isUniqueViolationOn(err, ['uq_accounts_parent_name'])).toBe(true);
            });

            it('does not leak a throwing getter that hides the identity', () => {
                const err = Object.assign(new Error('x'), { code: 'P2002' });
                Object.defineProperty(err, 'meta', { enumerable: true, get: boom });
                // Nothing readable names a constraint, so this is simply "not
                // ours" — false, not a thrown accessor error.
                expect(isUniqueViolationOn(err, ['uq_accounts_parent_name'])).toBe(false);
            });

            it('does not leak a Proxy whose get trap throws', () => {
                const err = new Proxy(accountsConflict(), { get: boom });
                expect(isUniqueViolationOn(err, ['uq_accounts_parent_name'])).toBe(false);
            });

            it('does not leak a Proxy whose ownKeys trap throws', () => {
                const err = new Proxy(accountsConflict(), { ownKeys: boom });
                expect(isUniqueViolationOn(err, ['uq_accounts_parent_name'])).toBe(false);
            });

            it('does not leak a REVOKED Proxy', () => {
                const { proxy, revoke } = Proxy.revocable(accountsConflict(), {});
                revoke();
                expect(isUniqueViolationOn(proxy, ['uq_accounts_parent_name'])).toBe(false);
            });

            it('does not leak a hostile node nested inside a normal error', () => {
                // The realistic shape: Prisma's own error is fine, but one
                // branch of `meta` is a driver object with a lazy accessor.
                const hostile = new Proxy({}, { ownKeys: boom });
                const err = Object.assign(accountsConflict(), { extra: hostile });
                // The reachable half still identifies the constraint.
                expect(isUniqueViolationOn(err, ['uq_accounts_parent_name'])).toBe(true);
            });

            it('propagates the ORIGINAL database error through the adopt path', async () => {
                // End to end: `getOrCreateChildAccount` catches a create
                // failure, asks this predicate about it, and must rethrow what
                // the DATABASE said — not what the inspection tripped over.
                // A real unique violation (23505) whose constraint identity is
                // behind a getter that throws: unidentifiable, so not adoptable.
                const original = Object.assign(new Error('duplicate key value'), { code: '23505' });
                Object.defineProperty(original, 'constraint', { enumerable: true, get: boom });

                const queryRaw = vi.fn(async () => []);
                Object.assign(mocks.prisma, {
                    accounts: { create: vi.fn(async () => { throw original; }) },
                    commodities: { findFirst: vi.fn(async () => ({ guid: COMMODITY, fraction: 10000 })) },
                    $queryRaw: queryRaw,
                    $transaction: transaction({
                        accounts: { create: vi.fn(async () => { throw original; }) },
                        commodities: { findFirst: vi.fn(async () => ({ guid: COMMODITY, fraction: 10000 })) },
                        $queryRaw: queryRaw,
                    }),
                });

                const thrown = await getOrCreateChildAccount(
                    PARENT, 'AAPL', 'Apple', BOOK, new Set([PARENT]),
                ).then(() => null, (e: unknown) => e);

                expect(thrown).toBe(original);
            });
        });
    });
});
