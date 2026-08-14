/**
 * In-memory contract tests for the account-ledger page query. They inspect the
 * Prisma SQL sent by the route and model only those predicates. No real
 * PostgreSQL harness exists here, so this proves query construction, predicate
 * placement, binds, ordering, hydration ordering, and response shape—not
 * PostgreSQL numeric execution or query plans.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { prismaMock, isAccountInActiveBookMock, requireRoleMock } = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findUnique: vi.fn(), findMany: vi.fn() },
        transactions: { findMany: vi.fn() },
        $queryRaw: vi.fn(),
    },
    isAccountInActiveBookMock: vi.fn(),
    requireRoleMock: vi.fn(),
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
vi.mock('@/lib/cache', () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }));
vi.mock('@/lib/cost-basis', () => ({
    traceCostBasis: vi.fn(), isTransferIn: vi.fn(), createCostBasisCache: vi.fn(), preloadLotSplits: vi.fn(),
}));

import { GET } from '../route';

const ACCOUNT = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

type Split = {
    guid: string; tx_guid: string; account_guid: string; memo: string; action: string;
    reconcile_state: string; reconcile_date: null; value_num: bigint; value_denom: bigint;
    quantity_num: bigint; quantity_denom: bigint; lot_guid: null;
    account: { name: string; account_type: string; commodity: { mnemonic: string } };
};
type Tx = { guid: string; currency_guid: string; num: string; post_date: Date; enter_date: Date; description: string; splits: Split[] };

const dollars = (n: number) => ({ num: BigInt(n * 100), denom: 100n });
function split(tx: string, i: number, value: { num: bigint; denom: bigint }, state: string, accountGuid: string): Split {
    return {
        guid: `${tx.slice(0, 30)}${i}0`.slice(0, 32), tx_guid: tx, account_guid: accountGuid, memo: '', action: '',
        reconcile_state: state, reconcile_date: null, value_num: value.num, value_denom: value.denom,
        quantity_num: value.num, quantity_denom: value.denom, lot_guid: null,
        account: { name: accountGuid === ACCOUNT ? 'Checking' : 'Other', account_type: 'ASSET', commodity: { mnemonic: 'USD' } },
    };
}
const DATA: Tx[] = Array.from({ length: 60 }, (_, i) => {
    const guid = String(i).padStart(32, '0');
    const splits = [split(guid, 0, dollars(10), 'n', ACCOUNT), split(guid, 1, dollars(-10), 'n', OTHER)];
    if (i % 3 === 2) splits.push(split(guid, 2, dollars(500), 'y', OTHER));
    return { guid, currency_guid: 'c'.repeat(32), num: '', post_date: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000), enter_date: new Date(Date.UTC(2026, 0, 1)), description: `Transaction ${i}`, splits };
});
const matching = DATA.filter((_, i) => i % 3 === 2);
const order = (a: Tx, b: Tx) => b.post_date.getTime() - a.post_date.getTime() || b.enter_date.getTime() - a.enter_date.getTime() || a.guid.localeCompare(b.guid);
let lastPageQuery: { text: string; values: unknown[] } | null = null;

function queryRows(text: string, values: unknown[]) {
    const bind = (placeholder: string) => values[Number(placeholder) - 1];
    let rows = DATA.filter(tx => tx.splits.some(s => s.account_guid === ACCOUNT));
    const min = /abs\(s\.value_num::numeric\) >= \$(\d+)::numeric \* abs\(s\.value_denom::numeric\)/.exec(text);
    if (min) {
        const bound = BigInt(String(bind(min[1]))) * 100n;
        rows = rows.filter(tx => tx.splits.some(s => s.value_denom !== 0n && (s.value_num < 0n ? -s.value_num : s.value_num) >= bound * (s.value_denom < 0n ? -s.value_denom : s.value_denom) / 100n));
    }
    const max = /abs\(s\.value_num::numeric\) > \$(\d+)::numeric \* abs\(s\.value_denom::numeric\)/.exec(text);
    if (max) {
        const bound = BigInt(String(bind(max[1]))) * 100n;
        rows = rows.filter(tx => !tx.splits.some(s => s.value_denom !== 0n && (s.value_num < 0n ? -s.value_num : s.value_num) > bound * (s.value_denom < 0n ? -s.value_denom : s.value_denom) / 100n));
    }
    const states = /lower\(s\.reconcile_state\) = ANY\(\$(\d+)::text\[\]\)/.exec(text);
    if (states) rows = rows.filter(tx => tx.splits.some(s => (bind(states[1]) as string[]).includes(s.reconcile_state)));
    rows.sort(order);
    const limit = /LIMIT \$(\d+)/.exec(text)!;
    const offset = /OFFSET \$(\d+)/.exec(text)!;
    return rows.slice(Number(bind(offset[1])), Number(bind(offset[1])) + Number(bind(limit[1]))).map(tx => ({ guid: tx.guid }));
}

beforeEach(() => {
    vi.clearAllMocks();
    lastPageQuery = null;
    requireRoleMock.mockResolvedValue({ bookGuid: 'z'.repeat(32), role: 'readonly' });
    isAccountInActiveBookMock.mockResolvedValue(true);
    prismaMock.accounts.findUnique.mockResolvedValue({ commodity: { mnemonic: 'USD', namespace: 'CURRENCY' } });
    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = Prisma.sql(strings, ...values);
        if (query.text.includes('gnucash_web_transaction_meta') || query.text.includes('gnucash_web_receipts')) return Promise.resolve([]);
        if (query.text.includes('account_transaction_deltas')) return Promise.resolve([]);
        lastPageQuery = { text: query.text, values: query.values };
        return Promise.resolve(queryRows(query.text, query.values));
    });
    prismaMock.transactions.findMany.mockImplementation(({ where }: { where: { guid: { in: string[] } } }) => {
        const wanted = new Set(where.guid.in);
        return Promise.resolve(DATA.filter(tx => wanted.has(tx.guid)).reverse());
    });
});

const request = (query: string) => GET(new Request(`http://localhost/api/accounts/${ACCOUNT}/transactions?${query}`), { params: Promise.resolve({ guid: ACCOUNT }) }) as unknown as Promise<Response>;
async function get(query: string): Promise<Array<{ guid: string; splits: Split[] }>> {
    const response = await request(query);
    expect(response.status).toBe(200);
    return response.json();
}

describe('GET /api/accounts/[guid]/transactions filtering before pagination', () => {
    it('returns a matching transaction outside the unfiltered first page and fills the requested page', async () => {
        const body = await get('minAmount=500&maxAmount=500&limit=10');
        expect(body).toHaveLength(10);
        expect(body.map(tx => tx.guid)).toEqual(matching.slice(0, 10).map(tx => tx.guid));
        expect(body.map(tx => tx.guid)).toContain(DATA[29].guid);
    });

    it('walks the filtered set, not raw rows, across offsets', async () => {
        const page1 = await get('minAmount=500&maxAmount=500&limit=10&offset=0');
        const page2 = await get('minAmount=500&maxAmount=500&limit=10&offset=10');
        expect(page2.map(tx => tx.guid)).toEqual(matching.slice(10, 20).map(tx => tx.guid));
        expect(new Set([...page1, ...page2].map(tx => tx.guid)).size).toBe(20);
    });

    it('deduplicates a transaction whose non-first split is the matching split', async () => {
        const body = await get('minAmount=500&maxAmount=500&limit=100');
        const hit = body.filter(tx => tx.guid === DATA[2].guid);
        expect(hit).toHaveLength(1);
        expect(hit[0].splits).toHaveLength(3);
    });

    it('puts reconcile filtering in the paginated SQL query', async () => {
        const body = await get('reconcileStates=y&limit=10');
        expect(body).toHaveLength(10);
        expect(lastPageQuery?.text).toMatch(/lower\(s\.reconcile_state\) = ANY\(\$\d+::text\[\]\)/);
    });

    it.each(['minAmount=abc', 'maxAmount=%20', 'reconcileStates=,y', 'reconcileStates=%20'])('rejects malformed %s instead of returning the unfiltered ledger', async query => {
        const response = await request(`${query}&limit=100`);
        expect(response.status).toBe(400);
        expect(await response.json()).not.toEqual(expect.any(Array));
        expect(lastPageQuery).toBeNull();
    });
});
