/**
 * The cost-basis pool as a SIGNED position.
 *
 * Selling more shares than the pool holds used to be clamped away: the basis
 * drained to ~0 and every consumer was told coverage was unknown, so a real
 * short position rendered as "$0 basis, coverage unknown". The pool now keeps a
 * short leg whose "basis" is the proceeds received for the shorted shares.
 *
 * These are exact-number tests. A short position's arithmetic is the mirror of
 * a long one's, and a sign error in it reads as a plausible number, so the
 * assertions pin the values rather than their direction.
 */
import { describe, it, expect, vi } from 'vitest';

// cost-basis.ts imports prisma at module load for its tracing paths; the pool
// helpers under test never touch it.
vi.mock('../prisma', () => ({
    default: {
        splits: { findUnique: vi.fn(), findMany: vi.fn() },
        slots: { findFirst: vi.fn() },
    },
}));

import {
    createCostBasisPool,
    addPurchaseToPool,
    removeSharesFromPool,
    poolPositionSide,
    poolNetShares,
    poolPerShareCost,
    drawFromPool,
    addTracedTransferToPool,
    reportPool,
    type CostBasisResult,
} from '../cost-basis';

/** A fully-traced transfer-in of `shares` carrying `basis`. */
function tracedIn(shares: number, basis: number, uncovered = 0): CostBasisResult {
    return {
        coveredShares: shares - uncovered,
        uncoveredShares: uncovered,
        basisOfCoveredShares: basis,
        perShareCost: shares - uncovered > 0 ? basis / (shares - uncovered) : 0,
        method: 'fifo',
    };
}

describe('CostBasisPool — long positions are untouched', () => {
    it('a buy and a partial sale behave exactly as before', () => {
        const pool = createCostBasisPool();
        addPurchaseToPool(pool, 100, 1_000); // $10/share
        removeSharesFromPool(pool, 40, 3_200);

        expect(pool.coveredShares).toBeCloseTo(60, 9);
        expect(pool.basisOfCoveredShares).toBeCloseTo(600, 9);
        expect(poolPerShareCost(pool)).toBeCloseTo(10, 9);
        // No short leg is opened by a sale the pool can satisfy.
        expect(pool.shortShares).toBe(0);
        expect(pool.shortProceeds).toBe(0);
        expect(pool.shortProceedsIncomplete).toBe(false);
        expect(poolPositionSide(pool)).toBe('long');
        expect(poolNetShares(pool)).toBeCloseTo(60, 9);
    });

    it('a sale that closes the position exactly leaves it flat, not short', () => {
        const pool = createCostBasisPool();
        addPurchaseToPool(pool, 100, 1_000);
        removeSharesFromPool(pool, 100, 8_000);

        expect(pool.shortShares).toBe(0);
        expect(poolPositionSide(pool)).toBe('flat');
        expect(poolNetShares(pool)).toBeCloseTo(0, 9);
    });
});

describe('CostBasisPool — long to short to covered to long', () => {
    it('walks the full cycle with the exact proceeds and basis at each step', () => {
        const pool = createCostBasisPool();

        // 1. Buy 100 @ $10.
        addPurchaseToPool(pool, 100, 1_000);
        expect(poolPositionSide(pool)).toBe('long');

        // 2. Sell 150 @ $80 = $12,000. 100 close the long; 50 are sold SHORT,
        //    and only their $4,000 slice of the proceeds belongs to the short.
        removeSharesFromPool(pool, 150, 12_000);
        expect(poolPositionSide(pool)).toBe('short');
        expect(pool.shortShares).toBeCloseTo(50, 9);
        expect(pool.shortProceeds).toBeCloseTo(4_000, 9);
        expect(pool.shortProceedsIncomplete).toBe(false);
        // The long side is emptied, not left holding a phantom basis.
        expect(pool.coveredShares).toBeCloseTo(0, 9);
        expect(pool.uncoveredShares).toBeCloseTo(0, 9);
        expect(pool.basisOfCoveredShares).toBeCloseTo(0, 9);
        expect(poolNetShares(pool)).toBeCloseTo(-50, 9);

        // 3. Buy 30 @ $60 = $1,800: a PARTIAL cover. 30 of the 50 short shares
        //    are retired along with 30/50 of the proceeds, leaving the rest of
        //    the short leg at its own $80 average. No long parcel opens.
        addPurchaseToPool(pool, 30, 1_800);
        expect(poolPositionSide(pool)).toBe('short');
        expect(pool.shortShares).toBeCloseTo(20, 9);
        expect(pool.shortProceeds).toBeCloseTo(1_600, 9);
        expect(pool.coveredShares).toBeCloseTo(0, 9);
        expect(poolNetShares(pool)).toBeCloseTo(-20, 9);

        // 4. Buy 50 @ $60 = $3,000: covers the remaining 20 and opens a 30-share
        //    long at the same $60. The short leg is released entirely.
        addPurchaseToPool(pool, 50, 3_000);
        expect(poolPositionSide(pool)).toBe('long');
        expect(pool.shortShares).toBe(0);
        expect(pool.shortProceeds).toBe(0);
        expect(pool.coveredShares).toBeCloseTo(30, 9);
        expect(pool.basisOfCoveredShares).toBeCloseTo(1_800, 9);
        expect(poolPerShareCost(pool)).toBeCloseTo(60, 9);
        expect(poolNetShares(pool)).toBeCloseTo(30, 9);
    });

    it('an opening short sale takes all of its own proceeds', () => {
        const pool = createCostBasisPool();
        // Nothing held; sell 100 @ $50. Every share is short.
        removeSharesFromPool(pool, 100, 5_000);

        expect(pool.shortShares).toBeCloseTo(100, 9);
        expect(pool.shortProceeds).toBeCloseTo(5_000, 9);
        expect(poolNetShares(pool)).toBeCloseTo(-100, 9);
        // Unrealized result at $30: proceeds 5,000 - cover cost 3,000 = +2,000.
        expect(pool.shortProceeds - 100 * 30).toBeCloseTo(2_000, 9);
        // ...and at $70 the short is under water by 2,000.
        expect(pool.shortProceeds - 100 * 70).toBeCloseTo(-2_000, 9);
    });

    it('extends an existing short rather than restarting it', () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 100, 5_000);
        removeSharesFromPool(pool, 50, 3_000);

        expect(pool.shortShares).toBeCloseTo(150, 9);
        expect(pool.shortProceeds).toBeCloseTo(8_000, 9);
    });
});

describe('CostBasisPool — a short leg with unreadable proceeds', () => {
    it('records the shares, refuses to invent a $0 basis, and says so', () => {
        const pool = createCostBasisPool();
        addPurchaseToPool(pool, 10, 100);
        removeSharesFromPool(pool, 30); // no proceeds supplied

        expect(pool.shortShares).toBeCloseTo(20, 9);
        expect(pool.shortProceeds).toBe(0);
        // The flag is the whole point: a 0 here is "we do not know", and every
        // consumer must degrade coverage rather than print it as a real zero.
        expect(pool.shortProceedsIncomplete).toBe(true);
        expect(pool.warnings.join(' ')).toContain('sold short without readable proceeds');
    });

    it('clears the flag once the short is fully covered', () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 20);
        addPurchaseToPool(pool, 20, 1_000);

        expect(pool.shortShares).toBe(0);
        expect(pool.shortProceedsIncomplete).toBe(false);
        expect(poolPositionSide(pool)).toBe('flat');
    });
});

describe('CostBasisPool — drawing from a short pool', () => {
    it('hands out no basis: an obligation cannot be passed on with one', () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 100, 5_000);

        const drawn = drawFromPool(pool, 10, 'average');
        expect(drawn.coveredShares).toBeCloseTo(0, 9);
        expect(drawn.uncoveredShares).toBeCloseTo(10, 9);
        expect(drawn.basisOfCoveredShares).toBeCloseTo(0, 9);
        expect(drawn.warnings?.join(' ')).toContain('exceed the traced history');
    });
});

describe('CostBasisPool — a traced transfer-in lands on a short leg', () => {
    /**
     * The defect: only addPurchaseToPool retired a short. Shares arriving by
     * in-kind transfer were added straight to the long side, leaving the pool
     * simultaneously 150 long and 100 short — net 50 by arithmetic, but
     * reporting a 150-share basis against a 50-share position and a phantom
     * short leg with proceeds still attached.
     */
    it('retires the short first, keeping only the surplus as a long parcel', () => {
        const pool = createCostBasisPool();
        // Short 100 for $5,000.
        removeSharesFromPool(pool, 100, 5_000);
        expect(poolPositionSide(pool)).toBe('short');

        // Transfer in 150 shares carrying $6,000 of traced basis.
        addTracedTransferToPool(pool, tracedIn(150, 6_000));

        expect(poolPositionSide(pool)).toBe('long');
        expect(poolNetShares(pool)).toBeCloseTo(50, 9);
        expect(pool.coveredShares).toBeCloseTo(50, 9);
        // 50 of the 150 shares survived, so 50/150 of the basis came with them.
        expect(pool.basisOfCoveredShares).toBeCloseTo(2_000, 9);
        expect(poolPerShareCost(pool)).toBeCloseTo(40, 9);
        // The short leg is gone, proceeds and all.
        expect(pool.shortShares).toBe(0);
        expect(pool.shortProceeds).toBe(0);
        expect(pool.shortProceedsIncomplete).toBe(false);
    });

    it('a smaller transfer covers part of the short and opens no long', () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 100, 5_000);

        addTracedTransferToPool(pool, tracedIn(40, 1_200));

        expect(poolPositionSide(pool)).toBe('short');
        expect(pool.shortShares).toBeCloseTo(60, 9);
        // 60/100 of the proceeds stay with the surviving short leg.
        expect(pool.shortProceeds).toBeCloseTo(3_000, 9);
        expect(pool.coveredShares).toBeCloseTo(0, 9);
        expect(pool.uncoveredShares).toBeCloseTo(0, 9);
        expect(pool.basisOfCoveredShares).toBeCloseTo(0, 9);
    });

    it('an exact cover leaves the pool flat', () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 100, 5_000);

        addTracedTransferToPool(pool, tracedIn(100, 4_000));

        expect(poolPositionSide(pool)).toBe('flat');
        expect(pool.shortShares).toBe(0);
        expect(pool.coveredShares).toBeCloseTo(0, 9);
        expect(pool.basisOfCoveredShares).toBeCloseTo(0, 9);
    });

    it("prorates the surviving parcel COVERAGE split, not just its basis", () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 60, 3_000);

        // 120 shares in, of which 40 have no traceable basis (2/3 covered).
        addTracedTransferToPool(pool, tracedIn(120, 4_000, 40));

        // 60 shares survive; they stay 2/3 covered rather than being laundered.
        expect(pool.coveredShares).toBeCloseTo(40, 9);
        expect(pool.uncoveredShares).toBeCloseTo(20, 9);
        expect(pool.basisOfCoveredShares).toBeCloseTo(2_000, 9);
        expect(pool.shortShares).toBe(0);
    });

    it('leaves a long pool completely alone', () => {
        const pool = createCostBasisPool();
        addPurchaseToPool(pool, 100, 1_000);
        addTracedTransferToPool(pool, tracedIn(50, 900, 10));

        expect(pool.coveredShares).toBeCloseTo(140, 9);
        expect(pool.uncoveredShares).toBeCloseTo(10, 9);
        expect(pool.basisOfCoveredShares).toBeCloseTo(1_900, 9);
    });
});

describe('reportPool', () => {
    it('reports a long pool as paid basis with its uncovered shares', () => {
        const pool = createCostBasisPool();
        addPurchaseToPool(pool, 100, 1_000);
        addTracedTransferToPool(pool, tracedIn(20, 0, 20));

        expect(reportPool(pool)).toEqual({
            side: 'long',
            costBasis: 1_000,
            uncoveredShares: 20,
            coverageKnowable: true,
        });
    });

    it("reports a short pool's PROCEEDS as its basis, with no uncovered shares", () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 100, 5_000);

        expect(reportPool(pool)).toEqual({
            side: 'short',
            costBasis: 5_000,
            uncoveredShares: 0,
            coverageKnowable: true,
        });
    });

    it('marks coverage unknowable when a short opened without readable proceeds', () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 100);

        const report = reportPool(pool);
        expect(report.side).toBe('short');
        expect(report.coverageKnowable).toBe(false);
    });

    it('honours the caller share tolerance when deciding the side', () => {
        const pool = createCostBasisPool();
        removeSharesFromPool(pool, 1e-6, 0.01);

        // A dust short under the tolerance is flat, not short.
        expect(reportPool(pool, 1e-4).side).toBe('flat');
        expect(reportPool(pool, 1e-9).side).toBe('short');
    });
});
