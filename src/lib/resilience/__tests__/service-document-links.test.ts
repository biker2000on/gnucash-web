import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  profiles: new Map<string, unknown>(),
}));
const { listLinkedDocuments, unlinkDocumentLinksForTarget, createCalculationTrace, logAudit } = vi.hoisted(() => ({
  listLinkedDocuments: vi.fn(),
  unlinkDocumentLinksForTarget: vi.fn(),
  createCalculationTrace: vi.fn((input: { evidence?: unknown[] }) => ({ evidence: input.evidence ?? [] })),
  logAudit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) return { rows: [] };
    if (text.includes('INSERT INTO gnucash_web_resilience_profiles')) {
      state.profiles.set(params![1] as string, JSON.parse(params![2] as string));
      return { rows: [] };
    }
    if (text.includes('SELECT secret_encrypted')) return { rows: [] };
    if (text.includes('SELECT data')) {
      const value = state.profiles.get(params![1] as string);
      return { rows: value === undefined ? [] : [{ data: value, secret_encrypted: null }] };
    }
    return { rows: [] };
  }),
}));
vi.mock('@/lib/documents', () => ({ listLinkedDocuments }));
vi.mock('@/lib/services/document-link-targets.service', () => ({ unlinkDocumentLinksForTarget }));
vi.mock('@/lib/secure-config', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/services/audit.service', () => ({ logAudit }));
vi.mock('@/lib/services/home.service', () => ({ listItems: vi.fn(async () => []) }));
vi.mock('@/lib/webhooks', () => ({ validateWebhookUrl: vi.fn(() => ({ ok: true })) }));
vi.mock('@/lib/provenance', () => ({ createCalculationTrace }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => []) }));

import { loadResilienceActions, saveResilienceProfile } from '../service';
import type { GivingProfile, RentalsProfile } from '../types';

const BOOK = 'b'.repeat(32);
const givingSettings: GivingProfile['settings'] = {
  filingStatus: 'married_joint',
  marginalRatePct: 22,
  stateRatePct: 0,
  agiEstimate: null,
  birthYear: null,
  spouseBirthYear: null,
  plannedAnnualGiving: 0,
  standardDeductionOverride: null,
  otherItemizedAnnual: 0,
};

function linked(targetId: string, role: string, id: number) {
  return {
    document: {
      id,
      title: `${role} document`,
      filename: `${role}.pdf`,
      sourceKind: 'upload',
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    },
    link: { targetId, role },
  };
}

describe('resilience canonical document links', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    state.profiles.clear();
    listLinkedDocuments.mockResolvedValue([]);
    unlinkDocumentLinksForTarget.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps a committed save successful and retries dangling cleanup on the next save', async () => {
    state.profiles.set('giving', {
      donations: [
        { id: 'keep', date: '2026-01-01', charity: 'Food Bank', kind: 'cash', amount: 300, acknowledged: false, documentRef: 'legacy note' },
        { id: 'remove', date: '2026-02-01', charity: 'Shelter', kind: 'cash', amount: 400, acknowledged: false },
      ],
      settings: givingSettings,
    });
    listLinkedDocuments.mockResolvedValue([linked('remove', 'acknowledgment', 5)]);
    unlinkDocumentLinksForTarget
      .mockRejectedValueOnce(new Error('temporary cleanup failure'))
      .mockResolvedValueOnce(1);
    const savedProfile: GivingProfile = {
      donations: [{ id: 'keep', date: '2026-01-01', charity: 'Food Bank', kind: 'cash', amount: 300, acknowledged: false, documentRef: 'legacy note' }],
      settings: givingSettings,
    };

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'giving',
      data: savedProfile,
    })).resolves.toMatchObject({ donations: [expect.objectContaining({ id: 'keep' })] });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      'Resilience giving document-link cleanup failed:',
      expect.any(Error),
    );

    await expect(saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'giving',
      data: savedProfile,
    })).resolves.toMatchObject({ donations: [expect.objectContaining({ documentRef: 'legacy note' })] });
    expect(unlinkDocumentLinksForTarget).toHaveBeenCalledTimes(2);
    expect(unlinkDocumentLinksForTarget).toHaveBeenLastCalledWith(BOOK, 'giving_donation', 'remove');
    expect(logAudit).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it('batches rental/giving evidence and verifies only explicit roles', async () => {
    const rentals: RentalsProfile = {
      properties: [{
        id: 'property-1',
        name: 'Oak House',
        address: '1 Oak St',
        units: [{
          id: 'unit-1',
          name: 'Unit 1',
          tenantName: 'Alex',
          tenantEmail: '',
          leaseStart: '2025-09-01',
          leaseEnd: '2026-08-31',
          monthlyRent: 1200,
          rentDueDay: 1,
          securityDeposit: 1200,
          lateFee: 50,
          annualEscalationPercent: 3,
          payments: [],
        }],
      }],
    };
    const giving: GivingProfile = {
      donations: [{
        id: 'donation-1',
        date: '2026-05-01',
        charity: 'Museum',
        kind: 'noncash',
        amount: 6001,
        acknowledged: false,
        documentRef: 'legacy free text only',
      }],
      settings: givingSettings,
    };
    state.profiles.set('rentals', rentals);
    state.profiles.set('giving', giving);
    listLinkedDocuments.mockImplementation(async ({ targetType }: { targetType: string }) => {
      if (targetType === 'rental_unit') return [
        linked('unit-1', 'lease', 11),
        linked('unit-1', 'tenant_notice', 12),
      ];
      if (targetType === 'giving_donation') return [
        linked('donation-1', 'acknowledgment', 21),
        linked('donation-1', 'appraisal', 22),
        linked('donation-1', 'form_8283', 23),
      ];
      return [];
    });

    const actions = await loadResilienceActions(BOOK);
    expect(listLinkedDocuments).toHaveBeenCalledTimes(2);
    expect(listLinkedDocuments).toHaveBeenCalledWith({ bookGuid: BOOK, targetType: 'rental_unit' });
    expect(listLinkedDocuments).toHaveBeenCalledWith({ bookGuid: BOOK, targetType: 'giving_donation' });
    expect(actions.find(action => action.stableKey.startsWith('lease-renewal:'))?.trace.evidence[0])
      .toMatchObject({ verified: true, metadata: { requiredDocumentRole: 'lease' } });
    expect(actions.find(action => action.stableKey === 'giving:ack:donation-1')?.trace.evidence[0])
      .toMatchObject({ verified: true, metadata: { requiredDocumentRole: 'acknowledgment' } });
    expect(actions.find(action => action.stableKey === 'giving:appraisal:donation-1')?.trace.evidence[0])
      .toMatchObject({ verified: true, metadata: { requiredDocumentRole: 'appraisal' } });
    expect(actions.find(action => action.stableKey === 'giving:8283:2026')?.trace.evidence[0])
      .toMatchObject({ verified: true, metadata: { requiredDocumentRole: 'form_8283' } });
  });

  it('retains legacy documentRef without treating free text as canonical proof', async () => {
    state.profiles.set('giving', {
      donations: [{
        id: 'legacy-donation',
        date: '2026-06-01',
        charity: 'Community Fund',
        kind: 'cash',
        amount: 500,
        acknowledged: false,
        documentRef: 'Letter is in the blue filing cabinet',
      }],
      settings: givingSettings,
    });
    listLinkedDocuments.mockResolvedValue([]);

    const actions = await loadResilienceActions(BOOK);
    expect(actions.find(action => action.stableKey === 'giving:ack:legacy-donation')?.trace.evidence[0])
      .toMatchObject({ verified: false, metadata: { requiredDocumentRole: 'acknowledgment' } });
  });
});
