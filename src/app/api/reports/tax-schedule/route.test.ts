import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(), getBookAccountGuids: vi.fn(), generateTaxSchedule: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/book-scope', () => ({ getBookAccountGuids: mocks.getBookAccountGuids }));
vi.mock('@/lib/tax/tax-schedule', () => ({ generateTaxSchedule: mocks.generateTaxSchedule }));
vi.mock('@/lib/tax/txf', () => ({ saveTxfOverrides: vi.fn(), TxfOverrideValidationError: class extends Error {} }));

import { GET } from './route';

describe('GET /api/reports/tax-schedule TXF export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ bookGuid: 'b'.repeat(32), user: { id: 1 }, role: 'readonly' });
    mocks.getBookAccountGuids.mockResolvedValue(['a'.repeat(32)]);
    mocks.generateTaxSchedule.mockResolvedValue({
      year: 2025, generatedAt: '2026-01-01T00:00:00Z', unmappedTaxRelated: [], overrides: {},
      // A GnuCash capital-gains account already mapped to N684 must produce
      // exactly one TXF record; no lot-report record is appended.
      items: [{ code: 'N684', payerSupported: false, total: 8400, accounts: [] }],
    });
  });

  it('exports exactly one N684 record when the schedule already owns that code', async () => {
    const response = await GET(new Request('http://localhost/api/reports/tax-schedule?year=2025&format=txf') as NextRequest);
    const txf = await response.text();
    expect(response.status).toBe(200);
    expect(txf.match(/N684/g)).toHaveLength(1);
    expect(txf).toContain('$8400.00');
  });
});
