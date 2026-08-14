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

/** Stock-side split in the ledger account plus its counter-leg. */
function pair(o: {
    guid: string; txGuid: string; shares: number; value: number;
    counterAccount: string; counterShares: number;
}): { own: RawSplit; counter: RawSplit } {
    const q = frac(o.shares);
    const v = frac(o.value);
    const cq = frac(o.counterShares);
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

type LedgerRow = { guid: string; cost_basis: string; share_balance: string; cost_basis_uncovered_shares: string };

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
