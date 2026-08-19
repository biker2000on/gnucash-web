import { describe, it, expect } from 'vitest';
import {
    DEFAULT_QTY_EPSILON,
    MONEY_DISPLAY_EPSILON,
    QTY_REL_EPSILON,
    moneyEpsilonForScu,
    qtyEpsilonForScu,
    qtyEpsilonWithMagnitude,
} from '../tolerances';
import { DEFAULT_QTY_EPSILON as LOT_SCRUB_QTY_EPSILON, qtyEpsilonForScu as lotScrubQtyEpsilon } from '../lot-scrub';

describe('money tolerances', () => {
    it('treats a whole cent as a real difference, not as agreement', () => {
        expect(Math.abs(0.01)).toBeGreaterThan(MONEY_DISPLAY_EPSILON);
        expect(Math.abs(0.001)).toBeLessThan(MONEY_DISPLAY_EPSILON);
    });

    it('scales with the currency: JPY-like scu 1 tolerates half a yen, USD half a cent', () => {
        expect(moneyEpsilonForScu(1)).toBe(0.5);
        expect(moneyEpsilonForScu(100)).toBe(MONEY_DISPLAY_EPSILON);
        expect(moneyEpsilonForScu(1000)).toBe(0.0005);
    });

    it('falls back to the half-cent default on a missing or nonsensical scu', () => {
        expect(moneyEpsilonForScu(null)).toBe(MONEY_DISPLAY_EPSILON);
        expect(moneyEpsilonForScu(0)).toBe(MONEY_DISPLAY_EPSILON);
        expect(moneyEpsilonForScu(-100)).toBe(MONEY_DISPLAY_EPSILON);
        expect(moneyEpsilonForScu(Number.NaN)).toBe(MONEY_DISPLAY_EPSILON);
    });

    it('is imported by the reconcile engine rather than aliased there', async () => {
        // statement-reconcile.ts used to re-export it twice under local names
        // (AMOUNT_EPSILON, TIE_OUT_EPSILON). Two extra names for one number is
        // two more things to keep in step, and a reader has to chase both to
        // learn they are the same half-cent.
        const reconcile = await import('../statement-reconcile');
        expect(reconcile).not.toHaveProperty('AMOUNT_EPSILON');
        expect(reconcile).not.toHaveProperty('TIE_OUT_EPSILON');
    });
});

describe('quantity tolerances', () => {
    it('keeps the legacy bound for coarse-scu stocks and tightens for crypto', () => {
        expect(qtyEpsilonForScu(100)).toBe(DEFAULT_QTY_EPSILON);
        expect(qtyEpsilonForScu(10_000)).toBeCloseTo(0.5 / 10_000, 15);
        expect(qtyEpsilonForScu(100_000_000)).toBeCloseTo(0.5 / 100_000_000, 15);
        expect(qtyEpsilonForScu(null)).toBe(DEFAULT_QTY_EPSILON);
    });

    it('is the same function lot-scrub re-exports (one definition, two import sites)', () => {
        expect(LOT_SCRUB_QTY_EPSILON).toBe(DEFAULT_QTY_EPSILON);
        expect(lotScrubQtyEpsilon).toBe(qtyEpsilonForScu);
    });

    describe('qtyEpsilonWithMagnitude', () => {
        it('keeps the absolute floor for small positions', () => {
            expect(qtyEpsilonWithMagnitude(100, 0)).toBe(DEFAULT_QTY_EPSILON);
            expect(qtyEpsilonWithMagnitude(100, 12.5)).toBe(DEFAULT_QTY_EPSILON);
            expect(qtyEpsilonWithMagnitude(100_000_000, 0.001))
                .toBeCloseTo(0.5 / 100_000_000, 15);
        });

        it('grows with the magnitude once the relative term dominates', () => {
            expect(qtyEpsilonWithMagnitude(100, 1e9)).toBeCloseTo(1e9 * QTY_REL_EPSILON, 12);
            // Sign of the magnitude is irrelevant — only its scale.
            expect(qtyEpsilonWithMagnitude(100, -1e9)).toBe(qtyEpsilonWithMagnitude(100, 1e9));
        });

        it('ignores a non-finite magnitude rather than returning NaN', () => {
            expect(qtyEpsilonWithMagnitude(100, Number.NaN)).toBe(DEFAULT_QTY_EPSILON);
            expect(qtyEpsilonWithMagnitude(100, Number.POSITIVE_INFINITY)).toBe(DEFAULT_QTY_EPSILON);
        });

        /**
         * The regression the relative term exists for: two independent float
         * sums over the same long sequence of large share lots drift apart by
         * more than the absolute epsilon, and an absolute-only comparison
         * declares a perfectly consistent account's coverage "unknown".
         */
        it('absorbs the float residue of a long large-share replay that the absolute bound would not', () => {
            // A token held at commodity_scu 1e8 — where the absolute epsilon
            // is 0.5/1e8 — with 60,000 lots making up an 8-million-unit
            // position. Both numbers are ordinary; the residue is not.
            const scu = 100_000_000;
            const lots = Array.from({ length: 60_000 }, (_, i) => 137.37 + (i % 7) * 0.01);

            let balance = 0;
            for (const q of lots) balance += q;

            // The same shares summed in a different (but equally valid) order:
            // exactly the situation of a share balance versus a cost-basis
            // pool that accumulates covered and uncovered shares separately.
            let poolCovered = 0;
            let poolUncovered = 0;
            lots.forEach((q, i) => {
                if (i % 2 === 0) poolCovered += q;
                else poolUncovered += q;
            });
            const poolShares = poolCovered + poolUncovered;

            const drift = Math.abs(balance - poolShares);

            // The regression: an absolute epsilon calls this consistent
            // account inconsistent, and coverage is reported as unknown.
            expect(drift).toBeGreaterThan(qtyEpsilonForScu(scu));

            // The fix: the magnitude-scaled epsilon absorbs it.
            expect(drift).toBeLessThan(
                qtyEpsilonWithMagnitude(scu, Math.max(balance, poolShares)),
            );
        });

        it('still flags a real one-unit oversell at crypto precision', () => {
            const scu = 100_000_000;
            // Below the crossover magnitude (qtyEpsilonForScu(scu) / REL_EPS,
            // here 5 units) the absolute floor governs, so the smallest
            // representable disagreement is still caught.
            const balance = 2.503_912_44;
            const pool = balance - 1 / scu;
            expect(qtyEpsilonWithMagnitude(scu, balance)).toBe(qtyEpsilonForScu(scu));
            expect(Math.abs(balance - pool)).toBeGreaterThanOrEqual(
                qtyEpsilonWithMagnitude(scu, balance),
            );
        });

        it('names its crossover magnitude explicitly', () => {
            // The scale above which the relative term, not the commodity's
            // scu, sets the tolerance. Stated as a test so a future change to
            // QTY_REL_EPSILON has to confront what it costs in sensitivity.
            const crossover = (scu: number) => qtyEpsilonForScu(scu) / QTY_REL_EPSILON;
            expect(crossover(100)).toBeCloseTo(100_000, 0);          // 100k shares
            expect(crossover(100_000_000)).toBeCloseTo(5, 6);        // 5 coins
        });
    });
});
