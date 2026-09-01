/**
 * Unit tests for the read-only verify pass in beez-sync.service.
 *
 * This is the surface a beez-trackz install uses to prove a restored set of id
 * mappings before it turns sync back on, so the properties worth pinning are
 * the ones a wrong answer would corrupt a ledger with:
 *
 *  - the THREE states are genuinely distinguished. `no-link` and `orphan-link`
 *    look alike from a distance and call for opposite repairs — re-POST versus
 *    acknowledge-with-DELETE — so collapsing them would send a client to
 *    recreate a transaction whose stale link is still in the way.
 *  - the two "you cannot fix this remotely" flags are computed with the
 *    codebase's own rules ('y' AND 'f'; post_date <= lock_date), not a local
 *    re-spelling of them.
 *  - REQUEST ORDER is preserved exactly, repeats included, because the contract
 *    invites the caller to zip the two arrays by index.
 *  - the pass is a FIXED number of queries. A regression to per-id lookups
 *    would still be correct and would still pass every assertion above, so it
 *    is asserted directly.
 *  - NOTHING IS WRITTEN. Asserted by the absence of any write on the mock,
 *    which is the only way "read-only" can be checked rather than believed.
 *
 * Prisma is mocked: every query here is a plain tagged-template read, and the
 * SQL itself is exercised against a real server by
 * src/lib/services/__tests__/beez-sync.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOOK = 'b'.repeat(32);
const ROOT = 'r'.repeat(32);
const COMMODITY = 'c'.repeat(32);
const CHECKING = '1'.repeat(32);
const EXPENSE = '2'.repeat(32);

const TX_LINKED = 'a'.repeat(32);
const TX_MISSING = 'd'.repeat(32);

interface LinkFixture { external_id: string; entity_guid: string }
interface TxFixture {
    guid: string;
    post_date: Date | null;
    num: string | null;
    description: string | null;
    enter_date: string | null;
}
interface SplitFixture {
    tx_guid: string;
    account_guid: string;
    memo: string | null;
    reconcile_state: string;
    value_num: bigint;
    value_denom: bigint;
}

const mocks = vi.hoisted(() => ({
    queryRaw: vi.fn(),
    executeRaw: vi.fn(),
    getCachedLockDate: vi.fn(),
}));

/**
 * Every write entry point the service could reach, present and spied. A test
 * cannot prove "this endpoint writes nothing" by listing the writes it happens
 * to know about; it proves it by giving the mock every write it has and
 * asserting none was called.
 */
const writeSpies = vi.hoisted(() => ({
    transactionsUpdate: vi.fn(),
    transactionsDelete: vi.fn(),
    splitsCreateMany: vi.fn(),
    splitsDeleteMany: vi.fn(),
    slotsDeleteMany: vi.fn(),
    linksCreate: vi.fn(),
    linksUpdate: vi.fn(),
    linksDeleteMany: vi.fn(),
    metaUpsert: vi.fn(),
    auditCreate: vi.fn(),
    transaction: vi.fn(),
    executeRaw: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (...args: unknown[]) => mocks.queryRaw(...args),
        $executeRaw: (...args: unknown[]) => writeSpies.executeRaw(...args),
        $transaction: (...args: unknown[]) => writeSpies.transaction(...args),
        transactions: { update: writeSpies.transactionsUpdate, delete: writeSpies.transactionsDelete },
        splits: { createMany: writeSpies.splitsCreateMany, deleteMany: writeSpies.splitsDeleteMany },
        slots: { deleteMany: writeSpies.slotsDeleteMany },
        gnucash_web_external_links: {
            create: writeSpies.linksCreate,
            update: writeSpies.linksUpdate,
            deleteMany: writeSpies.linksDeleteMany,
        },
        gnucash_web_transaction_meta: { upsert: writeSpies.metaUpsert },
        gnucash_web_audit: { create: writeSpies.auditCreate },
    },
}));

// The lock-date READER is mocked; the pure boundary rule (`findLockedDate`) is
// deliberately NOT, because `inClosedPeriod` is exactly that rule and stubbing
// it would make the closed-period test assert its own stub.
vi.mock('@/lib/services/period-lock.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/services/period-lock.service')>()),
    getCachedLockDate: mocks.getCachedLockDate,
}));

const { getBeezTransactionByExternalId, verifyBeezExternalIds, BeezSyncError } =
    await import('../beez-sync.service');

const CONTEXT = {
    bookGuid: BOOK,
    bookName: 'Apiary',
    rootAccountGuid: ROOT,
    rootCommodityGuid: COMMODITY,
    rootCurrency: 'USD',
};

/** A balanced pair of cent-denominated splits on one transaction. */
function splitPair(txGuid: string, cents: number, reconcileState = 'n'): SplitFixture[] {
    return [
        {
            tx_guid: txGuid, account_guid: EXPENSE, memo: 'supplies',
            reconcile_state: reconcileState, value_num: BigInt(cents), value_denom: 100n,
        },
        {
            tx_guid: txGuid, account_guid: CHECKING, memo: '',
            reconcile_state: 'n', value_num: BigInt(-cents), value_denom: 100n,
        },
    ];
}

function transaction(overrides: Partial<TxFixture> = {}): TxFixture {
    return {
        guid: TX_LINKED,
        post_date: new Date('2026-08-25T12:00:00Z'),
        num: 'BZ-1',
        description: 'Frames and foundation',
        enter_date: '2026-08-25T09:14:02.123456',
        ...overrides,
    };
}

interface Fixture {
    links?: LinkFixture[];
    transactions?: TxFixture[];
    splits?: SplitFixture[];
    lockDate?: string | null;
}

/** Every SQL statement the service issued, in order, with its bound values. */
const issued: Array<{ sql: string; values: unknown[] }> = [];

function install(fixture: Fixture): void {
    const links = fixture.links ?? [];
    const txRows = fixture.transactions ?? [];
    const splits = fixture.splits ?? [];

    mocks.getCachedLockDate.mockResolvedValue(fixture.lockDate ?? null);
    mocks.queryRaw.mockImplementation(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join('?');
            issued.push({ sql, values });

            if (sql.includes('gnucash_web_external_links')) {
                const wanted = new Set(values[2] as string[]);
                return Promise.resolve(links.filter(link => wanted.has(link.external_id)));
            }
            if (sql.includes('FROM transactions')) {
                // Honours the guid predicate rather than returning everything:
                // a canned answer would let an orphan link resolve to some
                // other run's transaction and the orphan test would pass for
                // the wrong reason.
                const wanted = new Set(values[1] as string[]);
                return Promise.resolve(txRows.filter(row => wanted.has(row.guid)));
            }
            if (sql.includes('FROM splits')) {
                const wanted = new Set(values[0] as string[]);
                return Promise.resolve(splits.filter(split => wanted.has(split.tx_guid)));
            }
            throw new Error(`unexpected query: ${sql}`);
        },
    );
}

/** Statements issued that read one of the three tables the pass touches. */
function readsOf(table: string): number {
    return issued.filter(entry => entry.sql.includes(table)).length;
}

function assertNothingWasWritten(): void {
    for (const [name, spy] of Object.entries(writeSpies)) {
        expect(spy, `${name} must never be called by a read-only verify`).not.toHaveBeenCalled();
    }
}

beforeEach(() => {
    issued.length = 0;
    for (const spy of Object.values(writeSpies)) spy.mockReset();
    mocks.queryRaw.mockReset();
    mocks.getCachedLockDate.mockReset();
});

describe('verifyBeezExternalIds — states', () => {
    it('returns the whole transaction for a linked id', async () => {
        install({
            links: [{ external_id: 'beez-1', entity_guid: TX_LINKED }],
            transactions: [transaction()],
            splits: splitPair(TX_LINKED, 1250),
        });

        const [result] = await verifyBeezExternalIds(CONTEXT, ['beez-1']);

        expect(result).toEqual({
            externalId: 'beez-1',
            state: 'linked',
            transactionGuid: TX_LINKED,
            // The database's own microsecond rendering plus the UTC marker —
            // byte-identical to what the change feed reports for the same row,
            // which is what lets a client compare the two without normalizing.
            enterDate: '2026-08-25T09:14:02.123456Z',
            postDate: '2026-08-25',
            description: 'Frames and foundation',
            num: 'BZ-1',
            reconciledOrFrozen: false,
            inClosedPeriod: false,
            splits: [
                { accountGuid: EXPENSE, amountCents: 1250, memo: 'supplies' },
                { accountGuid: CHECKING, amountCents: -1250, memo: '' },
            ],
        });
        assertNothingWasWritten();
    });

    it('reports an id this book has never linked as no-link, not as an error', async () => {
        install({ links: [] });

        expect(await verifyBeezExternalIds(CONTEXT, ['beez-unknown'])).toEqual([
            { externalId: 'beez-unknown', state: 'no-link' },
        ]);
        assertNothingWasWritten();
    });

    it('distinguishes an orphan link from no link, and names the missing guid', async () => {
        install({
            links: [{ external_id: 'beez-gone', entity_guid: TX_MISSING }],
            transactions: [],
        });

        // The repair for this is DELETE (acknowledge the tombstone), and the
        // repair for `no-link` is POST. Answering 404 here — or `no-link` —
        // would send a client to re-create a transaction whose stale link is
        // still holding the unique index.
        expect(await verifyBeezExternalIds(CONTEXT, ['beez-gone'])).toEqual([
            { externalId: 'beez-gone', state: 'orphan-link', transactionGuid: TX_MISSING },
        ]);
        assertNothingWasWritten();
    });
});

describe('verifyBeezExternalIds — uncorrectable-divergence flags', () => {
    it.each([['y', 'reconciled'], ['f', 'frozen']])(
        'flags a %s (%s) split, because PUT and DELETE would refuse it',
        async (state) => {
            install({
                links: [{ external_id: 'beez-1', entity_guid: TX_LINKED }],
                transactions: [transaction()],
                splits: splitPair(TX_LINKED, 500, state),
            });

            const [result] = await verifyBeezExternalIds(CONTEXT, ['beez-1']);
            expect(result.reconciledOrFrozen).toBe(true);
        },
    );

    it('does not flag a cleared or pending split', async () => {
        for (const state of ['n', 'c']) {
            install({
                links: [{ external_id: 'beez-1', entity_guid: TX_LINKED }],
                transactions: [transaction()],
                splits: splitPair(TX_LINKED, 500, state),
            });
            const [result] = await verifyBeezExternalIds(CONTEXT, ['beez-1']);
            expect(result.reconciledOrFrozen, state).toBe(false);
        }
    });

    it('flags a post date on or before the lock date, and nothing after it', async () => {
        for (const [postDate, expected] of [
            ['2026-06-29', true],
            // Inclusive: the lock date itself is inside the closed period, the
            // same boundary `findLockedDate` enforces for every writer.
            ['2026-06-30', true],
            ['2026-07-01', false],
        ] as const) {
            install({
                links: [{ external_id: 'beez-1', entity_guid: TX_LINKED }],
                transactions: [transaction({ post_date: new Date(`${postDate}T12:00:00Z`) })],
                splits: splitPair(TX_LINKED, 500),
                lockDate: '2026-06-30',
            });

            const [result] = await verifyBeezExternalIds(CONTEXT, ['beez-1']);
            expect(result.inClosedPeriod, postDate).toBe(expected);
        }
    });

    it('reads the book lock date once for the whole batch', async () => {
        install({
            links: [
                { external_id: 'beez-1', entity_guid: TX_LINKED },
                { external_id: 'beez-2', entity_guid: TX_MISSING },
            ],
            transactions: [transaction(), transaction({ guid: TX_MISSING })],
            splits: [...splitPair(TX_LINKED, 100), ...splitPair(TX_MISSING, 200)],
            lockDate: '2026-06-30',
        });

        await verifyBeezExternalIds(CONTEXT, ['beez-1', 'beez-2']);
        expect(mocks.getCachedLockDate).toHaveBeenCalledTimes(1);
    });
});

describe('verifyBeezExternalIds — amounts that cannot be stated in cents', () => {
    it('reports the transaction as unrepresentable with no splits, never rounded', async () => {
        install({
            links: [{ external_id: 'beez-1', entity_guid: TX_LINKED }],
            transactions: [transaction()],
            splits: [
                {
                    tx_guid: TX_LINKED, account_guid: EXPENSE, memo: '',
                    reconcile_state: 'n', value_num: 1n, value_denom: 3n,
                },
                {
                    tx_guid: TX_LINKED, account_guid: CHECKING, memo: '',
                    reconcile_state: 'n', value_num: -1n, value_denom: 3n,
                },
            ],
        });

        const [result] = await verifyBeezExternalIds(CONTEXT, ['beez-1']);

        // All-or-nothing. A partial split set would balance on neither side,
        // and a rounded one would manufacture a divergence — or hide one.
        expect(result.state).toBe('linked');
        expect(result.unrepresentable).toBe(true);
        expect(result.splits).toEqual([]);
    });
});

describe('verifyBeezExternalIds — batch shape', () => {
    it('preserves request order exactly, including repeats and misses', async () => {
        install({
            links: [
                { external_id: 'beez-1', entity_guid: TX_LINKED },
                { external_id: 'beez-gone', entity_guid: TX_MISSING },
            ],
            transactions: [transaction()],
            splits: splitPair(TX_LINKED, 100),
        });

        // Deliberately not sorted, and deliberately with a repeat: the contract
        // invites the caller to zip its own list against the results by index,
        // so a set-shaped or dedup-shaped answer would silently misalign it.
        const requested = ['beez-gone', 'beez-missing', 'beez-1', 'beez-gone', 'beez-1'];
        const results = await verifyBeezExternalIds(CONTEXT, requested);

        expect(results.map(item => item.externalId)).toEqual(requested);
        expect(results.map(item => item.state)).toEqual([
            'orphan-link', 'no-link', 'linked', 'orphan-link', 'linked',
        ]);
    });

    it('resolves the whole batch in a fixed number of queries', async () => {
        const links = Array.from({ length: 50 }, (_, i) => ({
            external_id: `beez-${i}`,
            entity_guid: `${i}`.padStart(32, '0'),
        }));
        install({
            links,
            transactions: links.map(link => transaction({ guid: link.entity_guid })),
            splits: links.flatMap(link => splitPair(link.entity_guid, 100)),
        });

        const results = await verifyBeezExternalIds(
            CONTEXT, links.map(link => link.external_id),
        );

        expect(results).toHaveLength(50);
        // One statement per TABLE, not one per id. A per-id loop would return
        // exactly the same answers, so the round-trip count is the only thing
        // that can catch the regression.
        expect(readsOf('gnucash_web_external_links')).toBe(1);
        expect(readsOf('FROM transactions')).toBe(1);
        expect(readsOf('FROM splits')).toBe(1);
        expect(mocks.queryRaw).toHaveBeenCalledTimes(3);
        assertNothingWasWritten();
    });

    it('asks the database for each distinct id once', async () => {
        install({ links: [{ external_id: 'beez-1', entity_guid: TX_LINKED }], transactions: [transaction()] });

        await verifyBeezExternalIds(CONTEXT, ['beez-1', 'beez-1', 'beez-2', 'beez-1']);

        const linkQuery = issued.find(entry => entry.sql.includes('gnucash_web_external_links'));
        expect(linkQuery?.values[2]).toEqual(['beez-1', 'beez-2']);
    });

    it('scopes the link lookup to the token book and this integration', async () => {
        install({ links: [] });

        await verifyBeezExternalIds(CONTEXT, ['beez-1']);

        const linkQuery = issued.find(entry => entry.sql.includes('gnucash_web_external_links'));
        expect(linkQuery?.values[0]).toBe(BOOK);
        expect(linkQuery?.values[1]).toBe('beez-trackz');
        expect(linkQuery?.sql).toContain("entity_type = 'transaction'");
    });

    it('touches no transaction or split table when nothing is linked', async () => {
        install({ links: [] });

        await verifyBeezExternalIds(CONTEXT, ['beez-a', 'beez-b']);

        expect(readsOf('FROM transactions')).toBe(0);
        expect(readsOf('FROM splits')).toBe(0);
    });

    it('answers an empty request without querying at all', async () => {
        install({ links: [] });

        expect(await verifyBeezExternalIds(CONTEXT, [])).toEqual([]);
        expect(mocks.queryRaw).not.toHaveBeenCalled();
    });
});

describe('getBeezTransactionByExternalId', () => {
    it('returns the same item the batch would', async () => {
        install({
            links: [{ external_id: 'beez-1', entity_guid: TX_LINKED }],
            transactions: [transaction()],
            splits: splitPair(TX_LINKED, 1250, 'y'),
            lockDate: '2026-12-31',
        });

        const item = await getBeezTransactionByExternalId(CONTEXT, 'beez-1');
        expect(item.state).toBe('linked');
        expect(item.reconciledOrFrozen).toBe(true);
        expect(item.inClosedPeriod).toBe(true);
        assertNothingWasWritten();
    });

    it('answers an orphan link with the marker rather than a 404', async () => {
        install({ links: [{ external_id: 'beez-gone', entity_guid: TX_MISSING }], transactions: [] });

        const item = await getBeezTransactionByExternalId(CONTEXT, 'beez-gone');
        expect(item.state).toBe('orphan-link');
        expect(item.transactionGuid).toBe(TX_MISSING);
    });

    it('raises a 404 unknown_external_id when there is no link', async () => {
        install({ links: [] });

        await expect(getBeezTransactionByExternalId(CONTEXT, 'beez-nope'))
            .rejects.toMatchObject({ status: 404, code: 'unknown_external_id' });
        await expect(getBeezTransactionByExternalId(CONTEXT, 'beez-nope'))
            .rejects.toBeInstanceOf(BeezSyncError);
        assertNothingWasWritten();
    });
});
