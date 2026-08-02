import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateStatus: vi.fn(),
  updateLineItems: vi.fn(),
  upsertTemplate: vi.fn(),
  getMappings: vi.fn(),
  storageGet: vi.fn(),
  getAiConfig: vi.fn(),
  extractVision: vi.fn(),
  upsertDocument: vi.fn(),
  linkDocument: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: {
  gnucash_web_payslips: { findFirst: mocks.findFirst },
} }));
vi.mock('@/lib/payslips', () => ({
  updatePayslipStatus: mocks.updateStatus,
  updatePayslipLineItems: mocks.updateLineItems,
  upsertTemplate: mocks.upsertTemplate,
  getMappingsForEmployer: mocks.getMappings,
}));
vi.mock('@/lib/storage/storage-backend', () => ({
  getStorageBackend: vi.fn(async () => ({ get: mocks.storageGet })),
}));
vi.mock('@/lib/ai-config', () => ({ getAiConfig: mocks.getAiConfig }));
vi.mock('@/lib/payslip-extraction', () => ({ extractPayslipWithVision: mocks.extractVision }));
vi.mock('@/lib/documents', () => ({
  upsertDocument: mocks.upsertDocument,
  linkDocument: mocks.linkDocument,
}));

import { runPayslipExtraction } from '../payslip-extract-core';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue({
    id: 6,
    book_guid: 'book-1',
    created_by: 9,
    employer_name: 'Acme',
    storage_key: 'payslips/6.pdf',
    pay_date: new Date('2026-08-01'),
    pay_period_start: null,
    pay_period_end: null,
    line_items: [],
    raw_response: null,
    status: 'needs_mapping',
    transaction_guid: null,
  });
  mocks.storageGet.mockResolvedValue(Buffer.from('%PDF-1.4'));
  mocks.getAiConfig.mockResolvedValue({ enabled: true, base_url: 'http://ai', model: 'm' });
  mocks.extractVision.mockResolvedValue({
    employer_name: 'Acme',
    pay_date: '2026-08-01',
    pay_period_start: null,
    pay_period_end: null,
    gross_pay: 100,
    net_pay: 80,
    line_items: [{
      category: 'earnings', label: 'Pay', normalized_label: 'pay', amount: 100,
    }],
  });
  mocks.getMappings.mockResolvedValue([]);
});

describe('runPayslipExtraction canonical sidecar', () => {
  it('keeps successful extraction status when canonical indexing fails', async () => {
    mocks.upsertDocument.mockRejectedValueOnce(new Error('canonical database unavailable'));

    await expect(runPayslipExtraction(6, 'book-1', '[test]')).resolves.toBeUndefined();

    const statuses = mocks.updateStatus.mock.calls.map((call) => call[1]);
    expect(statuses).toEqual(['processing', 'needs_mapping']);
    expect(mocks.updateLineItems).toHaveBeenCalledOnce();
  });
});
