/**
 * Contractor 1099 compliance Action Center adapter.
 *
 * The compliance data loader is mocked and fed through the REAL pure engine
 * (summarizeVendor1099Compliance) so the adapter is exercised against the
 * exact row shapes production produces. The clock is frozen at
 * 2026-08-01T12:00:00Z, so the filing window is open for tax year 2025
 * (deadline passed) and not yet open for 2026 (due 2027-01-31).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeVendor1099Compliance, type Vendor1099ComplianceInput } from '@/lib/business/vendor-1099-compliance';
import { get1099Compliance } from '@/lib/business/vendor-1099.service';
import { vendor1099ComplianceActions } from '../sources';

const listLinkedDocuments = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/business/vendor-1099.service', () => ({
  get1099Compliance: vi.fn(),
}));
vi.mock('@/lib/documents', () => ({
  listLinkedDocuments,
  getDocumentBySource: vi.fn(async () => null),
}));

const G_LANDSCAPER = 'a'.repeat(32);
const G_FILED = 'b'.repeat(32);
const G_DESIGNER = 'c'.repeat(32);
const G_READY = 'd'.repeat(32);
const G_TINY = 'e'.repeat(32);

const vendor = (overrides: Partial<Vendor1099ComplianceInput>): Vendor1099ComplianceInput => ({
  vendorGuid: G_LANDSCAPER,
  name: 'Landscaper LLC',
  totalPaid: 5000,
  exemptFrom1099: false,
  w9Received: false,
  w9RequestedDate: null,
  tinOnFile: false,
  filedDate: null,
  ...overrides,
});

const VENDORS_BY_YEAR: Record<number, Vendor1099ComplianceInput[]> = {
  2025: [
    vendor({}),
    vendor({ vendorGuid: G_FILED, name: 'Filed Contractor', totalPaid: 900, w9Received: true, filedDate: '2026-01-20' }),
  ],
  2026: [
    vendor({ vendorGuid: G_DESIGNER, name: 'Design Studio', totalPaid: 1500 }),
    vendor({ vendorGuid: G_READY, name: 'Ready Vendor', totalPaid: 700, w9Received: true }),
    vendor({ vendorGuid: G_TINY, name: 'Tiny Vendor', totalPaid: 100 }),
  ],
};

describe('vendor1099ComplianceActions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    vi.mocked(get1099Compliance).mockImplementation(
      async (_bookGuid, _guids, taxYear, asOf) =>
        summarizeVendor1099Compliance(taxYear, VENDORS_BY_YEAR[taxYear] ?? [], asOf),
    );
    listLinkedDocuments.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('checks the prior and current tax years', async () => {
    await vendor1099ComplianceActions('book-1', ['acct-1']);
    const years = vi.mocked(get1099Compliance).mock.calls.map(call => call[2]);
    expect(years).toEqual([2025, 2026]);
    expect(listLinkedDocuments).toHaveBeenCalledTimes(1);
    expect(listLinkedDocuments).toHaveBeenCalledWith({
      bookGuid: 'book-1',
      targetType: 'vendor_1099',
    });
  });

  it('emits W-9 and filing candidates with the documented lanes and severities', async () => {
    const actions = await vendor1099ComplianceActions('book-1', ['acct-1']);

    expect(actions.map(action => action.stableKey).sort()).toEqual([
      `vendor-1099:filing:${G_LANDSCAPER}:2025`,
      `vendor-1099:w9:${G_LANDSCAPER}:2025`,
      `vendor-1099:w9:${G_DESIGNER}:2026`,
    ]);

    const w9Prior = actions.find(a => a.stableKey === `vendor-1099:w9:${G_LANDSCAPER}:2025`)!;
    expect(w9Prior).toMatchObject({
      lane: 'fix',
      origin: 'vendor_1099',
      severity: 'warning',
      dueDate: '2026-01-31',
      impact: { low: 5000, high: 5000, period: 'one_time' },
      confidence: 1,
    });
    expect(w9Prior.operations).toEqual([
      { id: 'open', label: 'Open 1099 tracker', kind: 'link', href: '/business/reports/1099?year=2025', primary: true },
    ]);
    expect(w9Prior.trace.evidence[0]).toMatchObject({
      kind: 'vendor',
      id: G_LANDSCAPER,
      label: 'Landscaper LLC',
      source: 'system',
    });

    // Past Jan 31 with nothing recorded — the unfiled 1099 is critical.
    const filing = actions.find(a => a.stableKey === `vendor-1099:filing:${G_LANDSCAPER}:2025`)!;
    expect(filing).toMatchObject({
      lane: 'do',
      origin: 'vendor_1099',
      severity: 'critical',
      dueDate: '2026-01-31',
      impact: { low: 5000, high: 5000, period: 'one_time' },
    });

    // Current-year W-9 chase is info while the deadline is >60 days away,
    // and no filing candidate exists before the Jan 1 filing window.
    const w9Current = actions.find(a => a.stableKey === `vendor-1099:w9:${G_DESIGNER}:2026`)!;
    expect(w9Current).toMatchObject({ lane: 'fix', severity: 'info', dueDate: '2027-01-31' });
    expect(actions.some(a => a.stableKey.startsWith('vendor-1099:filing:') && a.stableKey.endsWith(':2026'))).toBe(false);

    // Filed, W-9-received, and below-threshold vendors are silent.
    for (const guid of [G_FILED, G_READY, G_TINY]) {
      expect(actions.some(a => a.stableKey.includes(guid))).toBe(false);
    }
  });

  it('returns nothing when no vendors are reportable', async () => {
    vi.mocked(get1099Compliance).mockImplementation(
      async (_bookGuid, _guids, taxYear, asOf) =>
        summarizeVendor1099Compliance(taxYear, [vendor({ totalPaid: 100 })], asOf),
    );
    await expect(vendor1099ComplianceActions('book-1', ['acct-1'])).resolves.toEqual([]);
  });

  it('attaches role-specific evidence without resolving source-status actions', async () => {
    const targetId = `${G_LANDSCAPER}:2025`;
    const updatedAt = new Date('2026-02-01T00:00:00Z');
    listLinkedDocuments.mockResolvedValue([
      {
        document: {
          id: 41,
          title: 'Signed W-9',
          filename: 'w9.pdf',
          sourceKind: 'upload',
          updatedAt,
        },
        link: { targetId, role: 'w9' },
      },
      {
        document: {
          id: 42,
          title: 'IRS filing receipt',
          filename: 'filing.pdf',
          sourceKind: 'upload',
          updatedAt,
        },
        link: { targetId, role: 'filing_proof' },
      },
    ]);

    const actions = await vendor1099ComplianceActions('book-1', ['acct-1']);
    const w9 = actions.find(action => action.stableKey === `vendor-1099:w9:${G_LANDSCAPER}:2025`)!;
    const filing = actions.find(action => action.stableKey === `vendor-1099:filing:${G_LANDSCAPER}:2025`)!;

    expect(w9.trace.evidence[0]).toMatchObject({ verified: true, metadata: { requiredDocumentRole: 'w9' } });
    expect(filing.trace.evidence[0]).toMatchObject({
      verified: true,
      metadata: { requiredDocumentRole: 'filing_proof' },
    });
    expect(filing.trace.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '42', verified: true, metadata: expect.objectContaining({ documentRole: 'filing_proof' }) }),
    ]));
    expect(actions.some(action => action.stableKey.includes(G_LANDSCAPER))).toBe(true);
    expect(listLinkedDocuments).toHaveBeenCalledTimes(1);
  });
});
