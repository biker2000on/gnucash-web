/**
 * Insurance profile zod-schema round-trip through the resilience service with
 * a mocked database, focused on the vault document linking field
 * (documentIds) and its backward compatibility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  stored: null as unknown,
}));

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) return { rows: [] };
    if (text.includes('INSERT INTO gnucash_web_resilience_profiles')) {
      state.stored = JSON.parse(params![2] as string);
      return { rows: [] };
    }
    if (text.includes('SELECT secret_encrypted')) return { rows: [] };
    if (text.includes('SELECT data')) {
      return {
        rows: state.stored === null
          ? []
          : [{ data: state.stored, secret_encrypted: null, updated_at: new Date() }],
      };
    }
    return { rows: [] };
  }),
}));
vi.mock('@/lib/secure-config', () => ({
  encryptSecret: vi.fn((value: string) => value),
  decryptSecret: vi.fn(() => null),
}));
vi.mock('@/lib/services/audit.service', () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/home.service', () => ({ listItems: vi.fn(async () => []) }));
vi.mock('@/lib/webhooks', () => ({ validateWebhookUrl: vi.fn(() => ({ ok: true })) }));
vi.mock('@/lib/provenance', () => ({ createCalculationTrace: vi.fn() }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => []) }));

import {
  getResilienceProfile,
  saveResilienceProfile,
  ResilienceValidationError,
} from '../service';
import type { InsuranceProfile } from '../types';

const BOOK = 'b'.repeat(32);

function policy(overrides: Partial<InsuranceProfile['policies'][number]> = {}) {
  return {
    id: 'policy-1',
    type: 'home' as const,
    provider: 'Acme Mutual',
    policyNumber: 'HO-99887766',
    coveredEntity: 'Primary residence',
    coverageLimit: 350_000,
    deductible: 2_500,
    annualPremium: 1_840.5,
    renewalDate: '2027-03-01',
    sublimits: [{ id: 'sub-1', category: 'Jewelry', limit: 5_000 }],
    documentIds: [3, 7],
    ...overrides,
  };
}

describe('insurance profile schema round-trip', () => {
  beforeEach(() => {
    state.stored = null;
  });

  it('round-trips a policy with linked vault documentIds', async () => {
    const saved = await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'insurance',
      data: { policies: [policy()] },
    }) as InsuranceProfile;
    expect(saved.policies[0].documentIds).toEqual([3, 7]);

    const loaded = await getResilienceProfile(BOOK, 'insurance') as InsuranceProfile;
    expect(loaded.policies).toHaveLength(1);
    expect(loaded.policies[0]).toMatchObject({
      provider: 'Acme Mutual',
      coverageLimit: 350_000,
      documentIds: [3, 7],
    });
  });

  it('defaults documentIds for profiles stored before document linking existed', async () => {
    const legacy = policy() as Record<string, unknown>;
    delete legacy.documentIds;
    state.stored = { policies: [legacy] };

    const loaded = await getResilienceProfile(BOOK, 'insurance') as InsuranceProfile;
    expect(loaded.policies[0].documentIds).toEqual([]);
  });

  it('rejects non-positive documentIds', async () => {
    await expect(saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'insurance',
      data: { policies: [policy({ documentIds: [-4] })] },
    })).rejects.toThrow(ResilienceValidationError);
  });
});
