import { describe, it, expect } from 'vitest';
import {
  splitBookTaxData,
  compareFilingStatuses,
  runComparisonAt,
  runBreakevenSweep,
  findCrossovers,
  normalizeAllocation,
  DEFAULT_ALLOCATION,
  type AccountOwner,
  type FilingAllocationConfig,
  type FilingComparisonParams,
  type SweepPoint,
} from '@/lib/tax/filing-comparison';
import { buildFederalInputsFromBookData, applyHouseholdTaxDetails } from '@/lib/tax/estimator-inputs';
import { computeFederalTax } from '@/lib/tax/federal';
import type { BookTaxData, CategoryAggregate, TaxCategory } from '@/lib/tax/types';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function acct(guid: string, amount: number) {
  return { accountGuid: guid, accountName: guid, accountPath: `Root:${guid}`, amount };
}

function cat(category: TaxCategory, accounts: Array<{ guid: string; amount: number }>): CategoryAggregate {
  return {
    category,
    total: Math.round(accounts.reduce((s, a) => s + a.amount, 0) * 100) / 100,
    accounts: accounts.map(a => acct(a.guid, a.amount)),
  };
}

function makeBookData(overrides: Partial<BookTaxData> = {}): BookTaxData {
  return {
    year: 2025,
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    asOfDate: '2025-12-31',
    elapsedYearFraction: 1,
    categories: [],
    realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] },
    contributionsByType: {},
    contributionsByTypeAndOwner: {},
    flaggedRetirementTypes: [],
    mappedAccountCount: 0,
    ...overrides,
  };
}

function makeParams(
  bookData: BookTaxData,
  ownerByAccount: Record<string, AccountOwner> = {},
  allocation: FilingAllocationConfig = DEFAULT_ALLOCATION,
  extra: Partial<FilingComparisonParams> = {},
): FilingComparisonParams {
  return {
    bookData,
    ownerByAccount,
    allocation,
    year: 2025,
    jointFilingStatus: 'mfj',
    factor: 1,
    dependentsUnder17: 0,
    self: { age65: false, coveredByEmployerPlan: false, iraLimit: null },
    spouse: { age65: false, coveredByEmployerPlan: false, iraLimit: null },
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Allocation attribution                                              */
/* ------------------------------------------------------------------ */

describe('splitBookTaxData attribution', () => {
  const bookData = makeBookData({
    categories: [
      cat('w2_wages', [
        { guid: 'wage-self', amount: 90_000 },  // payslip owner: self
        { guid: 'wage-spouse', amount: 40_000 }, // payslip owner: spouse
      ]),
      cat('federal_withholding', [
        { guid: 'wh-self', amount: 12_000 },
        { guid: 'wh-spouse', amount: 3_000 },
      ]),
      cat('interest_income', [
        { guid: 'joint-savings', amount: 1_000 }, // no owner → residual
      ]),
      cat('ordinary_dividends', [
        { guid: 'brokerage-spouse', amount: 5_000 }, // roster-linked to spouse
      ]),
      cat('charitable_donation', [
        { guid: 'charity', amount: 8_000 }, // unattributed deduction
      ]),
    ],
    realizedGains: {
      shortTerm: 2_000,
      longTerm: 10_000,
      accounts: [
        { accountGuid: 'brokerage-spouse', accountName: 'b', accountPath: 'p', shortTerm: 2_000, longTerm: 6_000 },
        { accountGuid: 'joint-brokerage', accountName: 'j', accountPath: 'p', shortTerm: 0, longTerm: 4_000 },
      ],
    },
  });
  const owners: Record<string, AccountOwner> = {
    'wage-self': 'self',
    'wage-spouse': 'spouse',
    'wh-self': 'self',
    'wh-spouse': 'spouse',
    'brokerage-spouse': 'spouse',
    'joint-brokerage': 'joint',
  };

  it('routes payslip-owned wage and withholding accounts to the right spouse', () => {
    const split = splitBookTaxData(bookData, owners, DEFAULT_ALLOCATION);
    const wages = (d: BookTaxData) => d.categories.find(c => c.category === 'w2_wages')!.total;
    const wh = (d: BookTaxData) => d.categories.find(c => c.category === 'federal_withholding')!.total;
    expect(wages(split.self)).toBe(90_000);
    expect(wages(split.spouse)).toBe(40_000);
    expect(wh(split.self)).toBe(12_000);
    expect(wh(split.spouse)).toBe(3_000);
  });

  it('routes roster-linked investment income and gains by account owner', () => {
    const split = splitBookTaxData(bookData, owners, DEFAULT_ALLOCATION);
    const div = (d: BookTaxData) => d.categories.find(c => c.category === 'ordinary_dividends')?.total ?? 0;
    expect(div(split.self)).toBe(0);
    expect(div(split.spouse)).toBe(5_000);
    // spouse-owned gains stay whole; joint gains split 50/50
    expect(split.spouse.realizedGains.shortTerm).toBe(2_000);
    expect(split.spouse.realizedGains.longTerm).toBe(6_000 + 2_000);
    expect(split.self.realizedGains.longTerm).toBe(2_000);
  });

  it('splits unattributed amounts by the residual percentage (default 50/50)', () => {
    const split = splitBookTaxData(bookData, owners, DEFAULT_ALLOCATION);
    const interest = (d: BookTaxData) => d.categories.find(c => c.category === 'interest_income')!.total;
    expect(interest(split.self)).toBe(500);
    expect(interest(split.spouse)).toBe(500);
  });

  it('honors a non-default residual and deduction split', () => {
    const split = splitBookTaxData(bookData, owners, {
      residualSelfPct: 70, deductionsSelfPct: 25, ctcClaimant: 'self',
    });
    const interest = (d: BookTaxData) => d.categories.find(c => c.category === 'interest_income')!.total;
    const charity = (d: BookTaxData) => d.categories.find(c => c.category === 'charitable_donation')!.total;
    expect(interest(split.self)).toBe(700);
    expect(interest(split.spouse)).toBe(300);
    expect(charity(split.self)).toBe(2_000);
    expect(charity(split.spouse)).toBe(6_000);
  });

  it('conserves every category total across the two sides', () => {
    const split = splitBookTaxData(bookData, owners, {
      residualSelfPct: 37, deductionsSelfPct: 81, ctcClaimant: 'self',
    });
    for (const agg of bookData.categories) {
      const s = split.self.categories.find(c => c.category === agg.category)!.total;
      const p = split.spouse.categories.find(c => c.category === agg.category)!.total;
      expect(s + p).toBeCloseTo(agg.total, 2);
    }
    expect(split.self.realizedGains.longTerm + split.spouse.realizedGains.longTerm)
      .toBeCloseTo(bookData.realizedGains.longTerm, 2);
    expect(split.self.realizedGains.shortTerm + split.spouse.realizedGains.shortTerm)
      .toBeCloseTo(bookData.realizedGains.shortTerm, 2);
  });

  it('reports the attribution summary buckets', () => {
    const split = splitBookTaxData(bookData, owners, DEFAULT_ALLOCATION);
    const wages = split.attribution.find(a => a.category === 'w2_wages')!;
    expect(wages.attributedSelf).toBe(90_000);
    expect(wages.attributedSpouse).toBe(40_000);
    expect(wages.unattributed).toBe(0);
    const interest = split.attribution.find(a => a.category === 'interest_income')!;
    expect(interest.unattributed).toBe(1_000);
    expect(split.gainsAttribution.attributedSpouse).toBe(8_000);
    expect(split.gainsAttribution.unattributed).toBe(4_000);
  });

  it('uses the classifier per-owner contribution split directly', () => {
    const data = makeBookData({
      contributionsByType: { traditional_ira: 10_000 },
      contributionsByTypeAndOwner: { traditional_ira: { self: 7_000, spouse: 3_000 } },
      flaggedRetirementTypes: ['traditional_ira'],
    });
    const split = splitBookTaxData(data, {}, DEFAULT_ALLOCATION);
    expect(split.self.contributionsByType['traditional_ira']).toBe(7_000);
    expect(split.spouse.contributionsByType['traditional_ira']).toBe(3_000);
    // each side reads as that side's own ('self') contributions
    expect(split.spouse.contributionsByTypeAndOwner!['traditional_ira']).toEqual({ self: 3_000, spouse: 0 });
  });
});

describe('normalizeAllocation', () => {
  it('clamps and defaults persisted junk', () => {
    expect(normalizeAllocation(undefined)).toEqual(DEFAULT_ALLOCATION);
    expect(normalizeAllocation({ residualSelfPct: 250, deductionsSelfPct: -5, ctcClaimant: 'spouse' }))
      .toEqual({ residualSelfPct: 100, deductionsSelfPct: 0, ctcClaimant: 'spouse' });
    expect(normalizeAllocation({ ctcClaimant: 'dog' }).ctcClaimant).toBe('self');
  });
});

/* ------------------------------------------------------------------ */
/* MFS engine-run parity                                               */
/* ------------------------------------------------------------------ */

describe('MFS engine-run parity', () => {
  it('per-spouse totals match direct engine runs on the same split inputs', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [
          { guid: 'wage-self', amount: 120_000 },
          { guid: 'wage-spouse', amount: 45_000 },
        ]),
        cat('interest_income', [{ guid: 'joint-savings', amount: 2_000 }]),
      ],
    });
    const owners: Record<string, AccountOwner> = { 'wage-self': 'self', 'wage-spouse': 'spouse' };
    const params = makeParams(bookData, owners);
    const runs = runComparisonAt(params);

    // Direct engine run for each spouse over the identical split data.
    const split = splitBookTaxData(bookData, owners, DEFAULT_ALLOCATION);
    for (const [side, run] of [['self', runs.mfs.self], ['spouse', runs.mfs.spouse]] as const) {
      const raw = buildFederalInputsFromBookData(
        side === 'self' ? split.self : split.spouse, 2025, 'mfs', 0, 1,
      );
      const base = runs.mfs.chosen === 'both_itemize' ? { ...raw, mfsSpouseItemizes: true } : raw;
      const { inputs } = applyHouseholdTaxDetails(
        { ...base, priorYearCapitalLossCarryover: 0 },
        {
          qualifyingChildrenUnder17: 0,
          coveredByEmployerPlan: false,
          spouseCoveredByEmployerPlan: false,
          selfIraLimit: null,
          spouseIraLimit: null,
          qualifiedTipIncome: 0,
          qualifiedOvertimeCompensation: 0,
          qualifiedCarLoanInterest: 0,
        },
      );
      const direct = computeFederalTax(inputs);
      expect(run.result.totalTax).toBeCloseTo(direct.totalTax, 2);
      expect(run.result.agi).toBeCloseTo(direct.agi, 2);
    }
    expect(runs.mfs.combinedTotalTax).toBeCloseTo(
      runs.mfs.self.result.totalTax + runs.mfs.spouse.result.totalTax, 2,
    );
  });

  it('MFJ run matches the estimator pipeline over the un-split data', () => {
    const bookData = makeBookData({
      categories: [cat('w2_wages', [{ guid: 'w', amount: 160_000 }])],
    });
    const params = makeParams(bookData);
    const result = compareFilingStatuses(params);
    const raw = buildFederalInputsFromBookData(bookData, 2025, 'mfj', 0, 1);
    const { inputs } = applyHouseholdTaxDetails(
      { ...raw, priorYearCapitalLossCarryover: 0 },
      {
        qualifyingChildrenUnder17: 0,
        coveredByEmployerPlan: false,
        spouseCoveredByEmployerPlan: false,
        selfIraLimit: null,
        spouseIraLimit: null,
        qualifiedTipIncome: 0,
        qualifiedOvertimeCompensation: 0,
        qualifiedCarLoanInterest: 0,
      },
    );
    expect(result.mfj.totalTax).toBeCloseTo(computeFederalTax(inputs).totalTax, 2);
  });

  it('symmetric income makes MFS bracket math equal MFJ (the classic identity)', () => {
    // Perfectly even wages, no credits, no thresholds crossed: MFS brackets
    // are exactly half the joint widths, so the combined tax matches.
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [
          { guid: 'a', amount: 80_000 },
          { guid: 'b', amount: 80_000 },
        ]),
      ],
    });
    const result = compareFilingStatuses(
      makeParams(bookData, { a: 'self', b: 'spouse' }),
    );
    expect(result.mfsCombinedTotalTax).toBeCloseTo(result.mfj.totalTax, 0);
    expect(result.winner).toBe('tie');
  });
});

/* ------------------------------------------------------------------ */
/* Deduction symmetry: both-itemize vs both-standard                   */
/* ------------------------------------------------------------------ */

describe('MFS deduction combination', () => {
  it('picks both-standard when itemizables are small', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 90_000 }, { guid: 'b', amount: 60_000 }]),
        cat('state_local_tax_paid', [{ guid: 'salt', amount: 4_000 }]),
      ],
    });
    const result = compareFilingStatuses(makeParams(bookData, { a: 'self', b: 'spouse' }));
    expect(result.mfsCombination.chosen).toBe('both_standard');
    expect(result.mfsCombination.bothStandardTotal).not.toBeNull();
    expect(result.mfsCombination.bothStandardTotal!).toBeLessThanOrEqual(
      result.mfsCombination.bothItemizeTotal,
    );
    // Both returns took a (full) standard deduction.
    expect(result.mfsSelf.usedItemized).toBe(false);
    expect(result.mfsSpouse.usedItemized).toBe(false);
    expect(result.mfsSelf.deductionTaken).toBe(15_750);
  });

  it('picks both-itemize when deductions are large, zeroing the light spouse’s standard deduction', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 150_000 }, { guid: 'b', amount: 30_000 }]),
        cat('mortgage_interest', [{ guid: 'mort', amount: 30_000 }]),
        cat('state_local_tax_paid', [{ guid: 'salt', amount: 15_000 }]),
      ],
    });
    // All deductions on self: spouse itemizes ~nothing but must give up the
    // standard deduction for self to itemize.
    const result = compareFilingStatuses(makeParams(
      bookData,
      { a: 'self', b: 'spouse' },
      { residualSelfPct: 50, deductionsSelfPct: 100, ctcClaimant: 'self' },
    ));
    expect(result.mfsCombination.chosen).toBe('both_itemize');
    expect(result.mfsSelf.usedItemized).toBe(true);
    // The light spouse's standard deduction is zero (§63(c)(6)(A)).
    expect(result.mfsSpouse.standardDeduction).toBe(0);
    expect(result.mfsSpouse.deductionTaken).toBe(0);
    // And the caveat calls out the forced symmetry.
    const symmetry = result.caveats.find(c => c.id === 'itemize_symmetry')!;
    expect(symmetry.applies).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Divergences and MFS-specific rules                                  */
/* ------------------------------------------------------------------ */

describe('per-line divergences', () => {
  it('flags the $1,500 capital-loss cap when losses concentrate on one spouse', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 90_000 }, { guid: 'b', amount: 90_000 }]),
      ],
      realizedGains: {
        shortTerm: 0,
        longTerm: -6_000,
        accounts: [
          { accountGuid: 'broke', accountName: 'b', accountPath: 'p', shortTerm: 0, longTerm: -6_000 },
        ],
      },
    });
    const result = compareFilingStatuses(makeParams(bookData, { a: 'self', b: 'spouse', broke: 'self' }));
    // MFJ deducts 3,000 now; MFS: self capped at 1,500, spouse has no loss.
    const lossLine = result.divergences.find(d => d.key === 'capitalLossCarryoverToNextYear');
    expect(lossLine).toBeDefined();
    expect(lossLine!.mfj).toBeCloseTo(3_000, 2);
    expect(lossLine!.mfs).toBeCloseTo(4_500, 2);
    const caveat = result.caveats.find(c => c.id === 'loss_cap')!;
    expect(caveat.applies).toBe(true);
  });

  it('flags CTC and threshold divergences at high uneven income', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 240_000 }, { guid: 'b', amount: 0 }]),
      ],
    });
    const result = compareFilingStatuses(makeParams(
      bookData, { a: 'self', b: 'spouse' }, DEFAULT_ALLOCATION, { dependentsUnder17: 2 },
    ));
    // Additional Medicare: MFJ threshold 250k (no tax); MFS self 240k > 125k.
    const medicare = result.divergences.find(d => d.key === 'additionalMedicareTax');
    expect(medicare).toBeDefined();
    expect(medicare!.mfj).toBe(0);
    expect(medicare!.mfs).toBeCloseTo(0.009 * 115_000, 0);
    // CTC: full jointly (MAGI < 400k); phased down for the 240k MFS return.
    const ctc = result.divergences.find(d => d.key === 'credits');
    expect(ctc).toBeDefined();
    expect(ctc!.mfj).toBeCloseTo(4_400, 0);
    expect(ctc!.mfs).toBeLessThan(4_400);
  });

  it('IRA deductibility collapses under MFS for a covered spouse (0–10k phase-out)', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 80_000 }, { guid: 'b', amount: 80_000 }]),
      ],
      contributionsByType: { traditional_ira: 14_000 },
      contributionsByTypeAndOwner: { traditional_ira: { self: 7_000, spouse: 7_000 } },
      flaggedRetirementTypes: ['traditional_ira'],
    });
    const result = compareFilingStatuses(makeParams(
      bookData, { a: 'self', b: 'spouse' }, DEFAULT_ALLOCATION,
      {
        self: { age65: false, coveredByEmployerPlan: true, iraLimit: 7_000 },
        spouse: { age65: false, coveredByEmployerPlan: true, iraLimit: 7_000 },
      },
    ));
    // Jointly at 160k MAGI (2025 covered range 126k-146k) the deduction is
    // already phased out; separately the 0-10k range kills it outright.
    expect(result.nonDeductibleIra.mfs).toBeCloseTo(14_000, 0);
    expect(result.nonDeductibleIra.mfs).toBeGreaterThanOrEqual(result.nonDeductibleIra.mfj);
    const caveat = result.caveats.find(c => c.id === 'ira_deduction')!;
    expect(typeof caveat.applies).toBe('boolean');
  });

  it('OBBBA tips deduction survives MFJ and dies under MFS', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 60_000 }, { guid: 'b', amount: 40_000 }]),
      ],
    });
    const result = compareFilingStatuses(makeParams(
      bookData, { a: 'self', b: 'spouse' }, DEFAULT_ALLOCATION,
      { qualifiedTipIncome: 10_000 },
    ));
    expect(result.mfj.tipsDeduction).toBe(10_000);
    expect(result.mfsSelf.tipsDeduction).toBe(0);
    expect(result.mfsSpouse.tipsDeduction).toBe(0);
    const line = result.divergences.find(d => d.key === 'tipsDeduction');
    expect(line).toBeDefined();
    expect(line!.delta).toBeCloseTo(-10_000, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Caveat triggers                                                     */
/* ------------------------------------------------------------------ */

describe('caveat triggers', () => {
  it('flags the EITC as at stake for a low-income MFJ household with kids', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 24_000 }, { guid: 'b', amount: 16_000 }]),
      ],
    });
    const result = compareFilingStatuses(makeParams(
      bookData, { a: 'self', b: 'spouse' }, DEFAULT_ALLOCATION, { dependentsUnder17: 2 },
    ));
    const eitc = result.caveats.find(c => c.id === 'eitc')!;
    expect(eitc.applies).toBe(true); // AGI 40k < 64,430 (2025, 2 kids)
  });

  it('does not flag the EITC for a high-income household', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 200_000 }, { guid: 'b', amount: 100_000 }]),
      ],
    });
    const result = compareFilingStatuses(makeParams(bookData, { a: 'self', b: 'spouse' }));
    expect(result.caveats.find(c => c.id === 'eitc')!.applies).toBe(false);
    // The caveat itself is still surfaced (panel shows all of them).
    expect(result.caveats.some(c => c.id === 'eitc')).toBe(true);
  });

  it('flags education credits when the book has education expenses', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 90_000 }]),
        cat('education_expense', [{ guid: 'edu', amount: 6_000 }]),
      ],
    });
    const result = compareFilingStatuses(makeParams(bookData, { a: 'self' }));
    expect(result.caveats.find(c => c.id === 'education')!.applies).toBe(true);
  });

  it('always includes the IDR and community-property caveats as informational', () => {
    const result = compareFilingStatuses(makeParams(makeBookData()));
    expect(result.caveats.some(c => c.id === 'idr')).toBe(true);
    expect(result.caveats.some(c => c.id === 'community_property')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Marriage penalty / bonus lens                                       */
/* ------------------------------------------------------------------ */

describe('single×2 baseline', () => {
  it('is null unless requested, and labeled by a signed penalty', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 200_000 }, { guid: 'b', amount: 0 }]),
      ],
    });
    const without = compareFilingStatuses(makeParams(bookData, { a: 'self', b: 'spouse' }));
    expect(without.singleBaseline).toBeNull();

    const withLens = compareFilingStatuses(makeParams(
      bookData, { a: 'self', b: 'spouse' }, DEFAULT_ALLOCATION, { includeSingleBaseline: true },
    ));
    expect(withLens.singleBaseline).not.toBeNull();
    const sb = withLens.singleBaseline!;
    expect(sb.combinedTotalTax).toBeCloseTo(sb.self.totalTax + sb.spouse.totalTax, 2);
    // One earner: joint brackets are twice as wide → marriage BONUS (negative penalty).
    expect(sb.marriagePenalty).toBeLessThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Breakeven detection                                                 */
/* ------------------------------------------------------------------ */

describe('findCrossovers', () => {
  it('finds an interpolated crossover on a sign change', () => {
    const points: SweepPoint[] = [
      { x: 0, mfjTotal: 100, mfsTotal: 90 },   // MFS wins
      { x: 100, mfjTotal: 100, mfsTotal: 110 }, // MFJ wins
    ];
    const { crossovers, verdict } = findCrossovers(points);
    expect(verdict).toBe('crossover');
    expect(crossovers).toHaveLength(1);
    expect(crossovers[0]).toBeCloseTo(50, 5);
  });

  it('reports mfj_always on a monotone MFJ-favoring series', () => {
    const points: SweepPoint[] = [0, 1, 2, 3].map(i => ({
      x: i * 10, mfjTotal: 100 + i, mfsTotal: 120 + 2 * i,
    }));
    const { crossovers, verdict } = findCrossovers(points);
    expect(verdict).toBe('mfj_always');
    expect(crossovers).toHaveLength(0);
  });

  it('reports mfs_always and tie correctly', () => {
    expect(findCrossovers([
      { x: 0, mfjTotal: 100, mfsTotal: 50 },
      { x: 1, mfjTotal: 100, mfsTotal: 60 },
    ]).verdict).toBe('mfs_always');
    expect(findCrossovers([
      { x: 0, mfjTotal: 100, mfsTotal: 100 },
      { x: 1, mfjTotal: 100, mfsTotal: 100 },
    ]).verdict).toBe('tie');
  });
});

describe('runBreakevenSweep', () => {
  it('finds a crossover in a medical-expense scenario where MFS wins at low spouse wages', () => {
    // Classic MFS-wins setup: the low-income spouse carries large medical
    // expenses (7.5%-of-AGI floor is per return). At low spouse wages the
    // separate return deducts far more; as spouse wages rise the advantage
    // decays and MFJ takes over.
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 200_000 }, { guid: 'b', amount: 30_000 }]),
        cat('medical_expense', [{ guid: 'med', amount: 40_000 }]),
        cat('state_local_tax_paid', [{ guid: 'salt', amount: 10_000 }]),
      ],
    });
    const params = makeParams(
      bookData,
      { a: 'self', b: 'spouse', med: 'spouse', salt: 'spouse' },
    );
    const sweep = runBreakevenSweep(params, 'spouseWages', { min: 0, max: 400_000, steps: 40 });
    expect(sweep.verdict).toBe('crossover');
    expect(sweep.crossovers.length).toBeGreaterThan(0);
    // The sweep's own data agrees with the verdict: both signs occur.
    const diffs = sweep.points.map(p => p.mfsTotal - p.mfjTotal);
    expect(diffs.some(d => d < -0.005)).toBe(true);
    expect(diffs.some(d => d > 0.005)).toBe(true);
    // Current position sits on the swept axis in engine dollars.
    expect(sweep.currentX).toBeCloseTo(30_000, 0);
  });

  it('reports mfj_always for a plain-wage household across the range', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 150_000 }, { guid: 'b', amount: 50_000 }]),
      ],
    });
    const params = makeParams(bookData, { a: 'self', b: 'spouse' }, DEFAULT_ALLOCATION, {
      dependentsUnder17: 1, // MFS also loses CTC headroom sooner
    });
    const sweep = runBreakevenSweep(params, 'spouseWages', { min: 0, max: 200_000, steps: 20 });
    // Pure bracket math never favors MFS; every point should favor MFJ or tie.
    expect(sweep.points.every(p => p.mfsTotal >= p.mfjTotal - 0.01)).toBe(true);
    expect(sweep.verdict === 'mfj_always' || sweep.verdict === 'tie').toBe(true);
  });

  it('deduction-allocation sweep holds MFJ constant while MFS moves', () => {
    const bookData = makeBookData({
      categories: [
        cat('w2_wages', [{ guid: 'a', amount: 180_000 }, { guid: 'b', amount: 40_000 }]),
        cat('mortgage_interest', [{ guid: 'mort', amount: 24_000 }]),
        cat('state_local_tax_paid', [{ guid: 'salt', amount: 12_000 }]),
      ],
    });
    const params = makeParams(bookData, { a: 'self', b: 'spouse' });
    const sweep = runBreakevenSweep(params, 'deductionsSelfPct', { min: 0, max: 100, steps: 10 });
    const mfjTotals = new Set(sweep.points.map(p => p.mfjTotal));
    expect(mfjTotals.size).toBe(1); // reallocating between spouses never moves the joint return
    const mfsTotals = new Set(sweep.points.map(p => p.mfsTotal));
    expect(mfsTotals.size).toBeGreaterThan(1);
    expect(sweep.currentX).toBe(50);
  });
});
