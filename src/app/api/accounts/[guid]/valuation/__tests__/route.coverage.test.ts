/**
 * The account valuation payload, at the ROUTE level.
 *
 * It feeds the investment account panel's Cost Basis and Gain/Loss cards. The
 * route used to copy `holdings.costBasis` and `holdings.gainLoss` and drop the
 * coverage that says what they describe, so a partial basis was printed as a
 * complete one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, requireRoleMock, isAccountInActiveBookMock, getAccountHoldingsMock } = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findUnique: vi.fn() },
        splits: { findMany: vi.fn() },
    },
    requireRoleMock: vi.fn(),
    isAccountInActiveBookMock: vi.fn(),
    getAccountHoldingsMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({ isAccountInActiveBook: isAccountInActiveBookMock }));
vi.mock('@/lib/commodities', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/commodities')>();
    return {
        ...actual,
        getAccountHoldings: (...args: unknown[]) => getAccountHoldingsMock(...args),
        getPriceHistory: vi.fn(async () => []),
    };
});

import { GET } from '../route';
import type { CostBasisCoverage } from '@/lib/commodities';

const ACCOUNT = 'acct-broker';
const AAPL = 'commodity-aapl';

type Body = {
    holdings: {
        shares: number;
        costBasis: number;
        costBasisCoverage: CostBasisCoverage;
        gainLoss: number;
    };
};

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ bookGuid: 'book-guid', role: 'readonly' });
    isAccountInActiveBookMock.mockResolvedValue(true);
    prismaMock.accounts.findUnique.mockResolvedValue({
        guid: ACCOUNT, name: 'AAPL', account_type: 'STOCK', commodity_guid: AAPL,
        commodity: { guid: AAPL, namespace: 'NASDAQ', mnemonic: 'AAPL', fullname: 'Apple Inc.', fraction: 10_000 },
    });
    prismaMock.splits.findMany.mockResolvedValue([]);
});

async function valuation(): Promise<Body> {
    const response = await GET(
        new Request(`http://localhost/api/accounts/${ACCOUNT}/valuation`) as never,
        { params: Promise.resolve({ guid: ACCOUNT }) },
    ) as unknown as Response;
    expect(response.status).toBe(200);
    return await response.json() as Body;
}

describe('valuation route — cost-basis coverage', () => {
    it('sends the coverage with the basis and the covered-share gain', async () => {
        getAccountHoldingsMock.mockResolvedValue({
            shares: 200,
            costBasis: 3_500,
            costBasisCoverage: {
                status: 'partial', coveredShares: 150, uncoveredShares: 50,
                warnings: ['50 share(s) transferred in have no traceable cost basis in this book.'],
            },
            marketValue: 10_000,
            // 150 x $50 - $3,500, not $10,000 - $3,500 = $6,500.
            gainLoss: 4_000,
            gainLossPercent: 114.2857142,
            latestPrice: null,
        });

        const body = await valuation();
        expect(body.holdings.costBasis).toBe(3_500);
        expect(body.holdings.gainLoss).toBe(4_000);
        expect(body.holdings.costBasisCoverage).toMatchObject({
            status: 'partial', coveredShares: 150, uncoveredShares: 50,
        });
    });

    it('a fully covered account carries a complete coverage and nothing to caveat', async () => {
        getAccountHoldingsMock.mockResolvedValue({
            shares: 200,
            costBasis: 6_000,
            costBasisCoverage: { status: 'complete', coveredShares: 200 },
            marketValue: 10_000,
            gainLoss: 4_000,
            gainLossPercent: 66.6666666,
            latestPrice: null,
        });

        const body = await valuation();
        expect(body.holdings.costBasis).toBe(6_000);
        expect(body.holdings.gainLoss).toBe(4_000);
        expect(body.holdings.costBasisCoverage).toEqual({ status: 'complete', coveredShares: 200 });
    });
});
