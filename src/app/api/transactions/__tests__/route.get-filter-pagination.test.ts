/**
 * Route tests for GET /api/transactions — amount and reconcile-state filters
 * must be applied by the database, inside the query that paginates (ASI-6-005).
 *
 * Before the fix the route fetched a page of transactions with LIMIT/OFFSET and
 * only then filtered that page in JavaScript, so:
 *   - a matching transaction that happened to sit on page 2 of the UNFILTERED
 *     ordering was simply never returned (the headline user-visible bug: search
 *     the ledger for a $500 transaction, find nothing);
 *   - every filtered page under-filled (ask for 50, get 7), which the infinite
 *     scroll in TransactionJournal reads as "no more results".
 *
 * These tests run the route against a small in-memory stand-in for PostgreSQL.
 * The stand-in does NOT re-derive the filters from the request: it reconstructs
 * the SQL the route actually sent (via Prisma.sql) and only applies a predicate
 * when that predicate is present in the query text, with the bind value the
 * route supplied. So a route that stops asking the database to filter gets an
 * unfiltered page back, exactly as the real database would give it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { prismaMock, requireRoleMock, getBookAccountGuidsMock } = vi.hoisted(() => ({
    prismaMock: {
        transactions: { findMany: vi.fn(), create: vi.fn() },
        splits: { findMany: vi.fn() },
        accounts: { findMany: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    getBookAccountGuidsMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: prismaMock,
    toDecimal: (num: bigint, denom: bigint) => (Number(num) / Number(denom)).toFixed(2),
    generateGuid: vi.fn(() => 'f'.repeat(32)),
}));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({
    getBookAccountGuids: getBookAccountGuidsMock,
    getActiveBookGuid: vi.fn(),
}));
vi.mock('@/lib/reports/utils', () => ({ buildAccountPathMap: vi.fn(async () => new Map()) }));
vi.mock('@/lib/services/tag.service', () => ({ getTagsForTransactions: vi.fn(async () => new Map()) }));
vi.mock('@/lib/services/audit.service', () => ({ logAudit: vi.fn(), snapshotTransactionByGuid: vi.fn() }));
vi.mock('@/lib/trading-accounts', () => ({ processMultiCurrencySplits: vi.fn() }));
vi.mock('@/lib/cache', () => ({ cacheInvalidateFrom: vi.fn() }));
vi.mock('@/lib/data-events', () => ({ publishDataChange: vi.fn() }));
vi.mock('@/lib/transaction-notes', () => ({ writeTransactionNotes: vi.fn() }));
vi.mock('@/lib/services/period-lock.service', () => ({
    PeriodLockedError: class extends Error {},
    withPeriodLockCheck: vi.fn(),
    assertNotLocked: vi.fn(),
    periodLockedResponse: vi.fn(),
}));

import { GET } from '../route';

const BOOK_GUID = 'b'.repeat(32);
const ACCOUNT_CHECKING = 'a'.repeat(32);
const ACCOUNT_EXPENSE = 'c'.repeat(32);

// --- Fixture -------------------------------------------------------------
//
// 60 transactions, newest first. Every transaction carries a $10 pair. Every
// third transaction (index 2, 5, 8, ... 59 — 20 of them) additionally carries a
// $500 split as its THIRD split, reconciled 'y'. The $500 split is deliberately
// never the first split, and the first ten transactions by date contain only
// three of them, so a page-then-filter implementation cannot produce a full
// page of matches.

interface FakeSplit {
    guid: string;
    tx_guid: string;
    account_guid: string;
    memo: string;
    action: string;
    reconcile_state: string;
    reconcile_date: Date | null;
    value_num: bigint;
    value_denom: bigint;
    quantity_num: bigint;
    quantity_denom: bigint;
    lot_guid: string | null;
    account: { name: string; commodity: { mnemonic: string } | null };
}

interface FakeTx {
    guid: string;
    currency_guid: string;
    num: string;
    post_date: Date;
    enter_date: Date;
    description: string;
    splits: FakeSplit[];
}

const BIG_AMOUNT_INDEXES = new Set<number>();

function makeSplit(txGuid: string, ordinal: number, dollars: number, state: string, accountGuid: string): FakeSplit {
    return {
        guid: `${txGuid.slice(0, 30)}${ordinal}0`.slice(0, 32),
        tx_guid: txGuid,
        account_guid: accountGuid,
        memo: '',
        action: '',
        reconcile_state: state,
        reconcile_date: null,
        value_num: BigInt(Math.round(dollars * 100)),
        value_denom: 100n,
        quantity_num: BigInt(Math.round(dollars * 100)),
        quantity_denom: 100n,
        lot_guid: null,
        account: {
            name: accountGuid === ACCOUNT_CHECKING ? 'Checking' : 'Groceries',
            commodity: { mnemonic: 'USD' },
        },
    };
}

const DATASET: FakeTx[] = Array.from({ length: 60 }, (_, i) => {
    const guid = String(i).padStart(32, '0');
    const splits = [
        makeSplit(guid, 0, 10, 'n', ACCOUNT_CHECKING),
        makeSplit(guid, 1, -10, 'n', ACCOUNT_EXPENSE),
    ];
    if (i % 3 === 2) {
        BIG_AMOUNT_INDEXES.add(i);
        splits.push(makeSplit(guid, 2, 500, 'y', ACCOUNT_CHECKING));
    }
    return {
        guid,
        currency_guid: 'd'.repeat(32),
        num: '',
        // Newest first: index 0 is the most recent.
        post_date: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000),
        enter_date: new Date(Date.UTC(2026, 0, 1)),
        description: `Transaction ${i}`,
        splits,
    };
});

const guidOf = (i: number) => DATASET[i].guid;
/** Dataset indexes carrying a $500 split, newest first. */
const MATCHING_INDEXES = [...BIG_AMOUNT_INDEXES].sort((a, b) => a - b);

// --- In-memory PostgreSQL stand-in ---------------------------------------

/** The reconstructed page query from the most recent GET, for assertions. */
let lastPageQuery: { text: string; values: unknown[] } | null = null;

function byPageOrder(a: FakeTx, b: FakeTx) {
    return b.post_date.getTime() - a.post_date.getTime() || (a.guid < b.guid ? -1 : 1);
}

/** Apply only the predicates the route actually put in the SQL it sent. */
function runPageQuery(text: string, values: unknown[]): { guid: string }[] {
    const bind = (placeholder: string) => values[Number(placeholder) - 1];
    let rows = DATASET.slice();

    const book = text.match(/s\.account_guid = ANY\(\$(\d+)::text\[\]\)/);
    if (book) {
        const guids = bind(book[1]) as string[];
        rows = rows.filter(tx => tx.splits.some(s => guids.includes(s.account_guid)));
    }

    const min = text.match(/NULLIF\(s\.value_denom, 0\)::numeric\) >= \$(\d+)::numeric/);
    const max = text.match(/NULLIF\(s\.value_denom, 0\)::numeric\) <= \$(\d+)::numeric/);
    if (min || max) {
        const lo = min ? Number(bind(min[1])) : -Infinity;
        const hi = max ? Number(bind(max[1])) : Infinity;
        rows = rows.filter(tx => tx.splits.some(s => {
            const abs = Math.abs(Number(s.value_num) / Number(s.value_denom));
            return abs >= lo && abs <= hi;
        }));
    }

    const rec = text.match(/lower\(s\.reconcile_state\) = ANY\(\$(\d+)::text\[\]\)/);
    if (rec) {
        const states = bind(rec[1]) as string[];
        rows = rows.filter(tx => tx.splits.some(s => states.includes(s.reconcile_state.toLowerCase())));
    }

    rows.sort(byPageOrder);

    const limit = text.match(/LIMIT \$(\d+)/);
    const offset = text.match(/OFFSET \$(\d+)/);
    const skip = offset ? Number(bind(offset[1])) : 0;
    const take = limit ? Number(bind(limit[1])) : rows.length;
    return rows.slice(skip, skip + take).map(tx => ({ guid: tx.guid }));
}

beforeEach(() => {
    vi.clearAllMocks();
    lastPageQuery = null;
    requireRoleMock.mockResolvedValue({ bookGuid: BOOK_GUID, role: 'readonly' });
    getBookAccountGuidsMock.mockResolvedValue([ACCOUNT_CHECKING, ACCOUNT_EXPENSE]);

    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = Prisma.sql(strings, ...values);
        if (query.text.includes('gnucash_web_receipts')) return Promise.resolve([]);
        lastPageQuery = { text: query.text, values: query.values };
        return Promise.resolve(runPageQuery(query.text, query.values));
    });

    prismaMock.transactions.findMany.mockImplementation(async (args: {
        where?: { guid?: { in?: string[] } };
        take?: number;
        skip?: number;
    } = {}) => {
        const wanted = args.where?.guid?.in;
        if (wanted) {
            // Hydration by GUID. Returned deliberately out of order — the route
            // owns the page ordering, not this call.
            const set = new Set(wanted);
            return DATASET.filter(tx => set.has(tx.guid)).reverse();
        }
        // Legacy shape: whole-table scan with LIMIT/OFFSET and no amount or
        // reconcile predicate. This is what the pre-fix route asked for.
        const rows = DATASET.slice().sort(byPageOrder);
        const skip = args.skip ?? 0;
        return rows.slice(skip, skip + (args.take ?? rows.length));
    });
});

type ResponseTx = { guid: string; description: string; splits: { value_decimal: string; reconcile_state: string }[] };

async function get(query: string): Promise<ResponseTx[]> {
    const res = await GET(new Request(`http://localhost/api/transactions?${query}`));
    expect(res.status).toBe(200);
    return res.json();
}

describe('GET /api/transactions — filtering happens before pagination', () => {
    it('returns a matching transaction that falls outside the unfiltered first page', async () => {
        // Index 29 carries the $500 split and sits on page 3 of the UNFILTERED
        // ordering at limit=10. Pre-fix, this request returned the three
        // matches inside indexes 0-9 and nothing else.
        const body = await get('minAmount=500&maxAmount=500&limit=10&offset=0');

        expect(body.map(tx => tx.guid)).toContain(guidOf(29));
        expect(body.map(tx => tx.guid)).toEqual(MATCHING_INDEXES.slice(0, 10).map(guidOf));
    });

    it('fills the page: a page of 10 matches is 10 rows, not the leftovers of an unfiltered page', async () => {
        const body = await get('minAmount=500&maxAmount=500&limit=10&offset=0');
        expect(body).toHaveLength(10);
    });

    it('paginates the filtered set, so offset walks matches and not raw rows', async () => {
        const page1 = await get('minAmount=500&maxAmount=500&limit=10&offset=0');
        const page2 = await get('minAmount=500&maxAmount=500&limit=10&offset=10');

        expect(page2).toHaveLength(10);
        expect(page2.map(tx => tx.guid)).toEqual(MATCHING_INDEXES.slice(10, 20).map(guidOf));
        // Disjoint pages that together cover every match exactly once.
        const all = [...page1, ...page2].map(tx => tx.guid);
        expect(new Set(all).size).toBe(20);
        expect(new Set(all)).toEqual(new Set(MATCHING_INDEXES.map(guidOf)));
    });

    it('returns a transaction once even though only its third split matches', async () => {
        const body = await get('minAmount=500&maxAmount=500&limit=100');

        const hits = body.filter(tx => tx.guid === guidOf(2));
        expect(hits).toHaveLength(1);
        // The matching split is neither first nor last-resort: it is index 2,
        // and the response still carries every split of the transaction.
        expect(hits[0].splits).toHaveLength(3);
        expect(hits[0].splits[2].value_decimal).toBe('500.00');
        expect(new Set(body.map(tx => tx.guid)).size).toBe(body.length);
    });

    it('excludes transactions whose only large split is outside the range', async () => {
        const body = await get('minAmount=100&maxAmount=200&limit=100');
        expect(body).toHaveLength(0);
    });

    it('applies the reconcile-state filter in SQL and returns a full page', async () => {
        const body = await get('reconcileStates=y&limit=10');

        expect(body).toHaveLength(10);
        expect(body.map(tx => tx.guid)).toEqual(MATCHING_INDEXES.slice(0, 10).map(guidOf));
        expect(lastPageQuery?.text).toMatch(/lower\(s\.reconcile_state\) = ANY\(\$\d+::text\[\]\)/);
        expect(lastPageQuery?.values).toContainEqual(['y']);
    });

    it('keeps amount and reconcile filters in the same query that paginates', async () => {
        await get('minAmount=500&reconcileStates=y&limit=10&offset=20');

        const text = lastPageQuery!.text;
        expect(text).toContain('LIMIT');
        expect(text).toContain('OFFSET');
        expect(text).toMatch(/abs\(s\.value_num::numeric \/ NULLIF\(s\.value_denom, 0\)::numeric\)/);
        expect(text).toMatch(/lower\(s\.reconcile_state\)/);
        // The bounds are bound as text for a ::numeric cast, never as a float.
        expect(lastPageQuery!.values).toContain('500');
        expect(lastPageQuery!.values).toContain(10);
        expect(lastPageQuery!.values).toContain(20);
    });
});

describe('GET /api/transactions — amount semantics', () => {
    it('compares as an exact rational in numeric, not by string padding or float', async () => {
        await get('minAmount=0.005&maxAmount=1000.5&limit=5');

        const text = lastPageQuery!.text;
        expect(text).toMatch(/abs\(s\.value_num::numeric \/ NULLIF\(s\.value_denom, 0\)::numeric\) >= \$\d+::numeric/);
        expect(text).toMatch(/abs\(s\.value_num::numeric \/ NULLIF\(s\.value_denom, 0\)::numeric\) <= \$\d+::numeric/);
        // Passed through verbatim as decimal text — no float64 round trip.
        expect(lastPageQuery!.values).toContain('0.005');
        expect(lastPageQuery!.values).toContain('1000.5');
    });

    it('tests both bounds against the same split (a transaction "has a line in this range")', async () => {
        await get('minAmount=400&maxAmount=600&limit=5');

        const text = lastPageQuery!.text;
        const lo = text.indexOf('>= $');
        const hi = text.indexOf('<= $');
        expect(lo).toBeGreaterThan(-1);
        expect(hi).toBeGreaterThan(lo);
        // No EXISTS between the two bounds: they live in one subquery, so they
        // constrain one split rather than two independent ones.
        expect(text.slice(lo, hi)).not.toContain('EXISTS');
    });

    it('matches on absolute value, so a -500 split is found by a +500 filter', async () => {
        const negative: FakeTx = {
            ...DATASET[0],
            guid: 'e'.repeat(32),
            splits: [makeSplit('e'.repeat(32), 0, -500, 'n', ACCOUNT_CHECKING)],
        };
        DATASET.push(negative);
        try {
            const body = await get('minAmount=500&maxAmount=500&limit=100');
            expect(body.map(tx => tx.guid)).toContain(negative.guid);
        } finally {
            DATASET.pop();
        }
    });
});

describe('GET /api/transactions — response contract for infinite scroll', () => {
    it('still answers with a bare array of transactions in post_date order', async () => {
        const body = await get('limit=5');

        expect(Array.isArray(body)).toBe(true);
        // Page order survives hydration, which returns rows in another order.
        expect(body.map(tx => tx.guid)).toEqual([0, 1, 2, 3, 4].map(guidOf));
    });

    it('preserves the fields TransactionJournal and the ledger page read', async () => {
        const [tx] = await get('limit=1');

        expect(Object.keys(tx).sort()).toEqual([
            'currency_guid', 'description', 'enter_date', 'guid', 'num',
            'post_date', 'receipt_count', 'splits', 'tags',
        ]);
        expect(Object.keys(tx.splits[0]).sort()).toEqual([
            'account_fullname', 'account_guid', 'account_name', 'action',
            'commodity_mnemonic', 'guid', 'lot_guid', 'memo', 'quantity_decimal',
            'quantity_denom', 'quantity_num', 'reconcile_date', 'reconcile_state',
            'tx_guid', 'value_decimal', 'value_denom', 'value_num',
        ]);
    });

    it('returns an empty array (not an error) past the end of the filtered set', async () => {
        const body = await get('minAmount=500&maxAmount=500&limit=10&offset=20');
        expect(body).toEqual([]);
    });
});
