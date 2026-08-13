/**
 * Regression: Monte Carlo contributions are documented as REAL (today's
 * dollar) amounts, like expenses. The engine used to inflate withdrawals but
 * add contributions as a bare nominal number, so every contribution silently
 * lost purchasing power as the simulation ran.
 *
 * Worked case: $30k/yr real for 30 years at 0% REAL return (3% nominal
 * return, 3% inflation) must end at $900k real. The bug produced ~$588k —
 * the same contributions discounted at 3%/yr.
 */

import { describe, expect, it } from 'vitest';
import { runMonteCarlo, type MonteCarloInputs } from '@/lib/fire/monte-carlo';

// Real return is exactly zero (nominal return == inflation), so the real
// portfolio value is just the sum of the real contributions made so far.
const realZeroReturn: MonteCarloInputs = {
    currentSavings: 0,
    annualContribution: 30_000,
    contributionGrowthPct: 0,
    annualExpenses: 40_000,
    safeWithdrawalRate: 4,
    currentAge: 30,
    retirementAge: 60,
    endAge: 60, // accumulation only
    stockAllocationPct: 100,
    returnMode: 'fixed',
    fixedReturnPct: 3,
    inflationMode: 'fixed',
    fixedInflationPct: 3,
    numSimulations: 10,
    seed: 5,
};

describe('Monte Carlo contributions are real dollars', () => {
    it('accumulates 30 x $30k real to $900k, not the ~$588k the bug produced', () => {
        const res = runMonteCarlo(realZeroReturn);
        const terminal = res.years[res.years.length - 1];
        expect(terminal.yearIndex).toBe(30);
        expect(terminal.p50).toBeCloseTo(900_000, 4);
        // The pre-fix behavior (bare nominal contribution) landed here.
        expect(terminal.p50).toBeGreaterThan(700_000);
    });

    it('a year-20 contribution adds the same real dollars as a year-1 contribution', () => {
        const res = runMonteCarlo(realZeroReturn);
        const realAdded = (yearIndex: number) =>
            res.years[yearIndex].p50 - res.years[yearIndex - 1].p50;
        expect(realAdded(1)).toBeCloseTo(30_000, 4);
        expect(realAdded(20)).toBeCloseTo(30_000, 4);
        expect(realAdded(30)).toBeCloseTo(30_000, 4);
    });

    it('contributionGrowthPct still compounds as a REAL raise on top of inflation', () => {
        const res = runMonteCarlo({ ...realZeroReturn, contributionGrowthPct: 2 });
        const realAdded = (yearIndex: number) =>
            res.years[yearIndex].p50 - res.years[yearIndex - 1].p50;
        // Year 1 contributes the stated real amount; year 21 contributes the
        // stated amount grown by 20 years of 2% REAL raises (not 2% + 3%).
        expect(realAdded(1)).toBeCloseTo(30_000, 4);
        expect(realAdded(21)).toBeCloseTo(30_000 * Math.pow(1.02, 20), 3);
    });

    it('leaves the zero-inflation closed form untouched', () => {
        const res = runMonteCarlo({
            ...realZeroReturn,
            currentSavings: 100_000,
            annualContribution: 10_000,
            fixedReturnPct: 7,
            fixedInflationPct: 0,
        });
        const r = 0.07;
        for (let n = 0; n < res.years.length; n++) {
            const g = Math.pow(1 + r, n);
            expect(res.years[n].p50).toBeCloseTo(100_000 * g + 10_000 * ((g - 1) / r), 4);
        }
    });
});
