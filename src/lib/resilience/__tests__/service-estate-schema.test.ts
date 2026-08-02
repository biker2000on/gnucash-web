/**
 * Estate profile zod-schema round-trip through the resilience service with a
 * mocked database, focused on member attribution (memberRole/memberName), the
 * one-to-one vault link (documentId), and backward compatibility with profiles
 * saved before either existed.
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
    if (text.includes('gnucash_web_entity_members')) {
      return { rows: [{ role: 'self', name: 'Justin Crawford' }, { role: 'spouse', name: 'Cara Crawford' }] };
    }
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
  getResilienceSection,
  saveResilienceProfile,
  ResilienceValidationError,
} from '../service';
import type { EstateProfile } from '../types';

const BOOK = 'b'.repeat(32);

const settings = {
  estimatedGrossEstate: 2_000_000,
  maritalStatus: 'married' as const,
  state: 'NC',
  reviewCycleYearsDefault: 3,
  survivorRunbookLocation: null,
  survivorRunbookUpdatedDate: null,
};

function estateProfile(documents: Array<Record<string, unknown>>, designations: Array<Record<string, unknown>> = []) {
  return { designations, documents, lifeEvents: [], settings };
}

describe('estate profile schema round-trip', () => {
  beforeEach(() => {
    state.stored = null;
  });

  it('round-trips member attribution and a linked vault documentId', async () => {
    const saved = await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'estate',
      data: estateProfile(
        [{
          id: 'doc-1',
          kind: 'healthcare_directive',
          label: 'Agents: Justin Crawford · Notarized',
          location: 'Fireproof safe',
          lastUpdatedDate: '2026-03-26',
          reviewCycleYears: 3,
          memberRole: 'spouse',
          memberName: 'Cara Crawford',
          documentId: 42,
        }],
        [{
          id: 'des-1',
          accountLabel: 'Fidelity 401k',
          accountType: 'retirement',
          primaryBeneficiary: 'Cara Crawford',
          lastReviewedDate: '2026-06-01',
          memberRole: 'self',
          memberName: 'Justin Crawford',
        }],
      ),
    }) as EstateProfile;
    expect(saved.documents[0]).toMatchObject({ memberRole: 'spouse', memberName: 'Cara Crawford', documentId: 42 });
    expect(saved.designations[0]).toMatchObject({ memberRole: 'self', memberName: 'Justin Crawford' });

    const loaded = await getResilienceProfile(BOOK, 'estate') as EstateProfile;
    expect(loaded.documents[0]).toMatchObject({ memberRole: 'spouse', memberName: 'Cara Crawford', documentId: 42 });
  });

  it('defaults attribution to household for profiles saved before it existed', async () => {
    // Exactly what an older save looks like: no memberRole, memberName, documentId.
    state.stored = estateProfile(
      [{ id: 'doc-1', kind: 'will', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3 }],
      [{ id: 'des-1', accountLabel: 'HSA', accountType: 'hsa', primaryBeneficiary: 'Spouse', lastReviewedDate: '2026-01-01' }],
    );

    const loaded = await getResilienceProfile(BOOK, 'estate') as EstateProfile;
    expect(loaded.documents[0]).toMatchObject({ memberRole: 'household', memberName: '' });
    expect(loaded.documents[0].documentId).toBeUndefined();
    expect(loaded.designations[0]).toMatchObject({ memberRole: 'household', memberName: '' });

    // …and it still computes, now with per-adult coverage from the roster.
    const section = await getResilienceSection(BOOK, 'estate') as { readiness: { coverage: { members: Array<{ role: string }> } } };
    expect(section.readiness.coverage.members.map(member => member.role)).toEqual(['self', 'spouse']);
  });

  it('rejects an unknown member role and a non-positive documentId', async () => {
    await expect(saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'estate',
      data: estateProfile([{ id: 'doc-1', kind: 'will', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3, memberRole: 'cousin' }]),
    })).rejects.toThrow(ResilienceValidationError);

    await expect(saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'estate',
      data: estateProfile([{ id: 'doc-1', kind: 'will', location: 'Safe', lastUpdatedDate: '2026-01-01', reviewCycleYears: 3, documentId: 0 }]),
    })).rejects.toThrow(ResilienceValidationError);
  });
});
