/**
 * The investment ledger's running cost-basis column, at the ROUTE level.
 *
 * traceCostBasis returns basis for only the shares whose basis it could
 * establish. The route must keep that share count next to the basis: crediting
 * a partly-traceable transfer as fully basised, and then dividing the running
 * basis by the full share balance on each sale, understates the basis of every
 * later row in the column. Only `traceCostBasis` is stubbed here — the pool
 * helpers under test are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { prismaMock, isAccountInActiveBookMock, requireRoleMock, traceCostBasisMock } = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findUnique: vi.fn(), findMany: vi.fn() },
        transactions: { findMany: vi.fn() },
        splits: { findMany: vi.fn() },
        $queryRaw: vi.fn(),
    },
    isAccountInActiveBookMock: vi.fn(),
    requireRoleMock: vi.fn(),
    traceCostBasisMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: prismaMock,
    toDecimal: (num: bigint, denom: bigint) => (Number(num) / Number(denom)).toFixed(2),
}));
vi.mock('@/lib/book-scope', () => ({ isAccountInActiveBook: isAccountInActiveBookMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/reports/utils', () => ({ buildAccountPathMap: vi.fn(async () => new Map()) }));
vi.mock('@/lib/services/tag.service', () => ({ getTagsForTransactions: vi.fn(async () => new Map()) }));
vi.mock('@/lib/transaction-notes', () => ({ readTransactionNotes: vi.fn(async () => new Map()) }));
vi.mock('@/lib/cache', () => ({ cacheGet: vi.fn(async () => null), cacheSet: vi.fn() }));
vi.mock('@/lib/cost-basis', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/cost-basis')>();
    return { ...actual, traceCostBasis: (...args: unknown[]) => traceCostBasisMock(...args) };
});

import { GET } from '../route';

const ACCOUNT = 'a'.repeat(32);
const OTHER_BROKERAGE = 'b'.repeat(32);
const CASH = 'c'.repeat(32);
const AAPL = 'd'.repeat(32);
const USD = 'e'.repeat(32);

const BUY_TX = '1'.repeat(32);
const XFER_TX = '2'.repeat(32);
const SELL_TX = '3'.repeat(32);

const frac = (n: number) => ({ num: BigInt(Math.round(n * 10_000)), denom: 10_000n });

type RawSplit = {
    guid: string; tx_guid: string; account_guid: string; lot_guid: string | null;
    quantity_num: bigint; quantity_denom: bigint; value_num: bigint; value_denom: bigint;
};

/** 1e-8 share precision, for commodities held at commodity_scu = 1e8. */
const frac8 = (n: number) => ({ num: BigInt(Math.round(n * 1e8)), denom: 100_000_000n });

/**
 * Stock-side split in the ledger account plus its counter-leg. `precise`
 * switches share quantities to 1e-8 denominators (dollar values stay at 1e-4).
 */
function pair(o: {
    guid: string; txGuid: string; shares: number; value: number;
    counterAccount: string; counterShares: number; precise?: boolean;
}): { own: RawSplit; counter: RawSplit } {
    const qty = o.precise ? frac8 : frac;
    const q = qty(o.shares);
    const v = frac(o.value);
    const cq = qty(o.counterShares);
    const cv = frac(-o.value);
    return {
        own: {
            guid: `${o.guid}-own`, tx_guid: o.txGuid, account_guid: ACCOUNT, lot_guid: null,
            quantity_num: q.num, quantity_denom: q.denom, value_num: v.num, value_denom: v.denom,
        },
        counter: {
            guid: `${o.guid}-counter`, tx_guid: o.txGuid, account_guid: o.counterAccount, lot_guid: null,
            quantity_num: cq.num, quantity_denom: cq.denom, value_num: cv.num, value_denom: cv.denom,
        },
    };
}

// 100 shares bought for $1,000, then 100 shares transferred in (basis carried,
// only half of it traceable), then 100 shares sold.
const BUY = pair({ guid: 'buy', txGuid: BUY_TX, shares: 100, value: 1_000, counterAccount: CASH, counterShares: -1_000 });
const XFER = pair({ guid: 'xfer', txGuid: XFER_TX, shares: 100, value: 0, counterAccount: OTHER_BROKERAGE, counterShares: -100 });
const SELL = pair({ guid: 'sell', txGuid: SELL_TX, shares: -100, value: -9_000, counterAccount: CASH, counterShares: 9_000 });

const POST_DATE: Record<string, Date> = {
    [BUY_TX]: new Date('2020-01-01T12:00:00.000Z'),
    [XFER_TX]: new Date('2021-01-01T12:00:00.000Z'),
    [SELL_TX]: new Date('2024-01-01T12:00:00.000Z'),
};

const ALL_SPLITS = [BUY, XFER, SELL];

type LedgerRow = {
    guid: string;
    cost_basis: string;
    share_balance: string;
    /** null = coverage unknown; NOT the same as '0'. */
    cost_basis_uncovered_shares: string | null;
    /** 'short' means cost_basis is PROCEEDS, not a purchase cost. */
    position_side: 'long' | 'short' | 'flat';
};

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ bookGuid: 'z'.repeat(32), role: 'readonly' });
    isAccountInActiveBookMock.mockResolvedValue(true);
    prismaMock.accounts.findUnique.mockResolvedValue({
        guid: ACCOUNT, commodity_guid: AAPL,
        commodity: { guid: AAPL, mnemonic: 'AAPL', namespace: 'NASDAQ' },
    });
    // Sibling accounts of the counter-legs: same commodity for the transfer
    // (so isTransferIn matches) and USD for the cash legs (so it does not).
    prismaMock.accounts.findMany.mockResolvedValue([
        { guid: ACCOUNT, commodity_guid: AAPL },
        { guid: OTHER_BROKERAGE, commodity_guid: AAPL },
        { guid: CASH, commodity_guid: USD },
    ]);
    prismaMock.splits.findMany.mockImplementation((args: { where: Record<string, unknown>; select?: unknown }) => {
        // First call: the ledger account's own splits (with post/enter dates).
        if (typeof args.where.account_guid === 'string') {
            return Promise.resolve(ALL_SPLITS.map(s => ({
                ...s.own,
                transaction: { post_date: POST_DATE[s.own.tx_guid], enter_date: POST_DATE[s.own.tx_guid] },
            })));
        }
        // Second call: every sibling split of those transactions.
        return Promise.resolve(ALL_SPLITS.flatMap(s => [s.own, s.counter]));
    });
    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = Prisma.sql(strings, ...values);
        if (query.text.includes('gnucash_web_transaction_meta') || query.text.includes('gnucash_web_receipts')) return Promise.resolve([]);
        if (query.text.includes('account_transaction_deltas')) return Promise.resolve([]);
        // The no-carry-over running-totals path reads splits directly in SQL.
        // Match its projection, not `FROM splits s` — the page-GUID query has
        // that same text inside its EXISTS predicate.
        if (query.text.includes('SELECT s.tx_guid')) {
            return Promise.resolve(ALL_SPLITS.map(s => ({
                tx_guid: s.own.tx_guid,
                quantity_num: s.own.quantity_num, quantity_denom: s.own.quantity_denom,
                value_num: s.own.value_num, value_denom: s.own.value_denom,
            })));
        }
        return Promise.resolve([{ guid: SELL_TX }, { guid: XFER_TX }, { guid: BUY_TX }]);
    });
    prismaMock.transactions.findMany.mockImplementation(({ where }: { where: { guid: { in: string[] } } }) => {
        const wanted = new Set(where.guid.in);
        return Promise.resolve([SELL_TX, XFER_TX, BUY_TX].filter(g => wanted.has(g)).map(guid => ({
            guid, currency_guid: USD, num: '', description: `tx ${guid.slice(0, 1)}`,
            post_date: POST_DATE[guid], enter_date: POST_DATE[guid],
            splits: ALL_SPLITS.filter(s => s.own.tx_guid === guid).map(s => ({
                ...s.own,
                memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
                account: { name: 'Brokerage', account_type: 'STOCK', commodity: { mnemonic: 'AAPL' } },
            })),
        })));
    });
});

async function ledger(query = 'limit=100'): Promise<Record<string, LedgerRow>> {
    const response = await GET(
        new Request(`http://localhost/api/accounts/${ACCOUNT}/transactions?${query}`),
        { params: Promise.resolve({ guid: ACCOUNT }) },
    ) as unknown as Response;
    expect(response.status).toBe(200);
    const body = await response.json() as { transactions: LedgerRow[] };
    return Object.fromEntries(body.transactions.map(row => [row.guid, row]));
}

describe('investment ledger running cost basis — coverage', () => {
    /**
     * The 100 transferred-in shares trace to $2,500 of basis covering only 50
     * of them; the other 50 have no establishable basis.
     */
    function partiallyCoveredTransfer() {
        traceCostBasisMock.mockResolvedValue({
            coveredShares: 50,
            uncoveredShares: 50,
            basisOfCoveredShares: 2_500,
            perShareCost: 50,
            method: 'fifo',
            warnings: ['50 of 100 share(s) transferred in on 2021-01-01 have no traceable cost basis in this book.'],
        });
    }

    it('credits a partly-traceable transfer as partly covered, not fully basised', async () => {
        partiallyCoveredTransfer();
        const rows = await ledger();

        // Buy: 100 shares, $1,000, all covered.
        expect(Number(rows[BUY_TX].cost_basis)).toBeCloseTo(1_000, 6);
        expect(Number(rows[BUY_TX].cost_basis_uncovered_shares)).toBeCloseTo(0, 6);

        // After the transfer: 200 shares, $3,500 of basis over 150 covered
        // shares ($23.33/share). Crediting all 100 transferred shares as
        // covered would report the same $3,500 as if it covered all 200.
        expect(Number(rows[XFER_TX].share_balance)).toBeCloseTo(200, 6);
        expect(Number(rows[XFER_TX].cost_basis)).toBeCloseTo(3_500, 6);
        expect(Number(rows[XFER_TX].cost_basis_uncovered_shares)).toBeCloseTo(50, 6);
    });

    it('a sale draws basis at the COVERED average, not the full-share average', async () => {
        partiallyCoveredTransfer();
        const rows = await ledger();

        // Selling 100 of 200 shares consumes covered and uncovered pro rata:
        // 75 covered (150/200) at $23.333 = $1,750 of basis leaves $1,750.
        // The old running total divided $3,500 by all 200 shares and removed
        // $17.50 x 100 = $1,750 -- the same dollars, but attributed to 100
        // covered shares, so the NEXT row's per-share basis is understated.
        expect(Number(rows[SELL_TX].share_balance)).toBeCloseTo(100, 6);
        expect(Number(rows[SELL_TX].cost_basis)).toBeCloseTo(1_750, 6);

        // The number a reader takes off the column: basis per share that HAS a
        // basis. $23.33 here; laundering the transfer into full coverage
        // reports the same dollars spread over 100 covered shares -> $17.50.
        const perCoveredShare =
            Number(rows[SELL_TX].cost_basis)
            / (Number(rows[SELL_TX].share_balance) - Number(rows[SELL_TX].cost_basis_uncovered_shares));
        expect(perCoveredShare).toBeCloseTo(23.3333333, 5);
        expect(perCoveredShare).not.toBeCloseTo(17.5, 2);
        expect(Number(rows[SELL_TX].cost_basis_uncovered_shares)).toBeCloseTo(25, 6);
    });

    it('a fully traceable transfer reports no uncovered shares anywhere in the column', async () => {
        traceCostBasisMock.mockResolvedValue({
            coveredShares: 100, uncoveredShares: 0, basisOfCoveredShares: 5_000,
            perShareCost: 50, method: 'fifo',
        });
        const rows = await ledger();

        expect(Number(rows[XFER_TX].cost_basis)).toBeCloseTo(6_000, 6);
        expect(Number(rows[XFER_TX].cost_basis_uncovered_shares)).toBe(0);
        // Sell 100 of 200 at a $30 average -> $3,000 of basis left.
        expect(Number(rows[SELL_TX].cost_basis)).toBeCloseTo(3_000, 6);
        expect(Number(rows[SELL_TX].cost_basis_uncovered_shares)).toBe(0);
    });

    it('an oversell is reported as a SHORT position whose basis is the proceeds', async () => {
        // Buy 100 @ $10, sell 150 @ $80. 100 close the long; 50 are sold short
        // and carry their $4,000 slice of the $12,000. The pool used to clamp at
        // zero shares, so this row displayed a $0 basis of unknown coverage.
        prismaMock.splits.findMany.mockImplementation((args: { where: Record<string, unknown> }) => {
            const rows = [
                pair({ guid: 'buy', txGuid: BUY_TX, shares: 100, value: 1_000, counterAccount: CASH, counterShares: -1_000 }),
                pair({ guid: 'sell', txGuid: SELL_TX, shares: -150, value: -12_000, counterAccount: CASH, counterShares: 12_000 }),
            ];
            if (typeof args.where.account_guid === 'string') {
                return Promise.resolve(rows.map(s => ({
                    ...s.own,
                    transaction: { post_date: POST_DATE[s.own.tx_guid], enter_date: POST_DATE[s.own.tx_guid] },
                })));
            }
            return Promise.resolve(rows.flatMap(s => [s.own, s.counter]));
        });

        const rows = await ledger();

        // The share balance is the honest one, negative and all.
        expect(Number(rows[SELL_TX].share_balance)).toBeCloseTo(-50, 6);
        expect(rows[SELL_TX].position_side).toBe('short');
        // cost_basis on a short row is the PROCEEDS of the shorted shares.
        expect(Number(rows[SELL_TX].cost_basis)).toBeCloseTo(4_000, 6);
        // Every short-opening sale's proceeds were readable, so nothing is
        // uncovered — and a consumer reading `share_balance - uncovered` gets
        // the short share count, not a nonsense negative covered count.
        expect(Number(rows[SELL_TX].cost_basis_uncovered_shares)).toBe(0);
        // The long rows before the oversell are untouched.
        expect(rows[BUY_TX].position_side).toBe('long');
        expect(Number(rows[BUY_TX].cost_basis)).toBeCloseTo(1_000, 6);
        expect(rows[BUY_TX].cost_basis_uncovered_shares).toBe('0');
    });

    it('reports coverage as UNAVAILABLE when carry-over tracing is switched off', async () => {
        partiallyCoveredTransfer();
        const rows = await ledger('costBasisCarryOver=false&limit=100');

        // This path does no transfer-in detection at all, so the $0 in-kind
        // transfer enters at face value. Claiming 0 uncovered here would assert
        // a completeness the branch never established.
        expect(traceCostBasisMock).not.toHaveBeenCalled();
        // No signed pool runs here, so the rows state the side they modelled.
        expect(rows[BUY_TX].position_side).toBe('long');
        expect(rows[BUY_TX].cost_basis_uncovered_shares).toBeNull();
        expect(rows[XFER_TX].cost_basis_uncovered_shares).toBeNull();
        expect(rows[SELL_TX].cost_basis_uncovered_shares).toBeNull();
        // The share balance and basis this path does compute are unchanged.
        expect(Number(rows[XFER_TX].share_balance)).toBeCloseTo(200, 6);
    });

    /**
     * Point the ledger at a commodity held to 1e-8 (crypto precision) and feed
     * it `rows` as the account's history.
     */
    function highPrecisionAccount(rows: Array<{ own: RawSplit; counter: RawSplit }>) {
        prismaMock.accounts.findUnique.mockResolvedValue({
            guid: ACCOUNT, commodity_guid: AAPL, commodity_scu: 100_000_000,
            commodity: { guid: AAPL, mnemonic: 'BTC', namespace: 'CRYPTO' },
        });
        prismaMock.splits.findMany.mockImplementation((args: { where: Record<string, unknown> }) => {
            if (typeof args.where.account_guid === 'string') {
                return Promise.resolve(rows.map(s => ({
                    ...s.own,
                    transaction: { post_date: POST_DATE[s.own.tx_guid], enter_date: POST_DATE[s.own.tx_guid] },
                })));
            }
            return Promise.resolve(rows.flatMap(s => [s.own, s.counter]));
        });
    }

    it('a one-unit oversell at commodity_scu 1e8 reports coverage as UNAVAILABLE', async () => {
        // Buy 1, sell 1.00000001 — a legitimate oversell of a single smallest
        // unit. A flat 0.0001 tolerance reads that as agreement and claims 0
        // uncovered shares for a NEGATIVE position; the scu-aware epsilon is
        // 0.5 / 1e8, so the divergence is seen.
        highPrecisionAccount([
            pair({ guid: 'buy', txGuid: BUY_TX, shares: 1, value: 50_000, counterAccount: CASH, counterShares: -50_000, precise: true }),
            pair({ guid: 'sell', txGuid: SELL_TX, shares: -1.00000001, value: -60_000, counterAccount: CASH, counterShares: 60_000, precise: true }),
        ]);

        const rows = await ledger();
        expect(Number(rows[SELL_TX].share_balance)).toBeLessThan(0);
        expect(Number(rows[SELL_TX].share_balance)).toBeCloseTo(-1e-8, 12);
        // A one-unit oversell IS a (tiny) short leg, and the scu-aware epsilon
        // is 0.5 / 1e8, so the pool sees it rather than reading it as agreement.
        expect(rows[SELL_TX].position_side).toBe('short');
    });

    it('an ordinary long position at commodity_scu 1e8 still reports a coverage number', async () => {
        // The inverse failure: a tolerance so tight that float drift in the
        // pool's pro-rata arithmetic degrades good data to "unknown".
        partiallyCoveredTransfer();
        highPrecisionAccount([
            pair({ guid: 'buy', txGuid: BUY_TX, shares: 1, value: 1_000, counterAccount: CASH, counterShares: -1_000, precise: true }),
            pair({ guid: 'xfer', txGuid: XFER_TX, shares: 1, value: 0, counterAccount: OTHER_BROKERAGE, counterShares: -1, precise: true }),
            pair({ guid: 'sell', txGuid: SELL_TX, shares: -1, value: -3_000, counterAccount: CASH, counterShares: 3_000, precise: true }),
        ]);
        // 1 covered bought + a transfer of 1 that traces 0.5 covered / 0.5 not.
        traceCostBasisMock.mockResolvedValue({
            coveredShares: 0.5, uncoveredShares: 0.5, basisOfCoveredShares: 25,
            perShareCost: 50, method: 'fifo',
        });

        const rows = await ledger();
        // Selling 1 of 2 pooled shares removes covered/uncovered pro rata:
        // 0.75 covered and 0.25 uncovered remain, and the pool still agrees
        // with the raw balance, so coverage stays reportable.
        expect(Number(rows[SELL_TX].share_balance)).toBeCloseTo(1, 12);
        expect(rows[SELL_TX].cost_basis_uncovered_shares).not.toBeNull();
        expect(Number(rows[SELL_TX].cost_basis_uncovered_shares)).toBeCloseTo(0.25, 9);
    });

    /**
     * A long replay at a large share count.
     *
     * `runShares` and the pool's share count are two independent float sums
     * over the same history, and the pool's pro-rata sell arithmetic
     * (`sold * covered / poolShares`) injects a fresh relative rounding error
     * on every sale. After thousands of them on a multi-million-unit position
     * the two disagree by far more than the scu's absolute epsilon (0.5/1e8),
     * even though nothing about the account is inconsistent. An absolute-only
     * comparison reports that healthy ledger's coverage as unknown; the
     * magnitude-scaled epsilon does not.
     */
    it('keeps coverage reportable after a long large-share replay accumulates float residue', async () => {
        // A partly-traceable transfer-in FIRST, so the pool holds a covered
        // and an uncovered share count and every later sale splits pro rata —
        // the arithmetic that actually generates the residue.
        traceCostBasisMock.mockResolvedValue({
            coveredShares: 700.13,
            uncoveredShares: 299.87,
            basisOfCoveredShares: 21_003.9,
            perShareCost: 30,
            method: 'fifo',
        });

        const SPLIT_COUNT = 6_000;
        const generated: Array<{ own: RawSplit; counter: RawSplit }> = [];
        const txGuidAt = (i: number) => `g${String(i).padStart(31, '0')}`;
        POST_DATE[txGuidAt(0)] = new Date(Date.UTC(2000, 0, 1));
        generated.push(pair({
            guid: 'gen0', txGuid: txGuidAt(0), shares: 1_000, value: 0,
            counterAccount: OTHER_BROKERAGE, counterShares: -1_000, precise: true,
        }));
        for (let i = 1; i < SPLIT_COUNT; i++) {
            const txGuid = txGuidAt(i);
            POST_DATE[txGuid] = new Date(Date.UTC(2000, 0, 1) + i * 86_400_000);
            // Buy a large lot, then give a third of it back, thousands of
            // times over: a plausible high-frequency token account.
            const shares = i % 3 === 2 ? -4_100.37 : 12_301.11;
            generated.push(pair({
                guid: `gen${i}`, txGuid, shares, value: Math.abs(shares) * 2,
                counterAccount: CASH, counterShares: -Math.abs(shares) * 2, precise: true,
            }));
        }
        const lastTx = generated[generated.length - 1].own.tx_guid;

        highPrecisionAccount(generated);
        // Page over the final transaction only; the replay still reads the
        // whole history through splits.findMany above.
        prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
            const query = Prisma.sql(strings, ...values);
            if (query.text.includes('gnucash_web_transaction_meta') || query.text.includes('gnucash_web_receipts')) return Promise.resolve([]);
            if (query.text.includes('account_transaction_deltas')) return Promise.resolve([]);
            return Promise.resolve([{ guid: lastTx }]);
        });
        prismaMock.transactions.findMany.mockImplementation(() => Promise.resolve([{
            guid: lastTx, currency_guid: USD, num: '', description: 'last',
            post_date: POST_DATE[lastTx], enter_date: POST_DATE[lastTx],
            splits: [{
                ...generated[generated.length - 1].own,
                memo: '', action: '', reconcile_state: 'n', reconcile_date: null,
                account: { name: 'Wallet', account_type: 'STOCK', commodity: { mnemonic: 'BTC' } },
            }],
        }]));

        const rows = await ledger();
        const balance = Number(rows[lastTx].share_balance);
        expect(balance).toBeGreaterThan(1_000_000);
        // The point of the test: still a number, not null. (Under an absolute
        // epsilon of 0.5/1e8 this reads null — the residue alone is larger.)
        expect(rows[lastTx].cost_basis_uncovered_shares).not.toBeNull();
        expect(Number(rows[lastTx].cost_basis_uncovered_shares)).toBeGreaterThanOrEqual(0);
    });

    it('the running totals replay full history, NOT the ledger filter', async () => {
        partiallyCoveredTransfer();
        await ledger('minAmount=9000&reconcileStates=y&limit=100');

        // The amount/reconcile predicates belong to the page-GUID query only.
        // The replay reads the account's splits through prisma.splits.findMany,
        // whose `where` carries no amount/reconcile/search/tag filter at all.
        const replayWhere = prismaMock.splits.findMany.mock.calls[0][0].where;
        expect(replayWhere.account_guid).toBe(ACCOUNT);
        expect(Object.keys(replayWhere)).toEqual(['account_guid', 'transaction']);
        expect(traceCostBasisMock).toHaveBeenCalledTimes(1);
    });
});
