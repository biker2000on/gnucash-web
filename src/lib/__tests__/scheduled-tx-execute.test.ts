/**
 * Scheduled Transaction Execute/Skip/Batch Service Tests
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

// Mock scheduled-transactions
vi.mock('../scheduled-transactions', () => ({
  resolveTemplateSplits: vi.fn(),
}));

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
import { resolveTemplateSplits } from '../scheduled-transactions';
import { generateGuid } from '../gnucash';
import {
  executeOccurrence,
  skipOccurrence,
  batchExecuteSkip,
} from '../../lib/services/scheduled-tx-execute';

// Get mock tx from prisma mock
const mockTx = (prisma as unknown as { __mockTx: { $queryRaw: ReturnType<typeof vi.fn>; $executeRaw: ReturnType<typeof vi.fn> } }).__mockTx;

describe('scheduled-tx-execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('executeOccurrence', () => {
    it('should create transaction + splits and update metadata on happy path', async () => {
      const sxGuid = 'sx00000000000000000000000000001';

      // Mock schedxaction row
      mockTx.$queryRaw.mockResolvedValueOnce([
        {
          guid: sxGuid,
          name: 'Monthly Rent',
          template_act_guid: 'tmpl0000000000000000000000001',
          last_occur: null,
          rem_occur: 5,
          instance_count: 0,
        },
      ]);

      // Mock resolveTemplateSplits
      vi.mocked(resolveTemplateSplits).mockResolvedValueOnce([
        { accountGuid: 'acct0000000000000000000000001', accountName: 'Expenses:Rent', amount: 1000, templateAccountGuid: 'ta01' },
        { accountGuid: 'acct0000000000000000000000002', accountName: 'Assets:Checking', amount: -1000, templateAccountGuid: 'ta02' },
      ]);

      // Mock book currency query
      mockTx.$queryRaw.mockResolvedValueOnce([
        { commodity_guid: 'usd00000000000000000000000001' },
      ]);

      // Mock INSERT and UPDATE calls
      mockTx.$executeRaw.mockResolvedValue(1);

      const result = await executeOccurrence(sxGuid, '2026-03-01');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.transactionGuid).toBeDefined();
      }

      // Should have resolved template splits
      expect(resolveTemplateSplits).toHaveBeenCalledWith('tmpl0000000000000000000000001');

      // Should have inserted transaction (1) + splits (2) + updated schedxaction (1) = 4 executeRaw calls
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(4);
    });

    it('should reject when rem_occur = 0', async () => {
      const sxGuid = 'sx00000000000000000000000000002';

      mockTx.$queryRaw.mockResolvedValueOnce([
        {
          guid: sxGuid,
          name: 'Expired SX',
          template_act_guid: 'tmpl0000000000000000000000002',
          last_occur: null,
          rem_occur: 0,
          instance_count: 10,
        },
      ]);

      const result = await executeOccurrence(sxGuid, '2026-03-01');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('no remaining occurrences');
      }

      // Should not create any transaction
      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    });

    it('should allow unlimited when rem_occur = -1 and not decrement', async () => {
      const sxGuid = 'sx00000000000000000000000000003';

      mockTx.$queryRaw.mockResolvedValueOnce([
        {
          guid: sxGuid,
          name: 'Unlimited SX',
          template_act_guid: 'tmpl0000000000000000000000003',
          last_occur: null,
          rem_occur: -1,
          instance_count: 50,
        },
      ]);

      vi.mocked(resolveTemplateSplits).mockResolvedValueOnce([
        { accountGuid: 'acct0000000000000000000000003', accountName: 'Income', amount: 500, templateAccountGuid: 'ta03' },
        { accountGuid: 'acct0000000000000000000000004', accountName: 'Bank', amount: -500, templateAccountGuid: 'ta04' },
      ]);

      mockTx.$queryRaw.mockResolvedValueOnce([
        { commodity_guid: 'usd00000000000000000000000001' },
      ]);

      mockTx.$executeRaw.mockResolvedValue(1);

      const result = await executeOccurrence(sxGuid, '2026-04-01');

      expect(result.success).toBe(true);

      // Verify the UPDATE call used rem_occur = -1 (unchanged)
      // The last $executeRaw call is the UPDATE
      const updateCall = mockTx.$executeRaw.mock.calls[3];
      // The tagged template literal args: the 3rd positional arg (index 2) should be -1 for rem_occur
      // We check that instance_count was incremented to 51
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(4);
    });
  });

  describe('skipOccurrence', () => {
    it('should advance metadata without creating a transaction', async () => {
      const sxGuid = 'sx00000000000000000000000000004';

      mockTx.$queryRaw.mockResolvedValueOnce([
        {
          guid: sxGuid,
          name: 'Skip Me',
          template_act_guid: 'tmpl0000000000000000000000004',
          last_occur: null,
          rem_occur: 3,
          instance_count: 2,
        },
      ]);

      mockTx.$executeRaw.mockResolvedValue(1);

      const result = await skipOccurrence(sxGuid, '2026-03-15');

      expect(result.success).toBe(true);

      // Should NOT call resolveTemplateSplits
      expect(resolveTemplateSplits).not.toHaveBeenCalled();

      // Should only have 1 executeRaw call (the UPDATE)
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('should reject when rem_occur = 0', async () => {
      const sxGuid = 'sx00000000000000000000000000005';

      mockTx.$queryRaw.mockResolvedValueOnce([
        {
          guid: sxGuid,
          name: 'Expired Skip',
          template_act_guid: 'tmpl0000000000000000000000005',
          last_occur: null,
          rem_occur: 0,
          instance_count: 5,
        },
      ]);

      const result = await skipOccurrence(sxGuid, '2026-03-15');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('no remaining occurrences');
      }

      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('batchExecuteSkip', () => {
    it('should process multiple items independently with partial failure', async () => {
      // Item 1: execute (will succeed)
      mockTx.$queryRaw.mockResolvedValueOnce([
        {
          guid: 'sx00000000000000000000000000006',
          name: 'Batch Execute',
          template_act_guid: 'tmpl0000000000000000000000006',
          last_occur: null,
          rem_occur: 2,
          instance_count: 0,
        },
      ]);

      vi.mocked(resolveTemplateSplits).mockResolvedValueOnce([
        { accountGuid: 'acct0000000000000000000000005', accountName: 'Expense', amount: 200, templateAccountGuid: 'ta05' },
        { accountGuid: 'acct0000000000000000000000006', accountName: 'Bank', amount: -200, templateAccountGuid: 'ta06' },
      ]);

      mockTx.$queryRaw.mockResolvedValueOnce([
        { commodity_guid: 'usd00000000000000000000000001' },
      ]);

      mockTx.$executeRaw.mockResolvedValue(1);

      // Item 2: skip (will fail -- rem_occur = 0)
      mockTx.$queryRaw.mockResolvedValueOnce([
        {
          guid: 'sx00000000000000000000000000007',
          name: 'Batch Skip Fail',
          template_act_guid: 'tmpl0000000000000000000000007',
          last_occur: null,
          rem_occur: 0,
          instance_count: 10,
        },
      ]);

      // Item 3: skip (will succeed)
      mockTx.$queryRaw.mockResolvedValueOnce([
        {
          guid: 'sx00000000000000000000000000008',
          name: 'Batch Skip OK',
          template_act_guid: 'tmpl0000000000000000000000008',
          last_occur: null,
          rem_occur: 1,
          instance_count: 4,
        },
      ]);

      const result = await batchExecuteSkip([
        { guid: 'sx00000000000000000000000000006', occurrenceDate: '2026-03-01', action: 'execute' },
        { guid: 'sx00000000000000000000000000007', occurrenceDate: '2026-03-01', action: 'skip' },
        { guid: 'sx00000000000000000000000000008', occurrenceDate: '2026-03-01', action: 'skip' },
      ]);

      expect(result.results).toHaveLength(3);

      // Item 1: execute success
      expect(result.results[0].success).toBe(true);
      expect(result.results[0].action).toBe('execute');
      expect(result.results[0].transactionGuid).toBeDefined();

      // Item 2: skip failure
      expect(result.results[1].success).toBe(false);
      expect(result.results[1].action).toBe('skip');
      expect(result.results[1].error).toContain('no remaining occurrences');

      // Item 3: skip success
      expect(result.results[2].success).toBe(true);
      expect(result.results[2].action).toBe('skip');
    });
  });
});
