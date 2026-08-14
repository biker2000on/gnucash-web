/**
 * The portfolio report, at the ROUTE level.
 *
 * `getAccountHoldings` reports the basis of the shares it could establish one
 * for, plus the coverage saying which shares those are. The route used to copy
 * the basis and drop the coverage, so a holding with untraceable transferred-in
 * shares reached the holdings table as a complete cost basis — and its gain and
 * yield read as pure profit on the shares that had no basis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, requireRoleMock, getBookAccountGuidsMock, getAccountHoldingsMock } = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findMany: vi.fn() },
        splits: { findMany: vi.fn() },
    },
    requireRoleMock: vi.fn(),
    getBookAccountGuidsMock: vi.fn(),
    getAccountHoldingsMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({ getBookAccountGuids: getBookAccountGuidsMock }));
vi.mock('@/lib/commodity-metadata', () => ({
    getCachedMetadata: vi.fn(async () => ({ sector: 'Technology' })),
    getPortfolioSectorExposure: vi.fn(async () => []),
    refreshMetadata: vi.fn(async () => {}),
}));
// Only the holdings engine is stubbed; combineCoverage is the real one.
vi.mock('@/lib/commodities', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/commodities')>();
    return { ...actual, getAccountHoldings: (...args: unknown[]) => getAccountHoldingsMock(...args) };
});

import { GET } from '../route';
import type { CostBasisCoverage } from '@/lib/commodities';

const ROOT = 'root-guid';
const PARENT = 'parent-guid';
const BROKER_A = 'acct-broker-a';
const BROKER_B = 'acct-broker-b';
const AAPL = 'commodity-aapl';

type Holding = {
    accountGuid: string;
    costBasis: number;
    costBasisCoverage: CostBasisCoverage;
    marketValue: number;
    gainLoss: number;
};
type ConsolidatedHolding = {
    totalCostBasis: number;
    totalCostBasisCoverage: CostBasisCoverage;
    totalMarketValue: number;
    totalGainLoss: number;
    accounts: Array<{ accountGuid: string; costBasisCoverage: CostBasisCoverage }>;
};
type Body = {
    summary: { totalCostBasis: number; totalCostBasisCoverage: CostBasisCoverage; totalGainLoss: number };
    holdings: Holding[];
    consolidatedHoldings: ConsolidatedHolding[];
};

/**
 * Broker A holds 200 AAPL worth $10,000 whose basis ($3,500) covers only 150 of
 * them; the gain is that slice's, $7,500 - $3,500 = $4,000. Broker B holds 100
 * fully covered shares worth $5,000 against $2,000, a $3,000 gain.
 */
const HOLDINGS: Record<string, {
    shares: number; costBasis: number; costBasisCoverage: CostBasisCoverage;
    marketValue: number; gainLoss: number; gainLossPercent: number; latestPrice: null;
}> = {
    [BROKER_A]: {
        shares: 200,
        costBasis: 3_500,
        costBasisCoverage: {
            status: 'partial', coveredShares: 150, uncoveredShares: 50,
            warnings: ['50 share(s) transferred in have no traceable cost basis in this book.'],
        },
        marketValue: 10_000,
        gainLoss: 4_000,
        gainLossPercent: 114.2857142,
        latestPrice: null,
    },
    [BROKER_B]: {
        shares: 100,
        costBasis: 2_000,
        costBasisCoverage: { status: 'complete', coveredShares: 100 },
        marketValue: 5_000,
        gainLoss: 3_000,
        gainLossPercent: 150,
        latestPrice: null,
    },
};

beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ bookGuid: 'book-guid', role: 'readonly' });
    getBookAccountGuidsMock.mockResolvedValue([ROOT, PARENT, BROKER_A, BROKER_B]);
    prismaMock.accounts.findMany.mockImplementation((args: { where?: { account_type?: unknown } }) => {
        const all = [
            { guid: ROOT, name: 'Root', parent_guid: null, account_type: 'ROOT' },
            { guid: PARENT, name: 'Brokerage', parent_guid: ROOT, account_type: 'ASSET' },
            { guid: BROKER_A, name: 'AAPL A', parent_guid: PARENT, account_type: 'STOCK' },
            { guid: BROKER_B, name: 'AAPL B', parent_guid: PARENT, account_type: 'STOCK' },
        ];
        if (!args.where?.account_type) return Promise.resolve(all);
        return Promise.resolve(
            all.filter(a => a.account_type === 'STOCK').map(a => ({
                ...a,
                commodity_guid: AAPL,
                commodity: { guid: AAPL, mnemonic: 'AAPL', fullname: 'Apple Inc.' },
            })),
        );
    });
    prismaMock.splits.findMany.mockResolvedValue([]);
    getAccountHoldingsMock.mockImplementation(async (guid: string) => HOLDINGS[guid]);
});

async function portfolio(): Promise<Body> {
    const response = await GET(new Request('http://localhost/api/investments/portfolio')) as unknown as Response;
    expect(response.status).toBe(200);
    return await response.json() as Body;
}

describe('portfolio route — cost-basis coverage', () => {
    it('carries each holding’s coverage instead of dropping it', async () => {
        const body = await portfolio();
        const partial = body.holdings.find(h => h.accountGuid === BROKER_A)!;
        const complete = body.holdings.find(h => h.accountGuid === BROKER_B)!;

        expect(partial.costBasis).toBe(3_500);
        expect(partial.costBasisCoverage).toEqual({
            status: 'partial', coveredShares: 150, uncoveredShares: 50,
            warnings: ['50 share(s) transferred in have no traceable cost basis in this book.'],
        });
        // The gain is the covered shares' $4,000, not $10,000 - $3,500 = $6,500.
        expect(partial.gainLoss).toBe(4_000);
        expect(complete.costBasisCoverage).toEqual({ status: 'complete', coveredShares: 100 });
    });

    it('pools coverage into the consolidated row and its total gain', async () => {
        const body = await portfolio();
        const [consolidated] = body.consolidatedHoldings;

        expect(consolidated.totalCostBasis).toBe(5_500);
        expect(consolidated.totalCostBasisCoverage).toMatchObject({
            status: 'partial', coveredShares: 250, uncoveredShares: 50,
        });
        // $4,000 + $3,000. Recomputing totalMarketValue - totalCostBasis would
        // give $15,000 - $5,500 = $9,500, putting the 50 uncovered shares'
        // $2,500 of market value straight back into the total.
        expect(consolidated.totalGainLoss).toBe(7_000);
        expect(consolidated.totalMarketValue).toBe(15_000);
        expect(consolidated.accounts.map(a => a.costBasisCoverage.status)).toEqual(['partial', 'complete']);
    });

    it('makes the portfolio summary carry the pooled coverage too', async () => {
        const body = await portfolio();
        expect(body.summary.totalCostBasis).toBe(5_500);
        expect(body.summary.totalGainLoss).toBe(7_000);
        expect(body.summary.totalCostBasisCoverage).toMatchObject({
            status: 'partial', uncoveredShares: 50,
        });
    });

    it('leaves a fully covered portfolio reporting exactly as before', async () => {
        getAccountHoldingsMock.mockImplementation(async (guid: string) => ({
            ...HOLDINGS[guid],
            ...(guid === BROKER_A
                ? {
                    costBasis: 6_000,
                    costBasisCoverage: { status: 'complete', coveredShares: 200 },
                    gainLoss: 4_000,
                }
                : {}),
        }));

        const body = await portfolio();
        expect(body.summary.totalCostBasis).toBe(8_000);
        expect(body.summary.totalGainLoss).toBe(7_000);
        expect(body.summary.totalCostBasisCoverage).toEqual({ status: 'complete', coveredShares: 300 });
        // Nothing for the table to caveat: no uncovered count exists to read.
        expect('uncoveredShares' in body.summary.totalCostBasisCoverage).toBe(false);
    });
});
