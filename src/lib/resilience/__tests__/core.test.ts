import { describe, expect, it } from 'vitest';
import {
  buildPersonalPriceIndex,
  calculateCapitalPlan,
  calculateCoverageGap,
  calculateLifeNeeds,
  calculateRentRoll,
  compareHealthPlans,
  mileageRate,
  parseReceiptPriceLines,
  summarizeMileage,
} from '../core';

describe('rental portfolio', () => {
  it('builds a rent roll, outstanding balance, deposit liability and renewal signal', () => {
    const result = calculateRentRoll([{
      id: 'property',
      name: 'Oak House',
      address: '',
      units: [{
        id: 'unit',
        name: 'A',
        tenantName: 'Taylor',
        leaseStart: '2026-01-01',
        leaseEnd: '2026-09-01',
        monthlyRent: 1500,
        rentDueDay: 1,
        securityDeposit: 1500,
        lateFee: 50,
        annualEscalationPercent: 3,
        payments: [{ id: 'payment', date: '2026-07-01', amount: 1000, kind: 'rent' }],
      }],
    }], new Date('2026-07-26T12:00:00Z'));

    expect(result.monthlyScheduledRent).toBe(1500);
    expect(result.collectedThisMonth).toBe(1000);
    expect(result.outstanding).toBe(500);
    expect(result.depositLiability).toBe(1500);
    expect(result.rows[0]).toMatchObject({ overdue: true, daysToRenewal: 37 });
  });
});

describe('insurance and capital planning', () => {
  it('finds both whole-policy and category sub-limit gaps', () => {
    const result = calculateCoverageGap([{
      id: 'policy',
      type: 'home',
      provider: 'Carrier',
      policyNumber: '',
      coveredEntity: 'Home',
      coverageLimit: 80_000,
      deductible: 1000,
      annualPremium: 1200,
      renewalDate: '2027-01-01',
      sublimits: [{ id: 'sub', category: 'Jewelry', limit: 5_000 }],
      documentIds: [],
    }], [
      { category: 'Furniture', estValue: 70_000 },
      { category: 'Jewelry', estValue: 30_000 },
    ]);

    expect(result.replacementValue).toBe(100_000);
    expect(result.gap).toBe(20_000);
    expect(result.categoryGaps).toEqual([
      { category: 'Jewelry', inventoryValue: 30_000, limit: 5_000, gap: 25_000 },
    ]);
  });

  it('inflates replacement costs and converts the gap to monthly funding', () => {
    const result = calculateCapitalPlan([{
      id: 'roof',
      name: 'Roof',
      category: 'Exterior',
      installedYear: 2011,
      expectedLifeYears: 20,
      currentReplacementCost: 20_000,
      inflationRate: 3,
      fundedAmount: 5_000,
    }], new Date('2026-01-01T12:00:00Z'));

    expect(result.rows[0].replacementYear).toBe(2031);
    expect(result.rows[0].futureCost).toBe(23_185.48);
    expect(result.rows[0].fundingGap).toBe(18_185.48);
    expect(result.rows[0].monthlyFunding).toBe(303.09);
  });
});

describe('life and healthcare decisions', () => {
  it('uses the larger DIME or survivor cash-flow gap', () => {
    const result = calculateLifeNeeds({
      id: 'person',
      name: 'Alex',
      annualIncome: 100_000,
      replacementYears: 10,
      debts: 200_000,
      educationGoals: 100_000,
      finalExpenses: 20_000,
      liquidAssets: 150_000,
      existingCoverage: 250_000,
      survivorAnnualIncome: 50_000,
      survivorAnnualExpenses: 120_000,
    });

    expect(result.dimeNeed).toBe(1_320_000);
    expect(result.dimeGap).toBe(920_000);
    expect(result.survivorNeed).toBe(1_020_000);
    expect(result.recommendedCoverage).toBe(920_000);
  });

  it('replays the same claims against plan terms and HSA tax effects', () => {
    const claims = [{ id: 'c', date: '2026-01-01', member: 'Alex', category: 'Medical', allowedAmount: 10_000 }];
    const rows = compareHealthPlans([
      {
        id: 'ppo', name: 'PPO', annualPremium: 12_000, familyDeductible: 1000,
        coinsurancePercent: 20, outOfPocketMax: 6000, employerHsaContribution: 0,
        employeeHsaContribution: 0, marginalTaxRate: 24, hsaEligible: false,
      },
      {
        id: 'hdhp', name: 'HDHP', annualPremium: 6000, familyDeductible: 4000,
        coinsurancePercent: 20, outOfPocketMax: 8000, employerHsaContribution: 1500,
        employeeHsaContribution: 4000, marginalTaxRate: 24, hsaEligible: true,
      },
    ], claims);

    expect(rows[0].plan.id).toBe('hdhp');
    expect(rows[0].hsaTaxSavings).toBe(960);
    expect(rows[1].differenceFromBest).toBeGreaterThan(0);
  });
});

describe('mileage substantiation', () => {
  it('applies the 2026 mid-year IRS rate change by trip date', () => {
    expect(mileageRate('2026-06-30', 'business')).toBe(0.725);
    expect(mileageRate('2026-07-01', 'business')).toBe(0.76);
    expect(mileageRate('2026-07-01', 'medical')).toBe(0.235);
    expect(mileageRate('2026-07-01', 'charity')).toBe(0.14);
  });

  it('totals deductions by Schedule C, E and F', () => {
    const summary = summarizeMileage([
      { id: 'c', date: '2026-01-10', vehicleId: 'v', purpose: 'business', schedule: 'C', description: 'Client', miles: 100 },
      { id: 'f', date: '2026-07-10', vehicleId: 'v', purpose: 'business', schedule: 'F', description: 'Feed', miles: 100 },
      { id: 'p', date: '2026-07-11', vehicleId: 'v', purpose: 'personal', schedule: 'none', description: 'Personal', miles: 25 },
    ], 2026);

    expect(summary.totalMiles).toBe(225);
    expect(summary.deductibleMiles).toBe(200);
    expect(summary.deduction).toBe(148.5);
    expect(summary.bySchedule.find(row => row.schedule === 'F')?.deduction).toBe(76);
  });
});

describe('personal price index', () => {
  it('parses comparable OCR lines and calculates price change', () => {
    const first = parseReceiptPriceLines({
      receiptId: 1,
      date: '2025-07-01',
      merchant: 'Market',
      text: 'Organic Large Eggs 4.00\nSubtotal 4.00\nTax 0.00\nTotal 4.00',
    });
    const latest = parseReceiptPriceLines({
      receiptId: 2,
      date: '2026-07-01',
      merchant: 'Market',
      text: 'Large Eggs 5.00\nTotal 5.00',
    });
    const result = buildPersonalPriceIndex([...first, ...latest]);

    expect(first).toHaveLength(1);
    expect(latest).toHaveLength(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      normalizedName: 'eggs',
      firstUnitPrice: 4,
      latestUnitPrice: 5,
      changePercent: 25,
    });
  });
});
