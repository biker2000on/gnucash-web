import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listLinkedDocuments, getEntityProfile, getFarmCertificateObligations } = vi.hoisted(() => ({
  listLinkedDocuments: vi.fn(),
  getEntityProfile: vi.fn(),
  getFarmCertificateObligations: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_compliance_status: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('@/lib/services/entity.service', () => ({ getEntityProfile }));
vi.mock('@/lib/tax/farm-certificates', () => ({ getFarmCertificateObligations }));
vi.mock('@/lib/documents', () => ({
  listLinkedDocuments,
  getDocumentBySource: vi.fn(async () => null),
}));

import { complianceActions } from '../sources';

describe('compliance canonical document evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    getEntityProfile.mockResolvedValue({
      entityType: 'household',
      taxState: null,
      businessActivity: 'general',
    });
    getFarmCertificateObligations.mockResolvedValue([]);
    listLinkedDocuments.mockResolvedValue([{
      document: {
        id: 81,
        title: 'Estimated payment receipt',
        filename: 'payment.pdf',
        sourceKind: 'upload',
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
      link: {
        targetId: 'fed-1040es:2026-Q3',
        role: 'payment_confirmation',
      },
    }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('batches the target read and verifies only the required role without resolving the action', async () => {
    const actions = await complianceActions(7, 'book-1');
    const quarterly = actions.find(action => action.sourceId === 'fed-1040es:2026-Q3');

    expect(listLinkedDocuments).toHaveBeenCalledTimes(1);
    expect(listLinkedDocuments).toHaveBeenCalledWith({
      bookGuid: 'book-1',
      targetType: 'compliance_item',
    });
    expect(quarterly).toBeDefined();
    expect(quarterly!.trace.evidence[0]).toMatchObject({
      verified: true,
      metadata: { requiredDocumentRole: 'payment_confirmation' },
    });
    expect(quarterly!.trace.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '81',
        metadata: expect.objectContaining({ documentRole: 'payment_confirmation' }),
      }),
    ]));
  });
});
