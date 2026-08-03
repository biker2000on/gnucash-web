/**
 * Customer statements are book-scoped: a customer this book does not own reads
 * exactly as missing, and the loader never touches the customer row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { customers, ownership } = vi.hoisted(() => {
  const model = (...methods: string[]) =>
    Object.fromEntries(methods.map(m => [m, vi.fn()]));
  return {
    customers: model('findUnique', 'findMany'),
    ownership: model('findUnique', 'findMany'),
  };
});

vi.mock('@/lib/prisma', () => ({
  default: {
    customers,
    jobs: { findMany: vi.fn() },
    invoices: { findMany: vi.fn() },
    commodities: { findUnique: vi.fn() },
    gnucash_web_business_entity_ownership: ownership,
  },
}));

vi.mock('../invoice-engine', () => ({
  getInvoiceWithStatus: vi.fn(),
  listPayments: vi.fn(async () => []),
  OWNER_TYPE_CUSTOMER: 2,
  OWNER_TYPE_JOB: 3,
}));

import { getCustomerStatement, StatementNotFoundError } from '../customer-statement';

const BOOK_A = 'a'.repeat(32);
const BOOK_B = 'b'.repeat(32);
const CUSTOMER_B = '2'.repeat(32);

describe('getCustomerStatement book scope', () => {
  beforeEach(() => {
    customers.findUnique.mockReset();
    ownership.findUnique.mockReset();
    ownership.findMany.mockReset();
  });

  it('reports a foreign customer as not found', async () => {
    ownership.findUnique.mockResolvedValue({ book_guid: BOOK_B });
    customers.findUnique.mockResolvedValue({ guid: CUSTOMER_B });

    await expect(getCustomerStatement(BOOK_A, CUSTOMER_B, null, '2026-08-03'))
      .rejects.toThrow(StatementNotFoundError);
    expect(customers.findUnique).not.toHaveBeenCalled();
  });

  it('treats an unattributed customer as foreign', async () => {
    ownership.findUnique.mockResolvedValue(null);

    await expect(getCustomerStatement(BOOK_A, CUSTOMER_B, null, '2026-08-03'))
      .rejects.toThrow(StatementNotFoundError);
  });
});
