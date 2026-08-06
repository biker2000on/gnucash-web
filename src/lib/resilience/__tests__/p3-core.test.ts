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

  // Shape taken from a real Duke Energy statement after OCR flattens the page
  // (identifiers replaced). The layout matters: the summary near the top leads
  // with the PREVIOUS balance, and the charge detail sits on the last page.
  const DUKE_BILL = [
    'Page 1 of 3  duke-energy.com  Your Energy Bill  Service address   Bill date  Account number',
    'Nov 8, 2024 33   days  For service   Oct 5 - Nov 6  ACCOUNT HOLDER  1 EXAMPLE ST',
    'Billing summary  Previous Amount Due   $120.57  Payment Received Nov 04   -120.57',
    'Current Electric Charges   156.19  Taxes   10.93  Total Amount Due Dec 03   $167.12',
    'Current electric usage for meter number 000000000  Actual reading on Nov 6   87651',
    'Previous reading on Oct 5   - 86486 Energy Used   1,165 kWh Billed kWh   1,165.000 kWh',
    'Page 3 of 3  Billing details - Electric  Billing Period - Oct 05 24 to Nov 06 24 Meter - 000000000',
    'Basic Customer Charge   $14.00 Energy Charge   123.77',
    'Storm Recovery Charge 1,165.000 kWh @ $0.00048400   0.56',
    'Summary of Rider Adjustments   16.61 Clean Energy Rider   1.25',
    'Total Current Charges   $156.19',
    'Your current rate is Residential Service, Electric (RE).',
    'Billing details - Taxes  Sales Tax For Utility   $10.93  Total Taxes   $10.93',
  ].join('  ');

  it('reads the service period rather than the upload date', () => {
    const bill = parseUtilityBillText({
      receiptId: 7,
      // A bill uploaded today can be years old; the usage belongs to the
      // period it was metered.
      date: '2026-08-06',
      provider: 'Duke Energy',
      text: DUKE_BILL,
    })!;
    expect(bill.periodStart).toBe('2024-10-05');
    expect(bill.periodEnd).toBe('2024-11-06');
    expect(bill.date).toBe('2024-11-06');
  });

  it('totals this period only, not the previous balance', () => {
    const bill = parseUtilityBillText({ receiptId: 7, date: '2026-08-06', provider: 'Duke', text: DUKE_BILL })!;
    // 120.57 is the PREVIOUS amount due and 156.19 excludes tax; the bill's
    // own arithmetic is 156.19 + 10.93.
    expect(bill.totalCost).toBe(167.12);
    expect(bill.usage).toBe(1165);
    expect(bill.type).toBe('electric');
  });

  it('separates supply from the fees riding on top of it', () => {
    const bill = parseUtilityBillText({ receiptId: 7, date: '2026-08-06', provider: 'Duke', text: DUKE_BILL })!;
    expect(bill.supplyCost).toBe(123.77);
    // 14.00 customer charge + 0.56 storm recovery + 16.61 riders + 1.25 clean energy
    expect(bill.feeCost).toBe(32.42);
    expect(bill.taxCost).toBe(10.93);
    expect(bill.charges?.map(charge => charge.label)).toEqual([
      'Basic Customer Charge',
      'Energy Charge',
      'Storm Recovery Charge',
      'Summary of Rider Adjustments',
      'Clean Energy Rider',
      'Sales Tax For Utility',
    ]);
    // The meter number and billing period must never be read as charge labels.
    expect(bill.charges?.some(charge => /meter|period/i.test(charge.label))).toBe(false);
  });

  it('keeps credits negative and excludes non-utility items from the total', () => {
    const withRebate = DUKE_BILL.replace(
      'Billing details - Taxes  Sales Tax For Utility   $10.93  Total Taxes   $10.93',
      'Billing details - Products and Services  Power Manager - Thermostat $-50.00  Total Products and Services $-50.00  '
      + 'Billing details - Taxes  Sales Tax For Non-Utility $-2.38 County Sales Tax -1.00 Sales Tax For Utility 9.38  Total Taxes $6.00',
    );
    const bill = parseUtilityBillText({ receiptId: 8, date: '2026-08-06', provider: 'Duke', text: withRebate })!;
    // -2.38 and -1.00 are reversals; dropping their sign overstated tax by 3.38.
    expect(bill.taxCost).toBe(6);
    expect(bill.otherCost).toBe(-50);
    // A thermostat rebate is not a cost of electricity: folding it in would
    // depress cost per kWh and read as a rate change that never happened.
    // 123.77 supply + 32.42 fees + 6.00 tax; the -50.00 rebate is not in it.
    expect(bill.totalCost).toBe(162.19);
  });

  it('falls back to the given date and stated total when a bill has no detail section', () => {
    const bill = parseUtilityBillText({
      receiptId: 9,
      date: '2026-06-15',
      provider: 'City Water',
      text: 'Service usage 4,300 gallons\nAmount due $61.20',
    })!;
    expect(bill.date).toBe('2026-06-15');
    expect(bill.type).toBe('water');
    expect(bill.usage).toBe(4300);
    expect(bill.totalCost).toBe(61.2);
    expect(bill.charges).toEqual([]);
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
