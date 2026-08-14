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
 * WHAT THIS HARNESS PROVES — AND WHAT IT DOES NOT.
 *
 * There is no PostgreSQL in this repo's test setup, so these tests run the route
 * against a small in-memory stand-in. The stand-in does NOT re-derive the
 * filters from the request: it reconstructs the SQL the route actually sent (via
 * Prisma.sql), and applies a predicate only when that predicate is present in
 * the query text, with the polarity (EXISTS vs NOT EXISTS) and the bind values
 * the route supplied. So it does prove: which predicates reach the database,
 * that they sit in the same statement as LIMIT/OFFSET, that the binds are the
 * right values in the right places, and the row-level outcome that those
 * predicates imply.
 *
 * It does NOT prove PostgreSQL's own semantics. The comparison here is
 * re-implemented in JavaScript — exact integer (BigInt) arithmetic for the
 * cross-multiplied form the route now emits, float64 for the older dividing
 * form, which is what lets the repeating-fraction test below tell an exact
 * comparison from an inexact one. Whether `numeric * numeric` in a real server
 * behaves as claimed is taken on documentation, not measured here. Index use and
 * query plans are likewise unmeasured.
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

function makeSplit(
    txGuid: string,
    ordinal: number,
    value: { num: bigint; denom: bigint },
    state: string,
    accountGuid: string,
): FakeSplit {
    return {
        guid: `${txGuid.slice(0, 30)}${ordinal}0`.slice(0, 32),
        tx_guid: txGuid,
        account_guid: accountGuid,
        memo: '',
        action: '',
        reconcile_state: state,
        reconcile_date: null,
        value_num: value.num,
        value_denom: value.denom,
        quantity_num: value.num,
        quantity_denom: value.denom,
        lot_guid: null,
        account: {
            name: accountGuid === ACCOUNT_CHECKING ? 'Checking' : 'Groceries',
            commodity: { mnemonic: 'USD' },
        },
    };
}

/** Dollars as GnuCash stores them: cents over 100. */
const dollars = (amount: number) => ({ num: BigInt(Math.round(amount * 100)), denom: 100n });

const DATASET: FakeTx[] = Array.from({ length: 60 }, (_, i) => {
    const guid = String(i).padStart(32, '0');
    const splits = [
        makeSplit(guid, 0, dollars(10), 'n', ACCOUNT_CHECKING),
        makeSplit(guid, 1, dollars(-10), 'n', ACCOUNT_EXPENSE),
    ];
    if (i % 3 === 2) {
        BIG_AMOUNT_INDEXES.add(i);
        splits.push(makeSplit(guid, 2, dollars(500), 'y', ACCOUNT_CHECKING));
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

/** Add a transaction for the duration of one test. */
function withExtraTx(tx: FakeTx, run: () => Promise<void>): Promise<void> {
    DATASET.push(tx);
    return run().finally(() => {
        DATASET.splice(DATASET.indexOf(tx), 1);
    });
}

function extraTx(guid: string, splits: Array<{ num: bigint; denom: bigint }>): FakeTx {
    return {
        guid,
        currency_guid: 'd'.repeat(32),
        num: '',
        post_date: new Date(Date.UTC(2026, 0, 1)),
        enter_date: new Date(Date.UTC(2026, 0, 1)),
        description: 'Extra',
        splits: splits.map((v, i) => makeSplit(guid, i, v, 'n', ACCOUNT_CHECKING)),
    };
}

// --- Exact decimal arithmetic for the stand-in ---------------------------

const absBig = (v: bigint) => (v < 0n ? -v : v);

/** "0.3333333333333333" -> { scaled: 3333333333333333n, pow: 10^16 }. */
function parseDecimal(text: string): { scaled: bigint; pow: bigint } {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
    if (!m) throw new Error(`stand-in cannot parse bound "${text}"`);
    const [, sign, whole, frac = ''] = m;
    const digits = `${whole || '0'}${frac}`;
    const scaled = BigInt(digits) * (sign === '-' ? -1n : 1n);
    return { scaled, pow: 10n ** BigInt(frac.length) };
}

/**
 * Sign of (|num| / |denom| - bound), computed WITHOUT dividing:
 * |num| * 10^k  vs  scaledBound * |denom|. Exact for every fraction, including
 * the repeating ones a rounding quotient gets wrong.
 */
function compareAbsValue(num: bigint, denom: bigint, bound: string): number {
    const { scaled, pow } = parseDecimal(bound);
    const lhs = absBig(num) * pow;
    const rhs = scaled * absBig(denom);
    return lhs === rhs ? 0 : lhs > rhs ? 1 : -1;
}

// --- In-memory PostgreSQL stand-in ---------------------------------------

/** The reconstructed page query from the most recent GET, for assertions. */
let lastPageQuery: { text: string; values: unknown[] } | null = null;

function byPageOrder(a: FakeTx, b: FakeTx) {
    return b.post_date.getTime() - a.post_date.getTime() || (a.guid < b.guid ? -1 : 1);
}

/** Is the subquery containing `index` an EXISTS or a NOT EXISTS? */
function isNegated(text: string, index: number): boolean {
    const open = text.lastIndexOf('EXISTS', index);
    return open >= 4 && text.slice(open - 4, open) === 'NOT ';
}

/** Apply a per-split predicate with the polarity the SQL actually used. */
function applySplitPredicate(
    rows: FakeTx[],
    text: string,
    index: number,
    matches: (s: FakeSplit) => boolean,
): FakeTx[] {
    const negated = isNegated(text, index);
    return rows.filter(tx => (negated ? !tx.splits.some(matches) : tx.splits.some(matches)));
}

/** Apply only the predicates the route actually put in the SQL it sent. */
function runPageQuery(text: string, values: unknown[]): { guid: string }[] {
    const bind = (placeholder: string) => values[Number(placeholder) - 1];
    let rows = DATASET.slice();

    const book = /s\.account_guid = ANY\(\$(\d+)::text\[\]\)/.exec(text);
    if (book) {
        const guids = bind(book[1]) as string[];
        rows = rows.filter(tx => tx.splits.some(s => guids.includes(s.account_guid)));
    }

    // The cross-multiplied form: exact integer arithmetic, no division.
    const crossMin = /abs\(s\.value_num\)::numeric >= \$(\d+)::numeric \* abs\(s\.value_denom\)::numeric/.exec(text);
    if (crossMin) {
        const bound = String(bind(crossMin[1]));
        rows = applySplitPredicate(rows, text, crossMin.index, s =>
            s.value_denom !== 0n && compareAbsValue(s.value_num, s.value_denom, bound) >= 0);
    }
    const crossMax = /abs\(s\.value_num\)::numeric > \$(\d+)::numeric \* abs\(s\.value_denom\)::numeric/.exec(text);
    if (crossMax) {
        const bound = String(bind(crossMax[1]));
        rows = applySplitPredicate(rows, text, crossMax.index, s =>
            s.value_denom !== 0n && compareAbsValue(s.value_num, s.value_denom, bound) > 0);
    }

    // The older dividing form, evaluated in float64. Kept so a route that goes
    // back to dividing is measured with an inexact quotient, which is the whole
    // point of the repeating-fraction test.
    const divMin = /abs\(s\.value_num::numeric \/ NULLIF\(s\.value_denom, 0\)::numeric\) >= \$(\d+)::numeric/.exec(text);
    if (divMin) {
        const bound = Number(bind(divMin[1]));
        rows = applySplitPredicate(rows, text, divMin.index, s =>
            Math.abs(Number(s.value_num) / Number(s.value_denom)) >= bound);
    }
    const divMax = /abs\(s\.value_num::numeric \/ NULLIF\(s\.value_denom, 0\)::numeric\) <= \$(\d+)::numeric/.exec(text);
    if (divMax) {
        const bound = Number(bind(divMax[1]));
        rows = applySplitPredicate(rows, text, divMax.index, s =>
            Math.abs(Number(s.value_num) / Number(s.value_denom)) <= bound);
    }
    const divOver = /abs\(s\.value_num::numeric \/ NULLIF\(s\.value_denom, 0\)::numeric\) > \$(\d+)::numeric/.exec(text);
    if (divOver) {
        const bound = Number(bind(divOver[1]));
        rows = applySplitPredicate(rows, text, divOver.index, s =>
            Math.abs(Number(s.value_num) / Number(s.value_denom)) > bound);
    }

    // "has at least one comparable split" guard.
    const evaluable = /WHERE s\.tx_guid = t\.guid AND s\.value_denom <> 0\s*\)/.exec(text);
    if (evaluable) {
        rows = applySplitPredicate(rows, text, evaluable.index, s => s.value_denom !== 0n);
    }

    const rec = /lower\(s\.reconcile_state\) = ANY\(\$(\d+)::text\[\]\)/.exec(text);
    if (rec) {
        const states = bind(rec[1]) as string[];
        rows = applySplitPredicate(rows, text, rec.index, s => states.includes(s.reconcile_state.toLowerCase()));
    }

    rows.sort(byPageOrder);

    const limit = /LIMIT \$(\d+)/.exec(text);
    const offset = /OFFSET \$(\d+)/.exec(text);
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

function request(query: string): Promise<Response> {
    return GET(new Request(`http://localhost/api/transactions?${query}`)) as unknown as Promise<Response>;
}

async function get(query: string): Promise<ResponseTx[]> {
    const res = await request(query);
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
        // The matching split is index 2, and the response still carries every
        // split of the transaction.
        expect(hits[0].splits).toHaveLength(3);
        expect(hits[0].splits[2].value_decimal).toBe('500.00');
        expect(new Set(body.map(tx => tx.guid)).size).toBe(body.length);
    });

    it('excludes transactions whose amount is outside the range', async () => {
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
        expect(text).toMatch(/abs\(s\.value_num\)::numeric >= \$\d+::numeric/);
        expect(text).toMatch(/lower\(s\.reconcile_state\)/);
        // The bounds are bound as text for a ::numeric cast, never as a float.
        expect(lastPageQuery!.values).toContain('500');
        expect(lastPageQuery!.values).toContain(10);
        expect(lastPageQuery!.values).toContain(20);
    });
});

describe('GET /api/transactions — amount semantics', () => {
    it('compares by exact cross-multiplication and never divides', async () => {
        await get('minAmount=0.005&maxAmount=1000.5&limit=5');

        const text = lastPageQuery!.text;
        expect(text).toMatch(/abs\(s\.value_num\)::numeric >= \$\d+::numeric \* abs\(s\.value_denom\)::numeric/);
        expect(text).toMatch(/abs\(s\.value_num\)::numeric > \$\d+::numeric \* abs\(s\.value_denom\)::numeric/);
        // No division anywhere in the amount comparison: `numeric / numeric`
        // rounds the quotient, `numeric * numeric` does not.
        expect(text).not.toContain('value_num::numeric /');
        expect(text).not.toContain('NULLIF(s.value_denom');
        // Bounds passed through verbatim as decimal text — no float64 round trip.
        expect(lastPageQuery!.values).toContain('0.005');
        expect(lastPageQuery!.values).toContain('1000.5');
    });

    it('gets a repeating fraction right at the boundary, where a rounded quotient does not', async () => {
        // A third of a dollar: 1/3 is strictly greater than 0.3333333333333333,
        // so a ceiling of 0.3333333333333333 must exclude it. Dividing first
        // rounds the quotient and lets it through.
        const thirds = extraTx('1'.repeat(32), [{ num: 1n, denom: 3n }]);
        await withExtraTx(thirds, async () => {
            const excluded = await get('maxAmount=0.3333333333333333&limit=100');
            expect(excluded.map(tx => tx.guid)).not.toContain(thirds.guid);

            // Positive control: a ceiling above 1/3 does include it.
            const included = await get('maxAmount=0.34&limit=100');
            expect(included.map(tx => tx.guid)).toContain(thirds.guid);
        });
    });

    it('handles a negative denominator without flipping the comparison', async () => {
        // -100 as the denominator: the value is still $5, so a [1, 10] range
        // must find it. Multiplying by a signed denominator would invert the
        // inequality and drop it.
        const negativeDenom = extraTx('2'.repeat(32), [{ num: 500n, denom: -100n }]);
        await withExtraTx(negativeDenom, async () => {
            const body = await get('minAmount=1&maxAmount=10&limit=100');
            expect(body.map(tx => tx.guid)).toContain(negativeDenom.guid);
        });
    });

    it('treats a zero denominator as no match rather than a match or an error', async () => {
        const zeroDenom = extraTx('3'.repeat(32), [{ num: 500n, denom: 0n }]);
        await withExtraTx(zeroDenom, async () => {
            expect((await get('minAmount=0&limit=100')).map(tx => tx.guid)).not.toContain(zeroDenom.guid);
            expect((await get('maxAmount=100000&limit=100')).map(tx => tx.guid)).not.toContain(zeroDenom.guid);
        });
    });

    it('measures a transaction by its LARGEST absolute split, not by any split', async () => {
        // A $3,000 paycheque with a $12 fee line. Under "any split in range" a
        // ceiling of $100 matched it through the fee; under "largest split" the
        // ceiling excludes it, which is what the "Amount Range" control implies.
        const paycheque = extraTx('4'.repeat(32), [
            dollars(3000), dollars(-12), dollars(-2988),
        ]);
        await withExtraTx(paycheque, async () => {
            const capped = await get('maxAmount=100&limit=100');
            expect(capped.map(tx => tx.guid)).not.toContain(paycheque.guid);

            // The floor still sees it, because its largest line clears $500.
            const floored = await get('minAmount=500&limit=100');
            expect(floored.map(tx => tx.guid)).toContain(paycheque.guid);
        });
    });

    it('applies unequal bounds in the right direction (swapped binds would fail here)', async () => {
        // Largest split is $500 for the 20 matchers and $10 for the rest, so
        // [20, 1000] selects exactly the matchers. Swap the binds — [1000, 20] —
        // and nothing qualifies at all.
        const body = await get('minAmount=20&maxAmount=1000&limit=100');

        expect(body.map(tx => tx.guid)).toEqual(MATCHING_INDEXES.map(guidOf));
        expect(body).toHaveLength(20);
        const values = lastPageQuery!.values;
        expect(values.indexOf('20')).toBeLessThan(values.indexOf('1000'));
    });

    it('matches on absolute value, so a -500 split is found by a +500 filter', async () => {
        const negative = extraTx('e'.repeat(32), [dollars(-500)]);
        await withExtraTx(negative, async () => {
            const body = await get('minAmount=500&maxAmount=500&limit=100');
            expect(body.map(tx => tx.guid)).toContain(negative.guid);
        });
    });
});

describe('GET /api/transactions — a malformed filter must never widen the result', () => {
    it('rejects accountTypes with an empty entry instead of dropping the filter', async () => {
        const res = await request('accountTypes=,&limit=100');

        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/accountTypes/);
    });

    it('rejects reconcileStates with an empty entry instead of dropping the filter', async () => {
        const res = await request('reconcileStates=,&limit=100');

        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/reconcileStates/);
    });

    it('rejects a non-numeric amount bound instead of dropping the filter', async () => {
        for (const query of ['minAmount=abc', 'maxAmount=abc', 'minAmount=12abc']) {
            const res = await request(`${query}&limit=100`);
            expect(res.status).toBe(400);
        }
    });

    it('never answers a malformed filter with the unfiltered ledger', async () => {
        // Control: with no filter at all, this request is the whole book.
        expect(await get('limit=100')).toHaveLength(DATASET.length);

        for (const query of ['accountTypes=,', 'reconcileStates=,', 'minAmount=abc']) {
            const res = await request(`${query}&limit=100`);
            const body = await res.json();
            expect(res.status).toBe(400);
            expect(Array.isArray(body)).toBe(false);
        }
    });

    it('still accepts an absent filter and a well-formed one', async () => {
        expect(await get('limit=5')).toHaveLength(5);
        // An empty param is "no filter", as it always was.
        expect(await get('accountTypes=&reconcileStates=&minAmount=&limit=5')).toHaveLength(5);

        await get('accountTypes=EXPENSE&limit=5');
        expect(lastPageQuery!.text).toMatch(/a\.account_type = ANY\(\$\d+::text\[\]\)/);
        expect(lastPageQuery!.values).toContainEqual(['EXPENSE']);
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
