import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import prisma from '../prisma';
import { findOrCreateAccount } from '../gnucash';

const mockFindFirst = vi.mocked(prisma.accounts.findFirst);
const mockCreate = vi.mocked(prisma.accounts.create);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findOrCreateAccount', () => {
  it('should return existing leaf account guid when full path exists', async () => {
    mockFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' } as any)
      .mockResolvedValueOnce({ guid: 'capgains-guid' } as any)
      .mockResolvedValueOnce({ guid: 'st-guid' } as any);

    const result = await findOrCreateAccount('Income:Capital Gains:Short Term', 'root-guid', 'usd-guid');
    expect(result).toBe('st-guid');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should create missing segments in the hierarchy', async () => {
    mockFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' } as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockCreate.mockResolvedValue({} as any);

    await findOrCreateAccount('Income:Capital Gains:Short Term', 'root-guid', 'usd-guid');
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // First: "Capital Gains" (placeholder)
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Capital Gains', account_type: 'INCOME', parent_guid: 'income-guid', placeholder: 1 }),
    });
    // Second: "Short Term" (not placeholder)
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Short Term', account_type: 'INCOME', placeholder: 0 }),
    });
  });

  it('should create entire hierarchy when nothing exists', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({} as any);
    await findOrCreateAccount('Income:Capital Gains:Long Term', 'root-guid', 'usd-guid');
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('should use correct commodity_guid and commodity_scu', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({} as any);
    await findOrCreateAccount('Income:Gains', 'root-guid', 'my-currency');
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ commodity_guid: 'my-currency', commodity_scu: 100 }),
    });
  });
});
