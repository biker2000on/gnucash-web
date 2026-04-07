/**
 * Amazon Import Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the service under test
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
vi.mock('@/lib/db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  toDecimal: (num: bigint | number, denom: bigint | number) => {
    const n = Number(num);
    const d = Number(denom);
    if (d === 0) return '0';
    return (n / d).toFixed(2);
  },
}));

vi.mock('@/lib/amazon-csv-parser', () => ({
  parseAmazonCsv: vi.fn(),
  extractCsvFromZip: vi.fn(),
  detectFormat: vi.fn(),
}));

vi.mock('@/lib/amazon-matching', () => ({
  rankAmazonCandidates: vi.fn(),
}));

vi.mock('@/lib/amazon-split-generator', () => ({
  generateSplits: vi.fn(),
}));

vi.mock('@/lib/category-mapper', () => ({
  suggestAccount: vi.fn(),
  recordMapping: vi.fn(),
}));

vi.mock('@/lib/services/transaction.service', () => ({
  TransactionService: {
    update: vi.fn(),
    getById: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { AmazonImportService } from '../amazon-import.service';
import { parseAmazonCsv, extractCsvFromZip, detectFormat } from '@/lib/amazon-csv-parser';
import { rankAmazonCandidates } from '@/lib/amazon-matching';
import { generateSplits } from '@/lib/amazon-split-generator';
import { suggestAccount, recordMapping } from '@/lib/category-mapper';
import { TransactionService } from '@/lib/services/transaction.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOOK_GUID = 'b'.repeat(32);
const CC_GUID = 'c'.repeat(32);
const TX_GUID = 't'.repeat(32);
const SPLIT_GUID = 's'.repeat(32);
const ACCT_GUID = 'a'.repeat(32);
const CURRENCY_GUID = 'u'.repeat(32);

function makeOrder(overrides?: Partial<import('@/lib/amazon-csv-parser').AmazonOrder>): import('@/lib/amazon-csv-parser').AmazonOrder {
  return {
    orderId: '111-1111111-1111111',
    orderDate: new Date('2024-06-15'),
    items: [
      {
        name: 'Widget',
        price: 25.99,
        quantity: 1,
        tax: 2.08,
        category: 'Electronics',
        csvRowIndex: 0,
      },
    ],
    orderTotal: 28.07,
    taxTotal: 2.08,
    shippingTotal: 0,
    chargeAmount: 28.07,
    currency: 'USD',
    ...overrides,
  };
}

const defaultSettings = {
  taxMode: 'separate' as const,
  shippingMode: 'separate' as const,
  taxAccountGuid: 'x'.repeat(32),
  shippingAccountGuid: 'y'.repeat(32),
};

function csvHeader() {
  return 'Order ID,Order Date,Unit Price,Quantity,ASIN,Title';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AmazonImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // importFile
  // -----------------------------------------------------------------------

  describe('importFile', () => {
    it('parses CSV, creates batch, inserts orders, runs matching', async () => {
      const order = makeOrder();
      const csvContent = csvHeader() + '\nrow data';

      vi.mocked(detectFormat).mockReturnValue('request-my-data');
      vi.mocked(parseAmazonCsv).mockReturnValue({
        orders: [order],
        duplicateCount: 0,
        errors: [],
      });

      // Batch insert
      mockQuery
        // INSERT INTO gnucash_web_import_batches
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        // INSERT INTO gnucash_web_amazon_orders (1 item)
        .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 })
        // SELECT transactions for matching
        .mockResolvedValueOnce({
          rows: [
            {
              guid: TX_GUID,
              description: 'AMZN Mktp',
              post_date: '2024-06-16',
              amount: '28.07',
              split_guid: SPLIT_GUID,
              account_guid: CC_GUID,
            },
          ],
        })
        // UPDATE match_status
        .mockResolvedValueOnce({ rowCount: 1 })
        // UPDATE batch matched_items
        .mockResolvedValueOnce({ rowCount: 1 });

      vi.mocked(rankAmazonCandidates).mockReturnValue([
        {
          transaction_guid: TX_GUID,
          description: 'AMZN Mktp',
          post_date: '2024-06-16',
          amount: 28.07,
          split_guid: SPLIT_GUID,
          account_guid: CC_GUID,
          score: 0.85,
          score_breakdown: { amount: 1, date: 0.5 },
        },
      ]);

      const result = await AmazonImportService.importFile(
        BOOK_GUID,
        1,
        Buffer.from(csvContent),
        'orders.csv',
        CC_GUID,
        defaultSettings,
      );

      expect(result.batchId).toBe(1);
      expect(result.totalOrders).toBe(1);
      expect(result.totalItems).toBe(1);
      expect(result.matchedOrders).toBe(1);
      expect(result.duplicateCount).toBe(0);
      expect(result.errors).toEqual([]);

      // Verify parseAmazonCsv was called
      expect(parseAmazonCsv).toHaveBeenCalledWith(csvContent);

      // Verify batch was created
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO gnucash_web_import_batches'),
        expect.any(Array),
      );

      // Verify matching ran
      expect(rankAmazonCandidates).toHaveBeenCalled();
    });

    it('handles ZIP file extraction path', async () => {
      const order = makeOrder();
      const csvContent = csvHeader() + '\nrow data';
      const zipBuffer = Buffer.from('fake zip');

      vi.mocked(extractCsvFromZip).mockResolvedValue(csvContent);
      vi.mocked(detectFormat).mockReturnValue('request-my-data');
      vi.mocked(parseAmazonCsv).mockReturnValue({
        orders: [order],
        duplicateCount: 0,
        errors: [],
      });

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 2 }] })
        .mockResolvedValueOnce({ rows: [{ id: 11 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 });

      vi.mocked(rankAmazonCandidates).mockReturnValue([]);

      const result = await AmazonImportService.importFile(
        BOOK_GUID,
        1,
        zipBuffer,
        'amazon-data.zip',
        CC_GUID,
        defaultSettings,
      );

      expect(extractCsvFromZip).toHaveBeenCalledWith(zipBuffer);
      expect(result.batchId).toBe(2);
    });

    it('rejects Order History Reports format', async () => {
      vi.mocked(detectFormat).mockReturnValue('order-history-reports');

      await expect(
        AmazonImportService.importFile(
          BOOK_GUID,
          1,
          Buffer.from(csvHeader()),
          'orders.csv',
          CC_GUID,
          defaultSettings,
        ),
      ).rejects.toThrow(
        'Order History Reports format not supported. Please use Request My Data export.',
      );
    });

    it('rejects unknown CSV format', async () => {
      vi.mocked(detectFormat).mockReturnValue('unknown');

      await expect(
        AmazonImportService.importFile(
          BOOK_GUID,
          1,
          Buffer.from('random,data'),
          'orders.csv',
          CC_GUID,
          defaultSettings,
        ),
      ).rejects.toThrow('Unrecognized CSV format');
    });

    it('handles duplicates (ON CONFLICT DO NOTHING)', async () => {
      const order = makeOrder({
        items: [
          { name: 'Widget', price: 25.99, quantity: 1, tax: 2.08, category: null, csvRowIndex: 0 },
          { name: 'Gadget', price: 10.00, quantity: 1, tax: 0.80, category: null, csvRowIndex: 1 },
        ],
      });

      vi.mocked(detectFormat).mockReturnValue('request-my-data');
      vi.mocked(parseAmazonCsv).mockReturnValue({
        orders: [order],
        duplicateCount: 0,
        errors: [],
      });

      mockQuery
        // Batch insert
        .mockResolvedValueOnce({ rows: [{ id: 3 }] })
        // First item: inserted
        .mockResolvedValueOnce({ rows: [{ id: 20 }], rowCount: 1 })
        // Second item: duplicate (ON CONFLICT DO NOTHING)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // SELECT transactions
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE batch
        .mockResolvedValueOnce({ rowCount: 1 });

      vi.mocked(rankAmazonCandidates).mockReturnValue([]);

      const result = await AmazonImportService.importFile(
        BOOK_GUID,
        1,
        Buffer.from(csvHeader()),
        'orders.csv',
        CC_GUID,
        defaultSettings,
      );

      expect(result.totalItems).toBe(1);
      expect(result.duplicateCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // confirmMatch
  // -----------------------------------------------------------------------

  describe('confirmMatch', () => {
    it('updates match_status and records category mappings', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 2 });
      vi.mocked(recordMapping).mockResolvedValue(undefined);

      await AmazonImportService.confirmMatch(
        1,
        BOOK_GUID,
        '111-1111111-1111111',
        TX_GUID,
        [
          { itemName: 'Widget', accountGuid: ACCT_GUID },
          { itemName: 'Gadget', accountGuid: ACCT_GUID },
        ],
      );

      // Verify UPDATE was called
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("match_status = 'confirmed'"),
        [TX_GUID, BOOK_GUID, '111-1111111-1111111', 1],
      );

      // Verify category mappings recorded
      expect(recordMapping).toHaveBeenCalledTimes(2);
      expect(recordMapping).toHaveBeenCalledWith(BOOK_GUID, 'Widget', ACCT_GUID);
      expect(recordMapping).toHaveBeenCalledWith(BOOK_GUID, 'Gadget', ACCT_GUID);
    });
  });

  // -----------------------------------------------------------------------
  // applyBatch
  // -----------------------------------------------------------------------

  describe('applyBatch', () => {
    it('generates splits and calls TransactionService.update', async () => {
      // Fetch batch settings
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            settings: {
              creditCardAccountGuid: CC_GUID,
              taxMode: 'separate',
              shippingMode: 'separate',
              taxAccountGuid: 'x'.repeat(32),
              shippingAccountGuid: 'y'.repeat(32),
            },
          },
        ],
      });

      // Fetch confirmed orders
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            order_id: '111-1111111-1111111',
            item_name: 'Widget',
            item_price: '25.99',
            item_quantity: 1,
            tax_amount: '2.08',
            shipping_amount: '0',
            order_total: '28.07',
            charge_amount: '28.07',
            transaction_guid: TX_GUID,
          },
        ],
      });

      // TransactionService.getById
      vi.mocked(TransactionService.getById).mockResolvedValue({
        guid: TX_GUID,
        currency_guid: CURRENCY_GUID,
        post_date: new Date('2024-06-16'),
        description: 'AMZN Mktp',
        num: '',
        enter_date: new Date(),
        splits: [
          {
            guid: SPLIT_GUID,
            tx_guid: TX_GUID,
            account_guid: CC_GUID,
            memo: '',
            action: '',
            reconcile_state: 'n',
            reconcile_date: null,
            value_num: 2807n,
            value_denom: 100n,
            quantity_num: 2807n,
            quantity_denom: 100n,
            lot_guid: null,
            account: { name: 'Credit Card', guid: CC_GUID, commodity: null } as any,
            value_decimal: '28.07',
            quantity_decimal: '28.07',
            account_name: 'Credit Card',
            commodity_mnemonic: undefined,
          },
          {
            guid: 'e'.repeat(32),
            tx_guid: TX_GUID,
            account_guid: ACCT_GUID,
            memo: '',
            action: '',
            reconcile_state: 'n',
            reconcile_date: null,
            value_num: -2807n,
            value_denom: 100n,
            quantity_num: -2807n,
            quantity_denom: 100n,
            lot_guid: null,
            account: { name: 'Expenses', guid: ACCT_GUID, commodity: null } as any,
            value_decimal: '-28.07',
            quantity_decimal: '-28.07',
            account_name: 'Expenses',
            commodity_mnemonic: undefined,
          },
        ],
        currency: { guid: CURRENCY_GUID } as any,
      } as any);

      // suggestAccount for item
      vi.mocked(suggestAccount).mockResolvedValue({
        accountGuid: ACCT_GUID,
        confidence: 0.9,
        keyword: 'widget',
      });

      // generateSplits
      vi.mocked(generateSplits).mockReturnValue([
        { account_guid: ACCT_GUID, value_num: -2599, value_denom: 100, memo: 'Widget' },
        { account_guid: 'x'.repeat(32), value_num: -208, value_denom: 100, memo: 'Sales Tax' },
        { account_guid: CC_GUID, value_num: 2807, value_denom: 100, memo: '' },
      ]);

      // TransactionService.update
      vi.mocked(TransactionService.update).mockResolvedValue({} as any);

      // UPDATE apply_status
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      // UPDATE batch status
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await AmazonImportService.applyBatch(1, BOOK_GUID);

      expect(result.applied).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.errors).toEqual([]);

      expect(generateSplits).toHaveBeenCalled();
      expect(TransactionService.update).toHaveBeenCalledWith(
        expect.objectContaining({
          guid: TX_GUID,
          currency_guid: CURRENCY_GUID,
        }),
      );

      // Verify batch status updated to 'completed'
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('UPDATE gnucash_web_import_batches'),
        ['completed', 1],
      );
    });

    it('skips reconciled transactions with error', async () => {
      // Fetch batch settings
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            settings: {
              creditCardAccountGuid: CC_GUID,
              taxMode: 'separate',
              shippingMode: 'separate',
            },
          },
        ],
      });

      // Fetch confirmed orders
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            order_id: '111-1111111-1111111',
            item_name: 'Widget',
            item_price: '25.99',
            item_quantity: 1,
            tax_amount: '2.08',
            shipping_amount: '0',
            order_total: '28.07',
            charge_amount: '28.07',
            transaction_guid: TX_GUID,
          },
        ],
      });

      // TransactionService.getById — reconciled split
      vi.mocked(TransactionService.getById).mockResolvedValue({
        guid: TX_GUID,
        currency_guid: CURRENCY_GUID,
        post_date: new Date('2024-06-16'),
        description: 'AMZN Mktp',
        num: '',
        enter_date: new Date(),
        splits: [
          {
            guid: SPLIT_GUID,
            tx_guid: TX_GUID,
            account_guid: CC_GUID,
            memo: '',
            action: '',
            reconcile_state: 'y', // reconciled!
            reconcile_date: new Date(),
            value_num: 2807n,
            value_denom: 100n,
            quantity_num: 2807n,
            quantity_denom: 100n,
            lot_guid: null,
            account: { name: 'Credit Card', guid: CC_GUID, commodity: null } as any,
            value_decimal: '28.07',
            quantity_decimal: '28.07',
            account_name: 'Credit Card',
            commodity_mnemonic: undefined,
          },
        ],
        currency: { guid: CURRENCY_GUID } as any,
      } as any);

      // UPDATE apply_status = 'failed'
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      // UPDATE batch status
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await AmazonImportService.applyBatch(1, BOOK_GUID);

      expect(result.applied).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('reconciled');

      // TransactionService.update should NOT have been called
      expect(TransactionService.update).not.toHaveBeenCalled();
    });

    it('handles partial success (some applied, some failed)', async () => {
      // Fetch batch settings
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            settings: {
              creditCardAccountGuid: CC_GUID,
              taxMode: 'separate',
              shippingMode: 'separate',
            },
          },
        ],
      });

      // Fetch confirmed orders — two different order_ids
      const ORDER_ID_1 = '111-1111111-1111111';
      const ORDER_ID_2 = '222-2222222-2222222';
      const TX_GUID_2 = 'f'.repeat(32);

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            order_id: ORDER_ID_1,
            item_name: 'Widget',
            item_price: '25.99',
            item_quantity: 1,
            tax_amount: '2.08',
            shipping_amount: '0',
            order_total: '28.07',
            charge_amount: '28.07',
            transaction_guid: TX_GUID,
          },
          {
            id: 11,
            order_id: ORDER_ID_2,
            item_name: 'Gadget',
            item_price: '15.00',
            item_quantity: 1,
            tax_amount: '1.20',
            shipping_amount: '0',
            order_total: '16.20',
            charge_amount: '16.20',
            transaction_guid: TX_GUID_2,
          },
        ],
      });

      // First order: success path
      vi.mocked(TransactionService.getById)
        .mockResolvedValueOnce({
          guid: TX_GUID,
          currency_guid: CURRENCY_GUID,
          post_date: new Date('2024-06-16'),
          description: 'AMZN Mktp',
          num: '',
          enter_date: new Date(),
          splits: [
            {
              guid: SPLIT_GUID,
              tx_guid: TX_GUID,
              account_guid: CC_GUID,
              memo: '',
              action: '',
              reconcile_state: 'n',
              reconcile_date: null,
              value_num: 2807n,
              value_denom: 100n,
              quantity_num: 2807n,
              quantity_denom: 100n,
              lot_guid: null,
              account: { name: 'CC', guid: CC_GUID, commodity: null } as any,
              value_decimal: '28.07',
              quantity_decimal: '28.07',
              account_name: 'CC',
              commodity_mnemonic: undefined,
            },
          ],
          currency: { guid: CURRENCY_GUID } as any,
        } as any)
        // Second order: not found
        .mockResolvedValueOnce(null);

      vi.mocked(suggestAccount).mockResolvedValue({
        accountGuid: ACCT_GUID,
        confidence: 0.9,
        keyword: 'widget',
      });

      vi.mocked(generateSplits).mockReturnValue([
        { account_guid: ACCT_GUID, value_num: -2807, value_denom: 100, memo: 'Widget' },
        { account_guid: CC_GUID, value_num: 2807, value_denom: 100, memo: '' },
      ]);

      vi.mocked(TransactionService.update).mockResolvedValue({} as any);

      // UPDATE apply_status for order 1 (applied)
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      // UPDATE apply_status for order 2 (failed)
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      // UPDATE batch status
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await AmazonImportService.applyBatch(1, BOOK_GUID);

      expect(result.applied).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].orderId).toBe(ORDER_ID_2);

      // Batch status should be 'partially_applied'
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('UPDATE gnucash_web_import_batches'),
        ['partially_applied', 1],
      );
    });
  });

  // -----------------------------------------------------------------------
  // getBatch
  // -----------------------------------------------------------------------

  describe('getBatch', () => {
    it('returns orders grouped with suggestions', async () => {
      // Fetch batch
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            filename: 'orders.csv',
            status: 'ready',
            total_items: 2,
            matched_items: 1,
            settings: { creditCardAccountGuid: CC_GUID },
            created_at: new Date('2024-06-20'),
          },
        ],
      });

      // Fetch orders
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            order_id: '111-1111111-1111111',
            order_date: '2024-06-15',
            item_name: 'Widget',
            item_price: '25.99',
            item_quantity: 1,
            tax_amount: '2.08',
            category: 'Electronics',
            csv_row_index: 0,
            order_total: '28.07',
            charge_amount: '28.07',
            match_status: 'suggested',
            transaction_guid: TX_GUID,
          },
          {
            id: 11,
            order_id: '111-1111111-1111111',
            order_date: '2024-06-15',
            item_name: 'Case',
            item_price: '5.00',
            item_quantity: 1,
            tax_amount: '0.40',
            category: null,
            csv_row_index: 1,
            order_total: '28.07',
            charge_amount: '28.07',
            match_status: 'suggested',
            transaction_guid: TX_GUID,
          },
        ],
      });

      vi.mocked(suggestAccount)
        .mockResolvedValueOnce({
          accountGuid: ACCT_GUID,
          confidence: 0.9,
          keyword: 'widget',
        })
        .mockResolvedValueOnce(null);

      const { batch, orders } = await AmazonImportService.getBatch(
        1,
        BOOK_GUID,
      );

      expect(batch.id).toBe(1);
      expect(batch.filename).toBe('orders.csv');
      expect(batch.status).toBe('ready');

      // Orders should be grouped: one order with two items
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe('111-1111111-1111111');
      expect(orders[0].items).toHaveLength(2);
      expect(orders[0].items[0].suggestedAccountGuid).toBe(ACCT_GUID);
      expect(orders[0].items[0].suggestedAccountConfidence).toBe(0.9);
      expect(orders[0].items[1].suggestedAccountGuid).toBeNull();
      expect(orders[0].items[1].suggestedAccountConfidence).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // updateBatchSettings
  // -----------------------------------------------------------------------

  describe('updateBatchSettings', () => {
    it('updates batch settings in DB', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await AmazonImportService.updateBatchSettings(1, BOOK_GUID, {
        taxMode: 'rolled_in',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE gnucash_web_import_batches'),
        [JSON.stringify({ taxMode: 'rolled_in' }), 1, BOOK_GUID],
      );
    });
  });
});
