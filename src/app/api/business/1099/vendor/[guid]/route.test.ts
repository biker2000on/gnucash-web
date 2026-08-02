import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireRole, upsertVendorTaxInfo } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  upsertVendorTaxInfo: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole }));
vi.mock('@/lib/business/vendor-1099.service', () => {
  class Vendor1099ValidationError extends Error {}
  class Vendor1099NotFoundError extends Error {}
  return {
    upsertVendorTaxInfo,
    Vendor1099ValidationError,
    Vendor1099NotFoundError,
  };
});

import { PUT } from './route';
import { Vendor1099NotFoundError } from '@/lib/business/vendor-1099.service';

const GUID = 'a'.repeat(32);

describe('PUT /api/business/1099/vendor/[guid] book scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireRole.mockResolvedValue({
      bookGuid: 'book-a',
      role: 'edit',
      user: { id: 1 },
    });
  });

  it('passes the authorized book to the service and returns 404 for a foreign vendor row', async () => {
    upsertVendorTaxInfo.mockRejectedValue(
      new Vendor1099NotFoundError('Vendor tax info not found in this book'),
    );
    const request = new Request(`http://localhost/api/business/1099/vendor/${GUID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tinLast4: '1234', taxClassification: 'llc' }),
    });

    const response = await PUT(request, { params: Promise.resolve({ guid: GUID }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Vendor tax info not found in this book' });
    expect(upsertVendorTaxInfo).toHaveBeenCalledWith('book-a', GUID, expect.objectContaining({
      tinLast4: '1234',
      taxClassification: 'llc',
    }));
  });
});
