/**
 * Invoice share links — token security tests.
 *
 * resolveShareToken must return null (indistinguishably) for malformed,
 * unknown, revoked, and expired tokens, and only build a document view for a
 * live token. Prisma is replaced with a controllable in-memory fake.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const db: {
  shareRow: any;
  estimateRow: any;
  customerRow: any;
  profileRow: any;
  findUniqueCalls: number;
} = {
  shareRow: null,
  estimateRow: null,
  customerRow: null,
  profileRow: null,
  findUniqueCalls: 0,
};

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_invoice_shares: {
      findUnique: vi.fn(async () => {
        db.findUniqueCalls++;
        return db.shareRow;
      }),
    },
    gnucash_web_estimates: {
      findFirst: vi.fn(async () => db.estimateRow),
    },
    customers: {
      findUnique: vi.fn(async () => db.customerRow),
    },
    gnucash_web_entity_profiles: {
      findUnique: vi.fn(async () => db.profileRow),
    },
  },
}));

// book-scope pulls in auth/session machinery — not needed for resolution.
vi.mock('@/lib/book-scope', () => ({
  getAccountGuidsForBook: vi.fn(async () => []),
}));

import {
  resolveShareToken,
  isShareActive,
  generateShareToken,
  parseEstimateShareRef,
  estimateShareRef,
  SHARE_TOKEN_RE,
} from '../invoice-shares.service';

const TOKEN = 'a'.repeat(48);

function shareRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    token: TOKEN,
    book_guid: 'book-1',
    invoice_guid: estimateShareRef(5),
    created_at: new Date('2026-07-01T00:00:00Z'),
    expires_at: null,
    revoked: false,
    ...overrides,
  };
}

beforeEach(() => {
  db.shareRow = null;
  db.estimateRow = null;
  db.customerRow = null;
  db.profileRow = null;
  db.findUniqueCalls = 0;
});

describe('token format + generation', () => {
  it('generates 48 lowercase hex chars', () => {
    const t = generateShareToken();
    expect(t).toMatch(SHARE_TOKEN_RE);
    expect(t).toHaveLength(48);
  });

  it('generates unique tokens', () => {
    expect(generateShareToken()).not.toBe(generateShareToken());
  });
});

describe('isShareActive', () => {
  const now = new Date('2026-07-16T00:00:00Z');

  it('is true for a non-revoked, non-expiring share', () => {
    expect(isShareActive({ revoked: false, expires_at: null }, now)).toBe(true);
  });

  it('is false when revoked', () => {
    expect(isShareActive({ revoked: true, expires_at: null }, now)).toBe(false);
  });

  it('is false at/after expiry, true before', () => {
    expect(isShareActive({ revoked: false, expires_at: new Date('2026-07-15T00:00:00Z') }, now)).toBe(false);
    expect(isShareActive({ revoked: false, expires_at: now }, now)).toBe(false);
    expect(isShareActive({ revoked: false, expires_at: new Date('2026-07-17T00:00:00Z') }, now)).toBe(true);
  });
});

describe('resolveShareToken — security', () => {
  it('rejects malformed tokens without touching the database', async () => {
    for (const bad of ['', 'short', 'A'.repeat(48), 'g'.repeat(48), `${'a'.repeat(48)}x`, '../../etc']) {
      expect(await resolveShareToken(bad)).toBeNull();
    }
    expect(db.findUniqueCalls).toBe(0);
  });

  it('returns null for an unknown token', async () => {
    db.shareRow = null;
    expect(await resolveShareToken(TOKEN)).toBeNull();
    expect(db.findUniqueCalls).toBe(1);
  });

  it('returns null for a revoked token', async () => {
    db.shareRow = shareRow({ revoked: true });
    expect(await resolveShareToken(TOKEN)).toBeNull();
  });

  it('returns null for an expired token', async () => {
    db.shareRow = shareRow({ expires_at: new Date(Date.now() - 1000) });
    expect(await resolveShareToken(TOKEN)).toBeNull();
  });

  it('returns null when the referenced document is gone', async () => {
    db.shareRow = shareRow(); // est:5
    db.estimateRow = null;
    expect(await resolveShareToken(TOKEN)).toBeNull();
  });

  it('resolves a live estimate token to its snapshot', async () => {
    db.shareRow = shareRow({ expires_at: new Date(Date.now() + 60_000) });
    db.estimateRow = {
      id: 5,
      book_guid: 'book-1',
      estimate_no: 'EST-0005',
      customer_guid: 'cust-1',
      date_created: new Date('2026-07-01T00:00:00Z'),
      expires: null,
      status: 'sent',
      converted_invoice_guid: null,
      notes: null,
      terms: 'Net 15',
      lines: [
        { id: 1, description: 'Consulting', quantity: '2', unit_price: '150', income_account_guid: 'acct', sort_order: 0 },
      ],
    };
    db.customerRow = {
      name: 'Acme Corp',
      addr_name: null,
      addr_addr1: '1 Main St',
      addr_addr2: null,
      addr_addr3: null,
      addr_addr4: null,
      addr_email: 'billing@acme.test',
    };
    db.profileRow = { entity_name: 'My Studio LLC' };

    const view = await resolveShareToken(TOKEN);
    expect(view).not.toBeNull();
    expect(view!.type).toBe('estimate');
    if (view!.type === 'estimate') {
      expect(view!.estimateNo).toBe('EST-0005');
      expect(view!.companyName).toBe('My Studio LLC');
      expect(view!.billTo).toEqual({ name: 'Acme Corp', lines: ['1 Main St'], email: 'billing@acme.test' });
      expect(view!.lines).toHaveLength(1);
      expect(view!.lines[0].amount).toBe(300);
      expect(view!.total).toBe(300);
    }
  });
});

describe('estimate share refs', () => {
  it('round-trips ids through the invoice_guid column encoding', () => {
    expect(parseEstimateShareRef(estimateShareRef(42))).toBe(42);
  });

  it('treats plain invoice GUIDs as non-estimate refs', () => {
    expect(parseEstimateShareRef('0123456789abcdef0123456789abcdef')).toBeNull();
    expect(parseEstimateShareRef('est:')).toBeNull();
    expect(parseEstimateShareRef('est:abc')).toBeNull();
    expect(parseEstimateShareRef('est:-3')).toBeNull();
  });
});
