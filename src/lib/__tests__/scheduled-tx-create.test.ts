/**
 * Scheduled Transaction Create Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
vi.mock('../prisma', () => {
  const mockTx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };

  return {
    default: {
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
        return fn(mockTx);
      }),
      __mockTx: mockTx,
    },
  };
});

// Mock gnucash utilities
vi.mock('../gnucash', () => {
  let guidCounter = 0;
  return {
    generateGuid: vi.fn(() => `guid${String(++guidCounter).padStart(29, '0')}`),
    fromDecimal: vi.fn((value: number) => ({
      num: BigInt(Math.round(value * 100)),
      denom: 100n,
    })),
  };
});

import prisma from '../prisma';
import {
  createScheduledTransaction,
  CreateScheduledTxInput,
} from '../../lib/services/scheduled-tx-create';

// Get mock tx from prisma mock
const mockTx = (prisma as unknown as { __mockTx: { $queryRaw: ReturnType<typeof vi.fn>; $executeRaw: ReturnType<typeof vi.fn> } }).__mockTx;

function makeValidInput(overrides?: Partial<CreateScheduledTxInput>): CreateScheduledTxInput {
  return {
    name: 'Monthly Rent',
    startDate: '2026-04-01',
    endDate: null,
    recurrence: {
      periodType: 'month',
      mult: 1,
      periodStart: '2026-04-01',
      weekendAdjust: 'none',
    },
    splits: [
      { accountGuid: 'acct0000000000000000000000001', amount: 1000 },
      { accountGuid: 'acct0000000000000000000000002', amount: -1000 },
    ],
    autoCreate: true,
    autoNotify: false,
    ...overrides,
  };
}

describe('scheduled-tx-create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create full template structure on happy path', async () => {
    const input = makeValidInput();

    // Mock template root query
    mockTx.$queryRaw.mockResolvedValueOnce([
      { guid: 'templateroot00000000000000001' },
    ]);

    // Mock currency query
    mockTx.$queryRaw.mockResolvedValueOnce([
      { guid: 'usd00000000000000000000000001' },
    ]);

    // Mock all executeRaw calls
    mockTx.$executeRaw.mockResolvedValue(1);

    const result = await createScheduledTransaction(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.guid).toBeDefined();
      expect(result.guid.length).toBeGreaterThan(0);
    }

    // 2 queryRaw calls: template root + currency
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(2);

    // Count executeRaw calls:
    // 1 (SX root account) + 2*2 (child account + slot per split) + 1 (transaction) + 2 (splits) + 1 (schedxaction) + 1 (recurrence) = 10
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(10);
  });

  it('should reject unbalanced splits', async () => {
    const input = makeValidInput({
      splits: [
        { accountGuid: 'acct0000000000000000000000001', amount: 1000 },
        { accountGuid: 'acct0000000000000000000000002', amount: -500 },
      ],
    });

    const result = await createScheduledTransaction(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('balance');
    }

    // Should not touch the database
    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
  });

  it('should allow splits within floating point tolerance', async () => {
    const input = makeValidInput({
      splits: [
        { accountGuid: 'acct0000000000000000000000001', amount: 33.33 },
        { accountGuid: 'acct0000000000000000000000002', amount: 33.33 },
        { accountGuid: 'acct0000000000000000000000003', amount: -66.66 },
      ],
    });

    // Mock template root query
    mockTx.$queryRaw.mockResolvedValueOnce([
      { guid: 'templateroot00000000000000001' },
    ]);

    // Mock currency query
    mockTx.$queryRaw.mockResolvedValueOnce([
      { guid: 'usd00000000000000000000000001' },
    ]);

    mockTx.$executeRaw.mockResolvedValue(1);

    const result = await createScheduledTransaction(input);

    expect(result.success).toBe(true);
  });

  it('should reject empty name', async () => {
    const input = makeValidInput({ name: '' });

    const result = await createScheduledTransaction(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Name');
    }

    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
  });

  it('should reject whitespace-only name', async () => {
    const input = makeValidInput({ name: '   ' });

    const result = await createScheduledTransaction(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Name');
    }
  });

  it('should reject invalid period type', async () => {
    const input = makeValidInput({
      recurrence: {
        periodType: 'biweekly',
        mult: 1,
        periodStart: '2026-04-01',
        weekendAdjust: 'none',
      },
    });

    const result = await createScheduledTransaction(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid period type');
    }

    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
  });

  it('should reject fewer than 2 splits', async () => {
    const input = makeValidInput({
      splits: [
        { accountGuid: 'acct0000000000000000000000001', amount: 0 },
      ],
    });

    const result = await createScheduledTransaction(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('2 splits');
    }
  });

  it('should handle all valid period types', async () => {
    const validTypes = [
      'once', 'daily', 'weekly', 'month', 'end of month',
      'semi_monthly', 'year', 'nth weekday', 'last weekday',
    ];

    for (const periodType of validTypes) {
      vi.clearAllMocks();

      const input = makeValidInput({
        recurrence: {
          periodType,
          mult: 1,
          periodStart: '2026-04-01',
          weekendAdjust: 'none',
        },
      });

      mockTx.$queryRaw.mockResolvedValueOnce([
        { guid: 'templateroot00000000000000001' },
      ]);
      mockTx.$queryRaw.mockResolvedValueOnce([
        { guid: 'usd00000000000000000000000001' },
      ]);
      mockTx.$executeRaw.mockResolvedValue(1);

      const result = await createScheduledTransaction(input);
      expect(result.success).toBe(true);
    }
  });
});
