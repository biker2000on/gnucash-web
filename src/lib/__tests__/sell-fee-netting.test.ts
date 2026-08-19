/**
 * The sell planner and the rebalancer must quote gains NET of brokerage
 * commissions, like Form 8949 and the Investment Lots report.
 *
 * Both loaders called `getAccountLots(guid)` once per account with no options.
 * Two things were wrong with that. `getLotsForAccounts` — which `getAccountLots`
 * delegates to — defaulted `includeTradeFees` to false, so a per-account call
 * that looked netted was not; and no `accountPaths` were supplied, so even when
 * fees were recovered the allocator fell back to the bare account name and could
 * classify the same charge differently from the 8949 path. A sell plan quoting a
 * gross gain tells the user a tax bill they will not actually owe.
 *
 * These tests assert the CALL (batched, netted, path-classified, warnings
 * threaded) and the FIGURE that reaches the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LotSummary } from '@/lib/lots';

const { prismaMock, lotsMock, utilsMock, classifierMock } = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findMany: vi.fn() },
        $queryRaw: vi.fn(),
    },
    lotsMock: { getLotsForAccounts: vi.fn() },
    utilsMock: { buildAccountPathMap: vi.fn() },
    classifierMock: { getRetirementAccountGuids: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/reports/utils', () => utilsMock);
vi.mock('./reports/utils', () => utilsMock);
vi.mock('@/lib/reports/contribution-classifier', () => classifierMock);

// Only the loader is stubbed; remainingCostBasis stays real, because the basis
// a candidate reports is the thing under test.
vi.mock('@/lib/lots', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/lots')>();
    return { ...actual, ...lotsMock };
});
vi.mock('./lots', async () => {
    const actual = await vi.importActual<typeof import('@/lib/lots')>('@/lib/lots');
    return { ...actual, ...lotsMock };
});

const BOOK_GUIDS = ['acct-vti', 'acct-vxus', 'expense-commission'];

/** An open lot of `shares` whose basis is already NET of `tradeFees`. */
function openLot(overrides: Partial<LotSummary> = {}): LotSummary {
    return {
        guid: 'lot-1',
        accountGuid: 'acct-vti',
        isClosed: false,
        title: 'Lot 1',
        openDate: '2024-02-01',
        closeDate: null,
        totalShares: 100,
        // 100 @ $10 plus a $25 commission capitalized into basis.
        totalCost: 1_025,
        realizedGain: 0,
        unrealizedGain: 175,
        holdingPeriod: 'long_term',
        currentPrice: 12,
        sourceLotGuid: null,
        acquisitionDate: '2024-02-01',
        carriedBasis: 0,
        averageBasisRemaining: null,
        tradeFees: 25,
        splits: [],
        ...overrides,
    } as LotSummary;
}

beforeEach(() => {
    vi.clearAllMocks();
    utilsMock.buildAccountPathMap.mockResolvedValue(
        new Map([
            ['acct-vti', 'Assets:Brokerage:VTI'],
            ['expense-commission', 'Expenses:Investment:Commissions'],
        ]),
    );
    classifierMock.getRetirementAccountGuids.mockResolvedValue(new Set<string>());
});

describe('loadSellCandidates — fee netting', () => {
    beforeEach(() => {
        prismaMock.accounts.findMany.mockResolvedValue([
            { guid: 'acct-vti', name: 'VTI', commodity: { mnemonic: 'VTI' } },
            { guid: 'acct-vxus', name: 'VXUS', commodity: { mnemonic: 'VXUS' } },
        ]);
        // First $queryRaw is the account_hierarchy path lookup; the second is
        // the wash-sale recent-buy sweep.
        prismaMock.$queryRaw
            .mockResolvedValueOnce([
                { guid: 'acct-vti', fullname: 'Assets:Brokerage:VTI' },
                { guid: 'acct-vxus', fullname: 'Assets:Brokerage:VXUS' },
            ])
            .mockResolvedValue([]);
    });

    it('loads every account in ONE netted, path-classified call', async () => {
        lotsMock.getLotsForAccounts.mockResolvedValue(
            new Map([['acct-vti', [openLot()]], ['acct-vxus', []]]),
        );

        const { loadSellCandidates } = await import('@/lib/sell-planner');
        await loadSellCandidates(BOOK_GUIDS);

        expect(lotsMock.getLotsForAccounts).toHaveBeenCalledTimes(1);
        const [guids, options] = lotsMock.getLotsForAccounts.mock.calls[0];
        expect(guids).toEqual(['acct-vti', 'acct-vxus']);
        expect(options.includeTradeFees).toBe(true);
        // Paths cover the WHOLE book: the charge sits on an EXPENSE account,
        // which a map of just the holdings would never contain.
        expect(utilsMock.buildAccountPathMap).toHaveBeenCalledWith(BOOK_GUIDS);
        expect(options.accountPaths.get('expense-commission'))
            .toBe('Expenses:Investment:Commissions');
        expect(Array.isArray(options.feeWarnings)).toBe(true);
    });

    it('reports the NET basis on the candidate, commission included', async () => {
        lotsMock.getLotsForAccounts.mockResolvedValue(
            new Map([['acct-vti', [openLot()]], ['acct-vxus', []]]),
        );

        const { loadSellCandidates } = await import('@/lib/sell-planner');
        const book = await loadSellCandidates(BOOK_GUIDS);

        expect(book.candidates).toHaveLength(1);
        // $1,000 of shares + the $25 commission, not the gross $1,000.
        expect(book.candidates[0].costBasis).toBeCloseTo(1_025, 6);
        // Which is the whole point: the taxable gain is $175, not $200.
        expect(book.candidates[0].shares * book.candidates[0].price
            - book.candidates[0].costBasis).toBeCloseTo(175, 6);
    });

    it('surfaces charges the allocator refused to capitalize', async () => {
        lotsMock.getLotsForAccounts.mockImplementation(async (_guids, options) => {
            options.feeWarnings?.push('Unclassified charge on 2026-01-05: $12.00');
            return new Map([['acct-vti', [openLot()]], ['acct-vxus', []]]);
        });

        const { loadSellCandidates } = await import('@/lib/sell-planner');
        const book = await loadSellCandidates(BOOK_GUIDS);

        expect(book.feeWarnings).toEqual(['Unclassified charge on 2026-01-05: $12.00']);
    });
});

describe('loadSellCandidatesBySymbol — fee netting', () => {
    it('batches every symbol into one netted, path-classified call', async () => {
        lotsMock.getLotsForAccounts.mockResolvedValue(
            new Map([
                ['acct-vti', [openLot()]],
                ['acct-vxus', [openLot({ guid: 'lot-2', accountGuid: 'acct-vxus' })]],
            ]),
        );

        const { loadSellCandidatesBySymbol } = await import('@/lib/rebalancing');
        const feeWarnings: string[] = [];
        const byKey = await loadSellCandidatesBySymbol(
            {
                VTI: [{ guid: 'acct-vti', name: 'VTI' }],
                VXUS: [{ guid: 'acct-vxus', name: 'VXUS' }],
            },
            { bookAccountGuids: BOOK_GUIDS, feeWarnings },
        );

        expect(lotsMock.getLotsForAccounts).toHaveBeenCalledTimes(1);
        const [guids, options] = lotsMock.getLotsForAccounts.mock.calls[0];
        expect(guids).toEqual(['acct-vti', 'acct-vxus']);
        expect(options.includeTradeFees).toBe(true);
        expect(options.accountPaths.get('expense-commission'))
            .toBe('Expenses:Investment:Commissions');
        expect(options.feeWarnings).toBe(feeWarnings);

        // The annotated gain a SELL suggestion shows is the netted one.
        expect(byKey.VTI[0].unrealizedGain).toBeCloseTo(175, 6);
        expect(byKey.VXUS[0].unrealizedGain).toBeCloseTo(175, 6);
    });

    it('does not re-run the allocation per account', async () => {
        lotsMock.getLotsForAccounts.mockResolvedValue(
            new Map([['acct-vti', [openLot()]], ['acct-vxus', []]]),
        );

        const { loadSellCandidatesBySymbol } = await import('@/lib/rebalancing');
        await loadSellCandidatesBySymbol({
            VTI: [{ guid: 'acct-vti' }, { guid: 'acct-vxus' }],
        });

        expect(lotsMock.getLotsForAccounts).toHaveBeenCalledTimes(1);
        expect(utilsMock.buildAccountPathMap).toHaveBeenCalledTimes(1);
    });
});
