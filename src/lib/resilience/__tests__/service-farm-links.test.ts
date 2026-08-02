import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stored: null as unknown,
  validTransactions: new Set<string>(),
}));

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) return { rows: [] };
    if (text.includes('SELECT DISTINCT t.guid')) {
      const requested = params?.[0] as string[];
      return { rows: requested.filter(guid => state.validTransactions.has(guid)).map(guid => ({ guid })) };
    }
    if (text.includes('INSERT INTO gnucash_web_resilience_profiles')) {
      state.stored = JSON.parse(params![2] as string);
      return { rows: [] };
    }
    if (text.includes('SELECT secret_encrypted')) return { rows: [] };
    if (text.includes('SELECT data')) {
      return { rows: state.stored === null ? [] : [{ data: state.stored, secret_encrypted: null }] };
    }
    return { rows: [] };
  }),
}));
vi.mock('@/lib/secure-config', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/services/audit.service', () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/home.service', () => ({ listItems: vi.fn(async () => []) }));
vi.mock('@/lib/webhooks', () => ({ validateWebhookUrl: vi.fn(() => ({ ok: true })) }));
vi.mock('@/lib/provenance', () => ({ createCalculationTrace: vi.fn() }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => ['account-in-book']) }));

import { getResilienceProfile, ResilienceValidationError, saveResilienceProfile } from '../service';
import type { FarmProductionProfile } from '../types';

const BOOK = 'b'.repeat(32);
const VALID_TX = 'a'.repeat(32);
const FOREIGN_TX = 'c'.repeat(32);

function profile(transactionGuid: string | null): FarmProductionProfile {
  return {
    products: [{ id: 'honey', name: 'Honey', unit: 'jar', category: 'honey', targetPrice: 12 }],
    harvests: [],
    sales: [{
      id: 'sale-1',
      date: '2026-07-04',
      productId: 'honey',
      channel: 'farmers_market',
      quantity: 2,
      revenue: 24,
      transactionGuid,
      source: 'manual',
      sourceId: null,
    }],
    adjustments: [],
    costs: [],
    settings: { scheduleFNotes: null, defaultMarketDay: null },
  };
}

describe('farm production transaction links', () => {
  beforeEach(() => {
    state.stored = null;
    state.validTransactions.clear();
    state.validTransactions.add(VALID_TX);
  });

  it('accepts a transaction that has a split in the active book', async () => {
    const saved = await saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'farm_production',
      data: profile(VALID_TX),
    }) as FarmProductionProfile;
    expect(saved.sales[0].transactionGuid).toBe(VALID_TX);
  });

  it('rejects a well-formed transaction GUID from another book', async () => {
    await expect(saveResilienceProfile({
      bookGuid: BOOK,
      userId: 1,
      section: 'farm_production',
      data: profile(FOREIGN_TX),
    })).rejects.toThrow(ResilienceValidationError);
  });

  it('surfaces stale stored links as unlinked sales', async () => {
    state.stored = profile(FOREIGN_TX);
    const loaded = await getResilienceProfile(BOOK, 'farm_production') as FarmProductionProfile;
    expect(loaded.sales[0].transactionGuid).toBeNull();
  });
});
