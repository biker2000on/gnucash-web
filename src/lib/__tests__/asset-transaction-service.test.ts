import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  accountFindUnique: vi.fn(),
  transactionCreate: vi.fn(),
  splitsCreateMany: vi.fn(),
  transaction: vi.fn(),
  logAudit: vi.fn(),
  assertAccountNotLocked: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: mocks.queryRaw,
    accounts: { findUnique: mocks.accountFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/services/audit.service', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/services/period-lock.service', () => ({
  assertAccountNotLocked: mocks.assertAccountNotLocked,
}));

import { adjustToTargetValue } from '../asset-transaction-service';

describe('adjustToTargetValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountFindUnique.mockResolvedValue({ commodity_guid: 'asset-commodity' });
    mocks.transactionCreate.mockResolvedValue({});
    mocks.splitsCreateMany.mockResolvedValue({ count: 2 });
    mocks.transaction.mockImplementation(async (callback) => callback({
      transactions: { create: mocks.transactionCreate },
      splits: { createMany: mocks.splitsCreateMany },
    }));
    mocks.logAudit.mockResolvedValue(undefined);
    mocks.assertAccountNotLocked.mockResolvedValue(undefined);
  });

  it('calculates an adjustment from account quantity when transaction value differs', async () => {
    // 10 asset units carried at $1,500 transaction value: target is 12 units.
    mocks.queryRaw.mockResolvedValue([
      { account_guid: 'asset-account', quantity_num: 10n, quantity_denom: 1n, value_num: 150000n, value_denom: 100n },
    ]);

    const result = await adjustToTargetValue({
      assetAccountGuid: 'asset-account',
      contraAccountGuid: 'income-account',
      targetValue: 12,
      date: '2026-08-13',
    });

    expect(result).toMatchObject({ adjustmentAmount: 2, type: 'appreciation' });
    expect(mocks.splitsCreateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ account_guid: 'asset-account', quantity_num: 200n, quantity_denom: 100n }),
      ]),
    }));
  });

  it('keeps native-currency adjustments unchanged when value equals quantity', async () => {
    mocks.queryRaw.mockResolvedValue([
      { account_guid: 'asset-account', quantity_num: 150000n, quantity_denom: 100n, value_num: 150000n, value_denom: 100n },
    ]);

    const result = await adjustToTargetValue({
      assetAccountGuid: 'asset-account',
      contraAccountGuid: 'expense-account',
      targetValue: 1400,
      date: '2026-08-13',
    });

    expect(result).toMatchObject({ adjustmentAmount: 100, type: 'depreciation' });
    expect(mocks.splitsCreateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ account_guid: 'asset-account', quantity_num: -10000n, quantity_denom: 100n }),
      ]),
    }));
  });
});
