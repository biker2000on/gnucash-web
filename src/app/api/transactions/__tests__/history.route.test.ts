/**
 * GET /api/transactions/{guid}/history — the resolvers the route builds.
 *
 * The renderer is pure and tested on its own; what only the route can get
 * wrong is *what it hands the renderer*. Two findings lived here: the
 * transaction's currency was never resolved (so a EUR book's history read in
 * dollars) and the account commodity was never resolved (so the renderer fell
 * back to `value !== quantity`, which is true of every cross-currency cash
 * split).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, requireRoleMock, getAccountGuidsForBookMock, buildAccountPathMapMock } = vi.hoisted(() => ({
    prismaMock: {
        splits: { findMany: vi.fn() },
        transactions: { findUnique: vi.fn() },
        accounts: { findMany: vi.fn() },
        gnucash_web_users: { findMany: vi.fn() },
        $queryRaw: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    getAccountGuidsForBookMock: vi.fn(),
    buildAccountPathMapMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: getAccountGuidsForBookMock }));
vi.mock('@/lib/reports/utils', () => ({ buildAccountPathMap: buildAccountPathMapMock }));

import { GET } from '../[guid]/history/route';

const TX = 't'.repeat(32);
const SPLIT_CASH = 'a'.repeat(32);
const SPLIT_SHARES = 'b'.repeat(32);
const ACCT_EUR = '1'.repeat(32);
const ACCT_BROKERAGE = '2'.repeat(32);

/** A EUR cash split: value in the transaction currency, quantity in the account's. */
const cashSplit = (quantityNum: string) => ({
    guid: SPLIT_CASH,
    account_guid: ACCT_EUR,
    memo: '', action: '', reconcile_state: 'n',
    value_num: '12000', value_denom: '100',
    quantity_num: quantityNum, quantity_denom: '100',
});

const shareSplit = (quantityNum: string) => ({
    guid: SPLIT_SHARES,
    account_guid: ACCT_BROKERAGE,
    memo: '', action: '', reconcile_state: 'n',
    value_num: '100000', value_denom: '100',
    quantity_num: quantityNum, quantity_denom: '1',
});

const snapshot = (splits: unknown[]) => ({
    snapshotVersion: 1, guid: TX, num: '', post_date: '2026-08-01 00:00:00',
    description: 'Corner Market', splits,
});

function auditRow(oldSplits: unknown[], newSplits: unknown[]) {
    return {
        id: 1, action: 'UPDATE', entity_type: 'TRANSACTION', entity_guid: TX,
        old_values: snapshot(oldSplits), new_values: snapshot(newSplits),
        created_at: new Date('2026-08-19T14:02:00.000Z'), user_id: null, undone_at: null,
    };
}

const params = { params: Promise.resolve({ guid: TX }) };

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ user: { id: 7 }, role: 'edit', bookGuid: 'b'.repeat(32) });
    getAccountGuidsForBookMock.mockResolvedValue([ACCT_EUR, ACCT_BROKERAGE]);
    buildAccountPathMapMock.mockResolvedValue(new Map([
        [ACCT_EUR, 'Assets:Euro Account'],
        [ACCT_BROKERAGE, 'Assets:Brokerage'],
    ]));
    prismaMock.splits.findMany.mockResolvedValue([
        { guid: SPLIT_CASH, account_guid: ACCT_EUR },
        { guid: SPLIT_SHARES, account_guid: ACCT_BROKERAGE },
    ]);
    prismaMock.gnucash_web_users.findMany.mockResolvedValue([]);
    prismaMock.transactions.findUnique.mockResolvedValue({ currency: { mnemonic: 'EUR' } });
    prismaMock.accounts.findMany.mockResolvedValue([
        { guid: ACCT_EUR, commodity: { namespace: 'CURRENCY' } },
        { guid: ACCT_BROKERAGE, commodity: { namespace: 'NASDAQ' } },
    ]);
});

async function historyOf(oldSplits: unknown[], newSplits: unknown[]) {
    prismaMock.$queryRaw.mockResolvedValue([auditRow(oldSplits, newSplits)]);
    const response = await GET(new Request('http://test/x'), params);
    expect(response.status).toBe(200);
    return response.json();
}

describe('transaction currency (H1)', () => {
    it('renders amounts in the transaction currency, not dollars', async () => {
        const body = await historyOf([cashSplit('10500')], [cashSplit('10500'), shareSplit('10')]);
        const [event] = body.events;
        expect(event.summary).toContain('€');
        expect(event.summary).not.toContain('$');
    });
});

describe('share leg vs FX cash leg (H2)', () => {
    it('does not report shares for a cross-currency CASH split', async () => {
        const body = await historyOf([cashSplit('10500')], [cashSplit('10600')]);
        const fields = body.events[0].changes.map((change: { field: string }) => change.field);
        expect(fields).not.toContain('quantity');
    });

    it('does report shares for a non-CURRENCY account', async () => {
        const body = await historyOf([shareSplit('10')], [shareSplit('12')]);
        const quantity = body.events[0].changes.find((change: { field: string }) => change.field === 'quantity');
        expect(quantity).toMatchObject({ label: 'shares', before: '10', after: '12' });
    });
});

describe('window (MED-C)', () => {
    it('reports hasMore when the audit cap is hit', async () => {
        prismaMock.$queryRaw.mockResolvedValue(
            Array.from({ length: 501 }, (_, index) => ({ ...auditRow([cashSplit('10500')], [cashSplit('10600')]), id: index + 1 })),
        );
        const response = await GET(new Request('http://test/x'), params);
        const body = await response.json();
        expect(body.hasMore).toBe(true);
        expect(body.events).toHaveLength(500);
    });

    it('reports hasMore false for an ordinary transaction', async () => {
        const body = await historyOf([cashSplit('10500')], [cashSplit('10600')]);
        expect(body.hasMore).toBe(false);
    });
});
