/**
 * Payslip CRUD Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  gnucash_web_payslips: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  gnucash_web_payslip_mappings: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  gnucash_web_payslip_templates: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({ default: mockPrisma }));

import {
  listPayslips,
  getPayslip,
  createPayslip,
  updatePayslipStatus,
  updatePayslipLineItems,
  getMappingsForEmployer,
  upsertMapping,
  deletePayslip,
  getTemplate,
  upsertTemplate,
} from '@/lib/payslips';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listPayslips', () => {
  it('returns payslips for a book ordered by pay_date desc', async () => {
    const mockPayslips = [
      { id: 2, book_guid: 'book1', pay_date: new Date('2024-02-01'), employer_name: 'ACME' },
      { id: 1, book_guid: 'book1', pay_date: new Date('2024-01-01'), employer_name: 'ACME' },
    ];
    mockPrisma.gnucash_web_payslips.findMany.mockResolvedValue(mockPayslips);

    const result = await listPayslips('book1');

    expect(mockPrisma.gnucash_web_payslips.findMany).toHaveBeenCalledWith({
      where: { book_guid: 'book1' },
      orderBy: { pay_date: 'desc' },
    });
    expect(result).toEqual(mockPayslips);
  });

  it('filters by status when provided', async () => {
    mockPrisma.gnucash_web_payslips.findMany.mockResolvedValue([]);

    await listPayslips('book1', { status: 'posted' });

    expect(mockPrisma.gnucash_web_payslips.findMany).toHaveBeenCalledWith({
      where: { book_guid: 'book1', status: 'posted' },
      orderBy: { pay_date: 'desc' },
    });
  });

  it('filters by employer when provided', async () => {
    mockPrisma.gnucash_web_payslips.findMany.mockResolvedValue([]);

    await listPayslips('book1', { employer: 'ACME Corp' });

    expect(mockPrisma.gnucash_web_payslips.findMany).toHaveBeenCalledWith({
      where: { book_guid: 'book1', employer_name: 'ACME Corp' },
      orderBy: { pay_date: 'desc' },
    });
  });

  it('filters by both status and employer when provided', async () => {
    mockPrisma.gnucash_web_payslips.findMany.mockResolvedValue([]);

    await listPayslips('book1', { status: 'ready', employer: 'ACME Corp' });

    expect(mockPrisma.gnucash_web_payslips.findMany).toHaveBeenCalledWith({
      where: { book_guid: 'book1', status: 'ready', employer_name: 'ACME Corp' },
      orderBy: { pay_date: 'desc' },
    });
  });
});

describe('getPayslip', () => {
  it('returns payslip by id and book_guid', async () => {
    const mockPayslip = { id: 1, book_guid: 'book1', employer_name: 'ACME' };
    mockPrisma.gnucash_web_payslips.findFirst.mockResolvedValue(mockPayslip);

    const result = await getPayslip(1, 'book1');

    expect(mockPrisma.gnucash_web_payslips.findFirst).toHaveBeenCalledWith({
      where: { id: 1, book_guid: 'book1' },
    });
    expect(result).toEqual(mockPayslip);
  });

  it('returns null when payslip not found', async () => {
    mockPrisma.gnucash_web_payslips.findFirst.mockResolvedValue(null);

    const result = await getPayslip(999, 'book1');

    expect(result).toBeNull();
  });
});

describe('createPayslip', () => {
  it('creates payslip with provided data and status defaults to processing', async () => {
    const inputData = {
      book_guid: 'book1',
      pay_date: new Date('2024-01-15'),
      employer_name: 'ACME Corp',
      gross_pay: 5000,
      net_pay: 3500,
    };
    const created = { id: 1, ...inputData, status: 'processing' };
    mockPrisma.gnucash_web_payslips.create.mockResolvedValue(created);

    const result = await createPayslip(inputData);

    expect(mockPrisma.gnucash_web_payslips.create).toHaveBeenCalledWith({
      data: { ...inputData, status: 'processing' },
    });
    expect(result).toEqual(created);
  });

  it('respects explicit status when provided', async () => {
    const inputData = {
      book_guid: 'book1',
      pay_date: new Date('2024-01-15'),
      employer_name: 'ACME Corp',
      status: 'needs_mapping' as const,
    };
    const created = { id: 1, ...inputData };
    mockPrisma.gnucash_web_payslips.create.mockResolvedValue(created);

    await createPayslip(inputData);

    expect(mockPrisma.gnucash_web_payslips.create).toHaveBeenCalledWith({
      data: { ...inputData, status: 'needs_mapping' },
    });
  });
});

describe('updatePayslipStatus', () => {
  it('updates status of a payslip', async () => {
    const updated = { id: 1, status: 'posted' };
    mockPrisma.gnucash_web_payslips.update.mockResolvedValue(updated);

    const result = await updatePayslipStatus(1, 'posted');

    expect(mockPrisma.gnucash_web_payslips.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: 'posted' },
    });
    expect(result).toEqual(updated);
  });

  it('updates status plus extra fields when provided', async () => {
    const updated = { id: 1, status: 'error', error_message: 'Parse failed' };
    mockPrisma.gnucash_web_payslips.update.mockResolvedValue(updated);

    const result = await updatePayslipStatus(1, 'error', { error_message: 'Parse failed' });

    expect(mockPrisma.gnucash_web_payslips.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: 'error', error_message: 'Parse failed' },
    });
    expect(result).toEqual(updated);
  });
});

describe('updatePayslipLineItems', () => {
  it('updates line_items JSONB field', async () => {
    const lineItems = [{ category: 'earnings' as const, label: 'Base Salary', normalized_label: 'base_salary', amount: 5000 }];
    const updated = { id: 1, line_items: lineItems };
    mockPrisma.gnucash_web_payslips.update.mockResolvedValue(updated);

    const result = await updatePayslipLineItems(1, lineItems);

    expect(mockPrisma.gnucash_web_payslips.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { line_items: lineItems },
    });
    expect(result).toEqual(updated);
  });

  it('also sets raw_response when provided', async () => {
    const lineItems = [{ category: 'tax' as const, label: 'Federal Tax', normalized_label: 'federal_tax', amount: 800 }];
    const rawResponse = { model: 'gpt-4', choices: [] };
    mockPrisma.gnucash_web_payslips.update.mockResolvedValue({ id: 1 });

    await updatePayslipLineItems(1, lineItems, rawResponse);

    expect(mockPrisma.gnucash_web_payslips.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { line_items: lineItems, raw_response: rawResponse },
    });
  });
});

describe('getMappingsForEmployer', () => {
  it('returns mappings for given book and employer', async () => {
    const mappings = [
      { id: 1, book_guid: 'book1', employer_name: 'ACME', normalized_label: 'base_salary', line_item_category: 'earnings', account_guid: 'acc1' },
    ];
    mockPrisma.gnucash_web_payslip_mappings.findMany.mockResolvedValue(mappings);

    const result = await getMappingsForEmployer('book1', 'ACME');

    expect(mockPrisma.gnucash_web_payslip_mappings.findMany).toHaveBeenCalledWith({
      where: { book_guid: 'book1', employer_name: 'ACME' },
    });
    expect(result).toEqual(mappings);
  });
});

describe('upsertMapping', () => {
  it('upserts mapping by composite unique key', async () => {
    const mappingData = {
      book_guid: 'book1',
      employer_name: 'ACME',
      normalized_label: 'base_salary',
      line_item_category: 'earnings',
      account_guid: 'acc1',
    };
    const upserted = { id: 1, ...mappingData };
    mockPrisma.gnucash_web_payslip_mappings.upsert.mockResolvedValue(upserted);

    const result = await upsertMapping(mappingData);

    expect(mockPrisma.gnucash_web_payslip_mappings.upsert).toHaveBeenCalledWith({
      where: {
        book_guid_employer_name_normalized_label_line_item_category: {
          book_guid: 'book1',
          employer_name: 'ACME',
          normalized_label: 'base_salary',
          line_item_category: 'earnings',
        },
      },
      create: mappingData,
      update: { account_guid: 'acc1' },
    });
    expect(result).toEqual(upserted);
  });
});

describe('deletePayslip', () => {
  it('deletes payslip by id and book_guid', async () => {
    const deleted = { id: 1, book_guid: 'book1' };
    mockPrisma.gnucash_web_payslips.delete.mockResolvedValue(deleted);

    const result = await deletePayslip(1, 'book1');

    expect(mockPrisma.gnucash_web_payslips.delete).toHaveBeenCalledWith({
      where: { id: 1, book_guid: 'book1' },
    });
    expect(result).toEqual(deleted);
  });
});

describe('getTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns template for employer', async () => {
    const template = {
      id: 1, book_guid: 'book123', employer_name: 'Acme',
      line_items: [{ category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay' }],
    };
    mockPrisma.gnucash_web_payslip_templates.findUnique.mockResolvedValue(template);
    const result = await getTemplate('book123', 'Acme');
    expect(mockPrisma.gnucash_web_payslip_templates.findUnique).toHaveBeenCalledWith({
      where: { book_guid_employer_name: { book_guid: 'book123', employer_name: 'Acme' } },
    });
    expect(result?.employer_name).toBe('Acme');
  });

  it('returns null when no template exists', async () => {
    mockPrisma.gnucash_web_payslip_templates.findUnique.mockResolvedValue(null);
    const result = await getTemplate('book123', 'Unknown');
    expect(result).toBeNull();
  });
});

describe('upsertTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts template by composite key', async () => {
    mockPrisma.gnucash_web_payslip_templates.upsert.mockResolvedValue({ id: 1 });
    const lineItems = [
      { category: 'earnings' as const, label: 'Regular Pay', normalized_label: 'regular_pay' },
    ];
    await upsertTemplate('book123', 'Acme', lineItems);
    expect(mockPrisma.gnucash_web_payslip_templates.upsert).toHaveBeenCalledWith({
      where: { book_guid_employer_name: { book_guid: 'book123', employer_name: 'Acme' } },
      create: { book_guid: 'book123', employer_name: 'Acme', line_items: lineItems },
      update: { line_items: lineItems, updated_at: expect.any(Date) },
    });
  });
});
