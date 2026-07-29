import { describe, expect, it } from 'vitest';
import {
  calculateEducationPlan,
  calculateFamilyBanking,
  calculateSolarPayback,
  calculateTripPlan,
  calculateUtilityAnalysis,
  calculateVehicleTco,
  parseUtilityBillText,
} from '../p3-core';

describe('P3 integrated feature calculations', () => {
  it('projects a 529 goal, contribution requirement, deduction room, and glide path', () => {
    const result = calculateEducationPlan({
      id: 'child-1',
      name: 'Avery',
      birthYear: 2018,
      collegeStartYear: 2036,
      schoolType: 'public_in_state',
      yearsOfSchool: 4,
      annualCostToday: 30_000,
      tuitionInflationRate: 5,
      current529Balance: 20_000,
      expectedAnnualReturn: 6,
      plannedMonthlyContribution: 300,
      stateDeductionLimit: 5_000,
      contributions: [{ id: 'c1', date: '2026-03-01', amount: 2_000 }],
    }, new Date('2026-07-01T12:00:00Z'));

    expect(result.projectedCost).toBeGreaterThan(120_000);
    expect(result.projected529Balance).toBeGreaterThan(20_000);
    expect(result.requiredMonthlyContribution).toBeGreaterThan(0);
    expect(result.stateDeductionRemaining).toBe(3_000);
    expect(result.glidePath.equityPercent).toBe(60);
  });

  it('separates utility usage change from rate change', () => {
    const result = calculateUtilityAnalysis([
      { id: 'b1', date: '2026-05-01', type: 'electric', provider: 'Power', usage: 1_000, unit: 'kWh', totalCost: 150 },
      { id: 'b2', date: '2026-06-01', type: 'electric', provider: 'Power', usage: 1_100, unit: 'kWh', totalCost: 198 },
    ]);
    const electric = result.byType.find(row => row.type === 'electric')!;
    expect(electric.usageChangePercent).toBe(10);
    expect(electric.rateChangePercent).toBe(20);
    expect(result.trailing12Cost).toBe(348);
  });

  it('extracts utility evidence from OCR text', () => {
    const bill = parseUtilityBillText({
      receiptId: 42,
      date: '2026-06-15',
      provider: 'City Power',
      text: 'Electric usage 1,234 kWh\nAmount due $187.42',
    });
    expect(bill).toMatchObject({
      id: 'receipt-42-electric',
      usage: 1234,
      totalCost: 187.42,
      unit: 'kWh',
      receiptId: 42,
    });
  });

  it('calculates solar payback from actual electric rates', () => {
    const result = calculateSolarPayback({
      bills: [
        { id: 'b1', date: '2026-06-01', type: 'electric', provider: 'Power', usage: 1_000, unit: 'kWh', totalCost: 200 },
      ],
      solar: {
        enabled: true,
        systemCost: 20_000,
        incentives: 5_000,
        annualProductionKwh: 12_000,
        degradationRate: 0.5,
        electricRateInflation: 3,
        annualMaintenance: 100,
        analysisYears: 25,
      },
    });
    expect(result.upfrontCost).toBe(15_000);
    expect(result.paybackYear).not.toBeNull();
    expect(result.lifetimeSavings).toBeGreaterThan(0);
  });

  it('keeps family balances liability-backed and excludes pending chores', () => {
    const result = calculateFamilyBanking({
      id: 'kid-1',
      name: 'Sam',
      liabilityAccountGuid: 'liability-guid',
      allowanceAmount: 10,
      allowanceCadence: 'weekly',
      nextAllowanceDate: '2026-06-30',
      parentMatchPercent: 25,
      savingsGoal: 100,
      entries: [
        { id: 'e1', date: '2026-06-01', description: 'Deposit', amount: 40, kind: 'deposit', approved: true },
        { id: 'e2', date: '2026-06-02', description: 'Toy', amount: -10, kind: 'spend', approved: true },
        { id: 'e3', date: '2026-06-03', description: 'Mow lawn', amount: 15, kind: 'chore', approved: false },
      ],
    }, new Date('2026-07-01T12:00:00Z'));
    expect(result.balance).toBe(30);
    expect(result.pendingAmount).toBe(15);
    expect(result.matchingEarned).toBe(10);
    expect(result.allowanceDue).toBe(true);
  });

  it('reports trip funding and plan-versus-actual', () => {
    const result = calculateTripPlan({
      id: 'trip-1',
      name: 'Beach',
      destination: 'Outer Banks',
      startDate: '2026-10-01',
      endDate: '2026-10-08',
      budget: 2_000,
      savingsTarget: 2_000,
      fundedAmount: 800,
      tagName: 'beach-trip',
      current: false,
      expenses: [
        { id: 'x1', date: '2026-06-01', description: 'Deposit', amount: 500 },
        { id: 'x2', date: '2026-06-02', description: 'Flights', amount: 750 },
      ],
    }, new Date('2026-07-01T12:00:00Z'));
    expect(result.spent).toBe(1_250);
    expect(result.remainingBudget).toBe(750);
    expect(result.fundingGap).toBe(1_200);
    expect(result.requiredMonthlySavings).toBeGreaterThan(0);
  });

  it('combines evidence into vehicle TCO and a repair-versus-replace decision', () => {
    const result = calculateVehicleTco({
      vehicle: {
        id: 'v1',
        name: 'Truck',
        purchaseDate: '2021-01-01',
        purchasePrice: 40_000,
        currentValue: 20_000,
        annualInsurance: 1_500,
        annualRegistration: 300,
        annualMaintenance: 1_200,
        annualOther: 200,
        repairCost: 3_000,
        repairExtendsYears: 3,
        replacementVehicleCost: 50_000,
        replacementAnnualOperatingCost: 4_000,
      },
      trailing12FuelCost: 3_000,
      trailing12Miles: 12_000,
      asOf: new Date('2026-01-01T12:00:00Z'),
    });
    expect(result.annualTotalCost).toBe(10_200);
    expect(result.monthlyRunRate).toBe(850);
    expect(result.costPerMile).toBe(0.85);
    expect(result.recommendedDecision).toBe('repair');
    expect(result.decisionSavings).toBeGreaterThan(0);
  });
});
