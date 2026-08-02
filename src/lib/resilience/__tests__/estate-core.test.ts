import { describe, expect, it } from 'vitest';
import {
  FEDERAL_ESTATE_EXEMPTION_2026,
  calculateEstateReadiness,
  type EstateHouseholdMember,
} from '../estate-core';
import type { EstateDocument, EstateProfile, EstateSettings } from '../types';

const asOf = new Date('2026-08-01T12:00:00Z');

const settings: EstateSettings = {
  estimatedGrossEstate: 2_000_000,
  maritalStatus: 'married',
  state: 'NC',
  reviewCycleYearsDefault: 3,
  survivorRunbookLocation: null,
  survivorRunbookUpdatedDate: null,
};

describe('calculateEstateReadiness', () => {
  it('marks designations stale after the most recent life event and names the trigger', () => {
    const profile: EstateProfile = {
      designations: [
        { id: 'des1', accountLabel: 'Fidelity 401k', accountType: 'retirement', primaryBeneficiary: 'Spouse', contingentBeneficiary: 'Trust', lastReviewedDate: '2026-01-15' },
        { id: 'des2', accountLabel: 'Term life policy', accountType: 'life_insurance', primaryBeneficiary: 'Spouse', lastReviewedDate: '2026-05-01' },
      ],
      documents: [],
      lifeEvents: [
        { id: 'ev1', date: '2026-03-10', kind: 'birth', description: 'Third child' },
        { id: 'ev2', date: '2026-12-25', kind: 'move' },
      ],
      settings,
    };
    const result = calculateEstateReadiness(profile, asOf);
    const [first, second] = result.designations;
    expect(first.stale).toBe(true);
    expect(first.staleReason).toBe('life_event');
    expect(first.triggeringLifeEvent?.id).toBe('ev1');
    expect(first.daysSinceReview).toBe(198);
    // The 2026-12-25 event is after asOf and must be ignored.
    expect(second.stale).toBe(false);
    expect(second.staleReason).toBeNull();
    expect(second.triggeringLifeEvent).toBeNull();
    expect(result.staleDesignationCount).toBe(1);
  });

  it('marks designations stale by age using the default review cycle with an exact boundary', () => {
    const profile: EstateProfile = {
      designations: [
        { id: 'old', accountLabel: 'HSA', accountType: 'hsa', primaryBeneficiary: 'Spouse', lastReviewedDate: '2023-07-31' },
        { id: 'edge', accountLabel: 'Brokerage TOD', accountType: 'tod_investment', primaryBeneficiary: 'Spouse', lastReviewedDate: '2023-08-01' },
      ],
      documents: [],
      lifeEvents: [],
      settings,
    };
    const result = calculateEstateReadiness(profile, asOf);
    expect(result.designations[0].staleReason).toBe('age');
    expect(result.designations[0].daysSinceReview).toBe(1097);
    // Exactly three years old is not yet past the cycle.
    expect(result.designations[1].staleReason).toBeNull();
    expect(result.designations[1].daysSinceReview).toBe(1096);
  });

  it('prefers the life_event stale reason over age when both apply', () => {
    const result = calculateEstateReadiness({
      designations: [
        { id: 'des1', accountLabel: 'IRA', accountType: 'retirement', primaryBeneficiary: 'Spouse', lastReviewedDate: '2022-01-01' },
      ],
      documents: [],
      lifeEvents: [{ id: 'ev1', date: '2025-06-15', kind: 'marriage' }],
      settings,
    }, asOf);
    expect(result.designations[0].staleReason).toBe('life_event');
    expect(result.designations[0].triggeringLifeEvent?.id).toBe('ev1');
  });

  it('computes document due dates, overdue flags, and life-event triggers', () => {
    const result = calculateEstateReadiness({
      designations: [],
      documents: [
        { id: 'doc1', kind: 'will', location: 'Fireproof safe', lastUpdatedDate: '2024-06-30', reviewCycleYears: 3 },
        { id: 'doc2', kind: 'financial_poa', location: 'Attorney', lastUpdatedDate: '2021-05-10', reviewCycleYears: 3 },
        { id: 'doc3', kind: 'healthcare_poa', location: 'Attorney', lastUpdatedDate: '2025-03-01', reviewCycleYears: 3 },
      ],
      lifeEvents: [
        { id: 'ev1', date: '2025-01-20', kind: 'marriage' },
        { id: 'ev2', date: '2026-05-01', kind: 'move' },
      ],
      settings,
    }, asOf);
    const [will, poa, healthcare] = result.documents;
    expect(will.dueDate).toBe('2027-06-30');
    expect(will.overdue).toBe(false);
    expect(will.daysUntilDue).toBe(333);
    // Updated before the 2025 marriage, so the marriage triggers a review.
    expect(will.lifeEventTrigger?.id).toBe('ev1');
    expect(poa.dueDate).toBe('2024-05-10');
    expect(poa.overdue).toBe(true);
    expect(poa.daysUntilDue).toBe(-813);
    // Updated after the marriage; the move event never triggers documents.
    expect(healthcare.lifeEventTrigger).toBeNull();
    expect(result.documentIssueCount).toBe(3); // will trigger + poa overdue, plus healthcare_directive missing
  });

  it('lists missing core documents and notes a revocable trust without requiring it', () => {
    const result = calculateEstateReadiness({
      designations: [],
      documents: [
        { id: 'doc1', kind: 'will', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
        { id: 'doc2', kind: 'revocable_trust', location: 'Attorney', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
      ],
      lifeEvents: [],
      settings,
    }, asOf);
    expect(result.coverage.missingCoreDocuments).toEqual(['financial_poa', 'healthcare_poa', 'healthcare_directive']);
    expect(result.coverage.hasRevocableTrust).toBe(true);
  });

  it('computes federal estate exposure for a single filer with the NC assumption', () => {
    const result = calculateEstateReadiness({
      designations: [],
      documents: [],
      lifeEvents: [],
      settings: { ...settings, maritalStatus: 'single', estimatedGrossEstate: 20_000_000 },
    }, asOf);
    expect(result.exposure.exemptionPerPerson).toBe(FEDERAL_ESTATE_EXEMPTION_2026);
    expect(result.exposure.exemptionApplied).toBe(15_000_000);
    expect(result.exposure.exposure).toBe(5_000_000);
    expect(result.exposure.topRatePct).toBe(40);
    expect(result.exposure.estimatedTax).toBe(2_000_000);
    expect(result.exposure.assumptions).toContain('North Carolina has no state estate or inheritance tax.');
  });

  it('doubles the exemption for a married couple with a portability assumption', () => {
    const covered = calculateEstateReadiness({
      designations: [],
      documents: [],
      lifeEvents: [],
      settings: { ...settings, estimatedGrossEstate: 20_000_000, state: 'VA' },
    }, asOf);
    expect(covered.exposure.exemptionApplied).toBe(30_000_000);
    expect(covered.exposure.exposure).toBe(0);
    expect(covered.exposure.estimatedTax).toBe(0);
    expect(covered.exposure.assumptions.some(line => line.includes('portability'))).toBe(true);
    expect(covered.exposure.assumptions.some(line => line.includes('North Carolina'))).toBe(false);
    const exposed = calculateEstateReadiness({
      designations: [],
      documents: [],
      lifeEvents: [],
      settings: { ...settings, estimatedGrossEstate: 40_000_000 },
    }, asOf);
    expect(exposed.exposure.exposure).toBe(10_000_000);
    expect(exposed.exposure.estimatedTax).toBe(4_000_000);
  });

  it('treats the survivor runbook as current only when present and within two years', () => {
    const current = calculateEstateReadiness({
      designations: [],
      documents: [],
      lifeEvents: [],
      settings: { ...settings, survivorRunbookLocation: 'Safe deposit box', survivorRunbookUpdatedDate: '2024-08-01' },
    }, asOf);
    expect(current.runbook.present).toBe(true);
    expect(current.runbook.current).toBe(true);
    expect(current.runbook.daysSinceUpdate).toBe(730);
    const stale = calculateEstateReadiness({
      designations: [],
      documents: [],
      lifeEvents: [],
      settings: { ...settings, survivorRunbookLocation: 'Safe deposit box', survivorRunbookUpdatedDate: '2024-07-31' },
    }, asOf);
    expect(stale.runbook.current).toBe(false);
    const missing = calculateEstateReadiness({ designations: [], documents: [], lifeEvents: [], settings }, asOf);
    expect(missing.runbook.present).toBe(false);
    expect(missing.runbook.current).toBe(false);
    expect(missing.runbook.daysSinceUpdate).toBeNull();
  });

  it('scores 100 when designations are current, core documents are fresh, and the runbook is current', () => {
    const result = calculateEstateReadiness({
      designations: [
        { id: 'des1', accountLabel: 'Fidelity 401k', accountType: 'retirement', primaryBeneficiary: 'Spouse', lastReviewedDate: '2026-06-01' },
      ],
      documents: [
        { id: 'doc1', kind: 'will', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
        { id: 'doc2', kind: 'financial_poa', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
        { id: 'doc3', kind: 'healthcare_poa', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
        { id: 'doc4', kind: 'healthcare_directive', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
      ],
      lifeEvents: [],
      settings: { ...settings, survivorRunbookLocation: 'Fireproof safe', survivorRunbookUpdatedDate: '2026-01-01' },
    }, asOf);
    expect(result.score).toBe(100);
    expect(result.staleDesignationCount).toBe(0);
    expect(result.documentIssueCount).toBe(0);
  });

  it('scores an empty profile at 40 and a mixed profile with exact component weights', () => {
    expect(calculateEstateReadiness({ designations: [], documents: [], lifeEvents: [], settings }, asOf).score).toBe(40);
    const mixed = calculateEstateReadiness({
      designations: [
        { id: 'stale', accountLabel: 'IRA', accountType: 'retirement', primaryBeneficiary: 'Spouse', lastReviewedDate: '2020-01-01' },
        { id: 'fresh', accountLabel: 'HSA', accountType: 'hsa', primaryBeneficiary: 'Spouse', lastReviewedDate: '2026-06-01' },
      ],
      documents: [
        { id: 'doc1', kind: 'will', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
        { id: 'doc2', kind: 'financial_poa', location: 'Safe', lastUpdatedDate: '2020-01-01', reviewCycleYears: 3 },
      ],
      lifeEvents: [],
      settings,
    }, asOf);
    // 1 of 2 designations current (20) + 1 of 4 core documents fresh (10) + no runbook (0).
    expect(mixed.score).toBe(30);
    expect(mixed.staleDesignationCount).toBe(1);
    expect(mixed.documentIssueCount).toBe(3); // financial_poa overdue + 2 missing core kinds
  });
});

describe('calculateEstateReadiness — per-member coverage', () => {
  const roster: EstateHouseholdMember[] = [
    { role: 'self', name: 'Justin Crawford' },
    { role: 'spouse', name: 'Cara Crawford' },
    // Dependents and business roles never get their own core-document checklist.
    { role: 'dependent', name: 'Kid Crawford' },
    { role: 'owner', name: 'Justin Crawford' },
  ];

  const document = (
    id: string,
    kind: EstateDocument['kind'],
    memberRole: EstateDocument['memberRole'],
    memberName = '',
  ): EstateDocument => ({
    id,
    kind,
    location: 'Fireproof safe',
    lastUpdatedDate: '2026-01-01',
    reviewCycleYears: 3,
    memberRole,
    memberName,
  });

  /** The real book: both adults have three of four, only one has a financial POA. */
  const realWorld: EstateProfile = {
    designations: [],
    documents: [
      document('d1', 'financial_poa', 'self', 'Justin Crawford'),
      document('d2', 'will', 'self', 'Justin Crawford'),
      document('d3', 'healthcare_poa', 'self', 'Justin Crawford'),
      document('d4', 'healthcare_directive', 'self', 'Justin Crawford'),
      document('d5', 'will', 'spouse', 'Cara Crawford'),
      document('d6', 'healthcare_poa', 'spouse', 'Cara Crawford'),
      document('d7', 'healthcare_directive', 'spouse', 'Cara Crawford'),
    ],
    lifeEvents: [],
    settings: { ...settings, survivorRunbookLocation: 'Fireproof safe', survivorRunbookUpdatedDate: '2026-01-01' },
  };

  it('reports core coverage for each adult and only the adults', () => {
    const result = calculateEstateReadiness(realWorld, asOf, roster);
    expect(result.coverage.members.map(member => member.role)).toEqual(['self', 'spouse']);
    expect(result.coverage.members[0]).toMatchObject({
      role: 'self',
      name: 'Justin Crawford',
      missingCoreDocuments: [],
      freshCoreCount: 4,
    });
    expect(result.coverage.members[1]).toMatchObject({
      role: 'spouse',
      name: 'Cara Crawford',
      missingCoreDocuments: ['financial_poa'],
      freshCoreCount: 3,
    });
    expect(result.coverage.missingByMember).toEqual([
      { role: 'spouse', name: 'Cara Crawford', kind: 'financial_poa' },
    ]);
    // The household rollup still says the kind exists somewhere.
    expect(result.coverage.missingCoreDocuments).toEqual([]);
  });

  it('lowers the score when one adult is missing a financial POA', () => {
    const perMember = calculateEstateReadiness(realWorld, asOf, roster);
    // No designations (40) + mean core completeness ((4/4 + 3/4) / 2 = 0.875 → 35) + runbook (20).
    expect(perMember.score).toBe(95);
    expect(perMember.documentIssueCount).toBe(1);
    // Without a roster the same profile looks perfect: one adult's POA covered everyone.
    const householdOnly = calculateEstateReadiness(realWorld, asOf);
    expect(householdOnly.score).toBe(100);
    expect(householdOnly.documentIssueCount).toBe(0);
    // Giving the spouse a financial POA closes the gap.
    const fixed = calculateEstateReadiness({
      ...realWorld,
      documents: [...realWorld.documents, document('d8', 'financial_poa', 'spouse', 'Cara Crawford')],
    }, asOf, roster);
    expect(fixed.score).toBe(100);
    expect(fixed.coverage.missingByMember).toEqual([]);
  });

  it('credits household-attributed documents to every adult', () => {
    const joint = calculateEstateReadiness({
      ...realWorld,
      documents: [
        document('j1', 'will', 'household'),
        document('j2', 'financial_poa', 'household'),
        document('j3', 'healthcare_poa', 'household'),
        document('j4', 'healthcare_directive', 'household'),
      ],
    }, asOf, roster);
    expect(joint.coverage.missingByMember).toEqual([]);
    expect(joint.coverage.members.every(member => member.freshCoreCount === 4)).toBe(true);
    expect(joint.score).toBe(100);
  });

  it('does not credit one adult with the other adult\'s documents', () => {
    const selfOnly = calculateEstateReadiness({
      ...realWorld,
      documents: realWorld.documents.filter(item => item.memberRole === 'self'),
    }, asOf, roster);
    expect(selfOnly.coverage.members[0].missingCoreDocuments).toEqual([]);
    expect(selfOnly.coverage.members[1].missingCoreDocuments).toEqual([
      'will', 'financial_poa', 'healthcare_poa', 'healthcare_directive',
    ]);
    expect(selfOnly.coverage.missingByMember).toHaveLength(4);
    // 40 designations + ((4/4 + 0/4) / 2 = 0.5 → 20) + 20 runbook.
    expect(selfOnly.score).toBe(80);
  });

  it('excludes overdue and life-event-triggered documents from an adult\'s fresh count', () => {
    const stale = calculateEstateReadiness({
      ...realWorld,
      documents: [
        { ...document('s1', 'will', 'self', 'Justin Crawford'), lastUpdatedDate: '2020-01-01' },
        document('s2', 'financial_poa', 'household'),
        document('s3', 'healthcare_poa', 'household'),
        document('s4', 'healthcare_directive', 'household'),
      ],
    }, asOf, roster);
    const [self, spouse] = stale.coverage.members;
    // The will is on file for self (so not "missing") but overdue, so it is not fresh.
    expect(self.missingCoreDocuments).toEqual([]);
    expect(self.freshCoreCount).toBe(3);
    expect(spouse.missingCoreDocuments).toEqual(['will']);
    expect(spouse.freshCoreCount).toBe(3);
  });

  it('falls back to household-level behaviour with an empty roster', () => {
    const noRoster = calculateEstateReadiness(realWorld, asOf, []);
    expect(noRoster.coverage.members).toEqual([]);
    expect(noRoster.coverage.missingByMember).toEqual([]);
    expect(noRoster.coverage.missingCoreDocuments).toEqual([]);
    expect(noRoster.score).toBe(calculateEstateReadiness(realWorld, asOf).score);
    // Business-only rosters have no household adults, so the fallback applies too.
    const businessRoster = calculateEstateReadiness(realWorld, asOf, [
      { role: 'owner', name: 'Justin Crawford' },
      { role: 'officer', name: 'Cara Crawford' },
    ]);
    expect(businessRoster.coverage.members).toEqual([]);
    expect(businessRoster.score).toBe(100);
  });

  it('treats documents with no attribution as household so old profiles still compute', () => {
    // Exactly the shape of a profile saved before member attribution existed.
    const legacy = calculateEstateReadiness({
      designations: [
        { id: 'des1', accountLabel: 'Fidelity 401k', accountType: 'retirement', primaryBeneficiary: 'Spouse', lastReviewedDate: '2026-06-01' },
      ],
      documents: [
        { id: 'doc1', kind: 'will', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
        { id: 'doc2', kind: 'financial_poa', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
        { id: 'doc3', kind: 'healthcare_poa', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
        { id: 'doc4', kind: 'healthcare_directive', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 },
      ],
      lifeEvents: [],
      settings: { ...settings, survivorRunbookLocation: 'Safe', survivorRunbookUpdatedDate: '2026-01-01' },
    }, asOf, roster);
    expect(legacy.coverage.missingByMember).toEqual([]);
    expect(legacy.score).toBe(100);
  });
});
