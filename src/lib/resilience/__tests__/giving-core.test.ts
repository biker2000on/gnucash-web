import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGMENT_THRESHOLD,
  QCD_ANNUAL_LIMIT_PER_PERSON,
  calculateGivingPlan,
} from '../giving-core';
import type { GivingProfile, GivingSettings } from '../types';

const asOf = new Date('2026-08-01T12:00:00Z');

const settings: GivingSettings = {
  filingStatus: 'married_joint',
  marginalRatePct: 24,
  stateRatePct: 5,
  agiEstimate: 200_000,
  birthYear: null,
  spouseBirthYear: null,
  plannedAnnualGiving: 20_000,
  standardDeductionOverride: null,
  otherItemizedAnnual: 20_000,
};

const emptyContext = { charityMiles: 0, charityMileageDeduction: 0 };

describe('calculateGivingPlan', () => {
  it('totals donations by year and kind and derives the tax year from the date', () => {
    const profile: GivingProfile = {
      settings,
      donations: [
        { id: 'd1', date: '2026-02-14', charity: 'Food Bank', kind: 'cash', amount: 300, acknowledged: true },
        { id: 'd2', date: '2026-03-01', charity: 'Shelter', kind: 'noncash', amount: 450, acknowledged: true },
        { id: 'd3', date: '2026-04-01', charity: 'IRA Custodian → Food Bank', kind: 'qcd', amount: 5_000, acknowledged: true },
        { id: 'd4', date: '2025-12-20', charity: 'Food Bank', kind: 'cash', amount: 1_000, acknowledged: true },
      ],
    };
    const result = calculateGivingPlan(profile, emptyContext, asOf);
    expect(result.currentYear).toBe(2026);
    expect(result.yearTotals).toEqual([
      { taxYear: 2025, cashTotal: 1_000, noncashTotal: 0, qcdTotal: 0, total: 1_000, form8283Required: false },
      { taxYear: 2026, cashTotal: 300, noncashTotal: 450, qcdTotal: 5_000, total: 5_750, form8283Required: false },
    ]);
    expect(result.currentYearTotal).toBe(5_750);
    // QCDs are income exclusions, not itemized deductions.
    expect(result.currentYearDeductibleGiving).toBe(750);
    expect(result.remainingPlannedGiving).toBe(14_250);
  });

  it('flags acknowledgment letters, Form 8283 years, and appraisal thresholds', () => {
    const profile: GivingProfile = {
      settings,
      donations: [
        { id: 'd1', date: '2026-01-10', charity: 'Food Bank', kind: 'cash', amount: 250, acknowledged: false },
        { id: 'd2', date: '2026-01-11', charity: 'Food Bank', kind: 'cash', amount: 249.99, acknowledged: false },
        { id: 'd3', date: '2026-02-01', charity: 'Thrift Store', kind: 'noncash', amount: 600, acknowledged: true },
        { id: 'd4', date: '2026-03-01', charity: 'Museum', kind: 'noncash', amount: 5_000.01, acknowledged: true },
        { id: 'd5', date: '2026-04-01', charity: 'IRA Custodian', kind: 'qcd', amount: 10_000, acknowledged: false },
      ],
    };
    const result = calculateGivingPlan(profile, emptyContext, asOf);
    const byId = new Map(result.donations.map(donation => [donation.id, donation]));
    expect(byId.get('d1')!.needsAcknowledgment).toBe(true);
    expect(byId.get('d1')!.amount).toBe(ACKNOWLEDGMENT_THRESHOLD);
    expect(byId.get('d2')!.needsAcknowledgment).toBe(false);
    expect(byId.get('d3')!.needsForm8283).toBe(true);
    expect(byId.get('d3')!.needsAppraisal).toBe(false);
    expect(byId.get('d4')!.needsForm8283).toBe(true);
    expect(byId.get('d4')!.needsAppraisal).toBe(true);
    expect(byId.get('d5')!.needsAcknowledgment).toBe(false);
    expect(result.yearTotals[0].form8283Required).toBe(true);
    expect(result.substantiationIssueCount).toBe(2);
  });

  it('compares even giving against two-year bunching with exact deductions and savings', () => {
    const result = calculateGivingPlan({ settings, donations: [] }, emptyContext, asOf);
    // 2026 MFJ standard deduction from getYearStatusParams is 32,200.
    expect(result.bunching.standardDeduction).toBe(32_200);
    expect(result.bunching.even).toEqual({
      year1Deduction: 40_000,
      year2Deduction: 40_000,
      totalDeductions: 80_000,
    });
    expect(result.bunching.bunch).toEqual({
      year1Deduction: 60_000,
      year2Deduction: 32_200,
      totalDeductions: 92_200,
    });
    expect(result.bunching.incrementalDeduction).toBe(12_200);
    expect(result.bunching.combinedRatePct).toBe(29);
    expect(result.bunching.estimatedTaxSavings).toBe(3_538);
    expect(result.bunching.recommendBunching).toBe(true);
  });

  it('uses the single-filer standard deduction and reports no benefit when giving is zero', () => {
    const result = calculateGivingPlan({
      settings: { ...settings, filingStatus: 'single', stateRatePct: null, plannedAnnualGiving: 0, otherItemizedAnnual: 0 },
      donations: [],
    }, emptyContext, asOf);
    // 2026 single standard deduction from getYearStatusParams is 16,100.
    expect(result.bunching.standardDeduction).toBe(16_100);
    expect(result.bunching.incrementalDeduction).toBe(0);
    expect(result.bunching.estimatedTaxSavings).toBe(0);
    expect(result.bunching.recommendBunching).toBe(false);
    expect(result.bunching.combinedRatePct).toBe(24);
  });

  it('honors a standard deduction override', () => {
    const result = calculateGivingPlan({
      settings: { ...settings, standardDeductionOverride: 30_000 },
      donations: [],
    }, emptyContext, asOf);
    expect(result.bunching.standardDeduction).toBe(30_000);
    // even: 2 × max(30000, 40000) = 80,000; bunch: 60,000 + 30,000 = 90,000.
    expect(result.bunching.incrementalDeduction).toBe(10_000);
    expect(result.bunching.estimatedTaxSavings).toBe(2_900);
  });

  it('grants QCD eligibility from birth years and tracks remaining capacity', () => {
    const result = calculateGivingPlan({
      settings: { ...settings, birthYear: 1954, spouseBirthYear: 1958 },
      donations: [
        { id: 'q1', date: '2026-05-01', charity: 'IRA Custodian', kind: 'qcd', amount: 8_000, acknowledged: true },
      ],
    }, emptyContext, asOf);
    expect(result.qcd.selfEligible).toBe(true);
    expect(result.qcd.spouseEligible).toBe(false);
    expect(result.qcd.eligible).toBe(true);
    expect(result.qcd.annualLimitPerPerson).toBe(QCD_ANNUAL_LIMIT_PER_PERSON);
    expect(result.qcd.householdAnnualLimit).toBe(108_000);
    expect(result.qcd.qcdThisYear).toBe(8_000);
    expect(result.qcd.remainingCapacity).toBe(100_000);
  });

  it('counts both spouses toward household QCD capacity and ignores spouse when filing single', () => {
    const both = calculateGivingPlan({
      settings: { ...settings, birthYear: 1950, spouseBirthYear: 1952 },
      donations: [],
    }, emptyContext, asOf);
    expect(both.qcd.householdAnnualLimit).toBe(216_000);
    const single = calculateGivingPlan({
      settings: { ...settings, filingStatus: 'single', birthYear: null, spouseBirthYear: 1950 },
      donations: [],
    }, emptyContext, asOf);
    expect(single.qcd.eligible).toBe(false);
    expect(single.qcd.householdAnnualLimit).toBe(0);
  });

  it('passes the charity mileage context into the deductible giving total', () => {
    const result = calculateGivingPlan({
      settings,
      donations: [
        { id: 'd1', date: '2026-06-01', charity: 'Food Bank', kind: 'cash', amount: 500, acknowledged: true },
      ],
    }, { charityMiles: 120, charityMileageDeduction: 16.8 }, asOf);
    expect(result.charityMiles).toBe(120);
    expect(result.charityMileageDeduction).toBe(16.8);
    expect(result.currentYearDeductibleGiving).toBe(516.8);
  });
});
