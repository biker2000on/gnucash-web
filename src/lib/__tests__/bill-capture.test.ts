import { describe, it, expect, vi } from 'vitest';

// bill-capture.ts touches prisma / storage / the invoice engine at module
// level; the pure helpers under test never do. Mock the heavy imports so the
// module loads without a database.
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/services/document-intake', () => ({ intakeReceipt: vi.fn() }));

import { normalizeVendorName, matchVendorByName } from '../business/bill-capture';
import { subjectRequestsBill } from '../email-ingest';

describe('bill-capture', () => {
  describe('subjectRequestsBill', () => {
    it('matches a "bill" subject prefix only', () => {
      expect(subjectRequestsBill('bill')).toBe(true);
      expect(subjectRequestsBill('Bill: Electric June')).toBe(true);
      expect(subjectRequestsBill('  bill - Acme Water')).toBe(true);
      expect(subjectRequestsBill('Billing update')).toBe(false);
      expect(subjectRequestsBill('Your bill is ready')).toBe(false);
      expect(subjectRequestsBill('')).toBe(false);
      expect(subjectRequestsBill(null)).toBe(false);
    });
  });

  describe('normalizeVendorName', () => {
    it('lowercases, strips punctuation and corporate suffixes', () => {
      expect(normalizeVendorName('ACME Power & Light, Inc.')).toBe('acme power light');
      expect(normalizeVendorName("O'Brien Plumbing LLC")).toBe('o brien plumbing');
      expect(normalizeVendorName('  Widget Co. ')).toBe('widget');
      expect(normalizeVendorName(null)).toBe('');
    });
  });

  describe('matchVendorByName', () => {
    const vendors = [
      { guid: 'v1', name: 'ACME Power & Light, Inc.' },
      { guid: 'v2', name: 'Widget Works LLC' },
      { guid: 'v3', name: 'Widget Warehouse' },
    ];

    it('matches exactly after normalization', () => {
      expect(matchVendorByName('acme power light', vendors)?.guid).toBe('v1');
      expect(matchVendorByName('ACME POWER & LIGHT INC', vendors)?.guid).toBe('v1');
    });

    it('accepts a unique containment match', () => {
      expect(matchVendorByName('ACME Power', vendors)?.guid).toBe('v1');
      expect(matchVendorByName('Widget Works LLC — Invoice Dept', vendors)?.guid).toBe('v2');
    });

    it('returns null for ambiguous or unknown names (never guesses)', () => {
      expect(matchVendorByName('Widget', vendors)).toBeNull(); // v2 and v3 both contain it
      expect(matchVendorByName('Unknown Utility', vendors)).toBeNull();
      expect(matchVendorByName('', vendors)).toBeNull();
      expect(matchVendorByName(null, vendors)).toBeNull();
    });
  });
});
