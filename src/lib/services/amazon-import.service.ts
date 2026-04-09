/**
 * Amazon Import Service
 *
 * Orchestrates the full Amazon order import pipeline:
 * 1. Parse CSV/ZIP files into structured order data
 * 2. Insert orders into the database with duplicate handling
 * 3. Match orders to existing credit card transactions
 * 4. Generate itemized splits and apply them via TransactionService
 */

import { query } from '@/lib/db';
import {
  parseAmazonCsv,
  extractCsvFromZip,
  detectFormat,
  type AmazonOrder,
} from '@/lib/amazon-csv-parser';
import {
  rankAmazonCandidates,
  type AmazonMatchCandidate,
} from '@/lib/amazon-matching';
import { generateSplits, type SplitGeneratorInput } from '@/lib/amazon-split-generator';
import { suggestAccount, recordMapping } from '@/lib/category-mapper';
import { TransactionService } from '@/lib/services/transaction.service';
import { toDecimal } from '@/lib/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportBatchResult {
  batchId: number;
  totalOrders: number;
  totalItems: number;
  matchedOrders: number;
  duplicateCount: number;
  errors: string[];
}

export interface BatchOrder {
  id: number;
  orderId: string;
  orderDate: string;
  orderTotal: number;
  chargeAmount: number | null;
  items: Array<{
    id: number;
    name: string;
    price: number;
    quantity: number;
    tax: number;
    category: string | null;
    csvRowIndex: number;
    suggestedAccountGuid: string | null;
    suggestedAccountConfidence: number;
  }>;
  matchStatus: string;
  matchCandidates: AmazonMatchCandidate[];
  matchedTransactionGuid: string | null;
}

export interface ApplyResult {
  applied: number;
  failed: number;
  errors: Array<{ orderId: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AmazonImportService {
  /**
   * Upload and process a CSV or ZIP file.
   *
   * 1. If filename ends with .zip, extract CSV via extractCsvFromZip
   * 2. Parse CSV with parseAmazonCsv
   * 3. Reject unsupported / unknown formats
   * 4. Create import_batches row
   * 5. Insert amazon_orders rows (ON CONFLICT DO NOTHING for dupes)
   * 6. Batch-fetch CC transactions in date range and score each order
   * 7. Update match_status to 'suggested' for orders with score >= 0.3
   * 8. Return result with counts
   */
  static async importFile(
    bookGuid: string,
    userId: number,
    fileBuffer: Buffer,
    filename: string,
    creditCardAccountGuid: string,
    settings: {
      taxMode: 'separate' | 'rolled_in';
      shippingMode: 'separate' | 'rolled_in';
      taxAccountGuid?: string;
      shippingAccountGuid?: string;
      descriptionPatterns?: string[];
    },
  ): Promise<ImportBatchResult> {
    // 1. Extract CSV content
    let csvContent: string;
    if (filename.toLowerCase().endsWith('.zip')) {
      csvContent = await extractCsvFromZip(fileBuffer);
    } else {
      csvContent = fileBuffer.toString('utf-8');
    }

    // 2. Detect format from the first line
    const firstLine = csvContent.split(/\r?\n/)[0] ?? '';
    const format = detectFormat(firstLine);

    // 3. Reject unsupported formats
    if (format === 'order-history-reports') {
      throw new Error(
        'Order History Reports format not supported. Please use Request My Data export.',
      );
    }
    if (format === 'unknown') {
      throw new Error('Unrecognized CSV format');
    }

    // 4. Parse CSV
    const parseResult = parseAmazonCsv(csvContent);
    const { orders } = parseResult;
    const errors = [...parseResult.errors];

    // 5. Create import batch row
    const batchResult = await query(
      `INSERT INTO gnucash_web_import_batches
         (book_guid, source, filename, total_items, user_id, status, settings)
       VALUES ($1, 'amazon', $2, $3, $4, 'processing', $5)
       RETURNING id`,
      [
        bookGuid,
        filename,
        orders.reduce((sum, o) => sum + o.items.length, 0),
        userId,
        JSON.stringify({
          creditCardAccountGuid,
          ...settings,
        }),
      ],
    );
    const batchId = batchResult.rows[0].id as number;

    // 6. Insert amazon_orders rows
    let totalItems = 0;
    let duplicateCount = parseResult.duplicateCount;

    for (const order of orders) {
      for (const item of order.items) {
        const insertResult = await query(
          `INSERT INTO gnucash_web_amazon_orders
             (book_guid, order_id, order_date, item_name, item_price,
              item_quantity, category, tax_amount, shipping_amount,
              order_total, charge_amount, currency,
              match_status, apply_status, import_batch_id, csv_row_index)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   'unmatched', 'pending', $13, $14)
           ON CONFLICT (book_guid, order_id, item_name, item_price, csv_row_index)
           DO NOTHING
           RETURNING id`,
          [
            bookGuid,
            order.orderId,
            order.orderDate.toISOString().split('T')[0],
            item.name,
            item.price,
            item.quantity,
            item.category,
            item.tax,
            order.shippingTotal,
            order.orderTotal,
            order.chargeAmount,
            order.currency,
            batchId,
            item.csvRowIndex,
          ],
        );
        if (insertResult.rowCount && insertResult.rowCount > 0) {
          totalItems++;
        } else {
          duplicateCount++;
        }
      }
    }

    // 7. Run matching: batch-fetch CC transactions in the date range
    let matchedOrders = 0;

    if (orders.length > 0) {
      const minDate = orders
        .map((o) => o.orderDate)
        .reduce((a, b) => (a < b ? a : b));
      const maxDate = orders
        .map((o) => o.orderDate)
        .reduce((a, b) => (a > b ? a : b));

      const descriptionPatterns = settings.descriptionPatterns ?? [
        '%amzn%',
        '%amazon%',
        '%amz*%',
      ];

      const txResult = await query(
        `SELECT t.guid, t.description, t.post_date::text,
                ABS(s.value_num::decimal / s.value_denom) as amount,
                s.guid as split_guid, s.account_guid
         FROM transactions t
         JOIN splits s ON s.tx_guid = t.guid
         WHERE t.post_date BETWEEN ($1::date - INTERVAL '7 days') AND ($2::date + INTERVAL '7 days')
           AND s.account_guid = $3
           AND (t.description ILIKE ANY($4::text[]))
           AND t.guid NOT IN (
             SELECT DISTINCT transaction_guid FROM gnucash_web_amazon_orders
             WHERE transaction_guid IS NOT NULL AND book_guid = $5
           )`,
        [
          minDate.toISOString().split('T')[0],
          maxDate.toISOString().split('T')[0],
          creditCardAccountGuid,
          descriptionPatterns,
          bookGuid,
        ],
      );

      const candidates = txResult.rows.map((r) => ({
        guid: r.guid as string,
        description: r.description as string,
        post_date: r.post_date as string,
        amount: parseFloat(r.amount as string),
        split_guid: r.split_guid as string,
        account_guid: r.account_guid as string,
      }));

      // Score each unique order
      const processedOrders = new Set<string>();
      for (const order of orders) {
        if (processedOrders.has(order.orderId)) continue;
        processedOrders.add(order.orderId);

        const matchAmount = order.chargeAmount ?? order.orderTotal;
        const orderDateStr = order.orderDate.toISOString().split('T')[0];

        const ranked = rankAmazonCandidates(
          matchAmount,
          orderDateStr,
          candidates,
        );

        if (ranked.length > 0) {
          matchedOrders++;
          // Update all rows for this order to 'suggested'
          await query(
            `UPDATE gnucash_web_amazon_orders
             SET match_status = 'suggested',
                 transaction_guid = $1,
                 split_guid = $2
             WHERE book_guid = $3
               AND order_id = $4
               AND import_batch_id = $5`,
            [
              ranked[0].transaction_guid,
              ranked[0].split_guid,
              bookGuid,
              order.orderId,
              batchId,
            ],
          );
        }
      }
    }

    // Update batch matched_items count and status
    await query(
      `UPDATE gnucash_web_import_batches
       SET matched_items = $1, status = 'ready'
       WHERE id = $2`,
      [matchedOrders, batchId],
    );

    return {
      batchId,
      totalOrders: orders.length,
      totalItems,
      matchedOrders,
      duplicateCount,
      errors,
    };
  }

  /**
   * Get batch details with orders and match suggestions.
   */
  static async getBatch(
    batchId: number,
    bookGuid: string,
  ): Promise<{
    batch: {
      id: number;
      filename: string;
      status: string;
      totalItems: number;
      matchedItems: number;
      settings: Record<string, unknown>;
      createdAt: Date;
    };
    orders: BatchOrder[];
  }> {
    // 1. Fetch batch row
    const batchResult = await query(
      `SELECT id, filename, status, total_items, matched_items, settings, created_at
       FROM gnucash_web_import_batches
       WHERE id = $1 AND book_guid = $2`,
      [batchId, bookGuid],
    );

    if (batchResult.rows.length === 0) {
      throw new Error(`Batch ${batchId} not found`);
    }

    const batchRow = batchResult.rows[0];
    const batch = {
      id: batchRow.id as number,
      filename: batchRow.filename as string,
      status: batchRow.status as string,
      totalItems: batchRow.total_items as number,
      matchedItems: batchRow.matched_items as number,
      settings: (batchRow.settings ?? {}) as Record<string, unknown>,
      createdAt: batchRow.created_at as Date,
    };

    // 2. Fetch all orders for this batch
    const ordersResult = await query(
      `SELECT id, order_id, order_date::text as order_date, item_name,
              item_price, item_quantity, tax_amount, category, csv_row_index,
              order_total, charge_amount, match_status, transaction_guid
       FROM gnucash_web_amazon_orders
       WHERE import_batch_id = $1 AND book_guid = $2
       ORDER BY order_date, order_id, id`,
      [batchId, bookGuid],
    );

    // Group by order_id
    const orderMap = new Map<string, BatchOrder>();

    for (const row of ordersResult.rows) {
      const orderId = row.order_id as string;

      if (!orderMap.has(orderId)) {
        orderMap.set(orderId, {
          id: row.id as number,
          orderId,
          orderDate: row.order_date as string,
          orderTotal: parseFloat(row.order_total as string),
          chargeAmount: row.charge_amount != null
            ? parseFloat(row.charge_amount as string)
            : null,
          items: [],
          matchStatus: row.match_status as string,
          matchCandidates: [],
          matchedTransactionGuid: (row.transaction_guid as string) || null,
        });
      }

      const order = orderMap.get(orderId)!;

      // 3. Get category suggestion for each item
      const suggestion = await suggestAccount(
        bookGuid,
        row.item_name as string,
      );

      order.items.push({
        id: row.id as number,
        name: row.item_name as string,
        price: parseFloat(row.item_price as string),
        quantity: row.item_quantity as number,
        tax: parseFloat(row.tax_amount as string),
        category: (row.category as string) || null,
        csvRowIndex: row.csv_row_index as number,
        suggestedAccountGuid: suggestion?.accountGuid ?? null,
        suggestedAccountConfidence: suggestion?.confidence ?? 0,
      });
    }

    // 4. For unmatched orders, compute match candidates from CC transactions
    const settings = batch.settings as Record<string, string | string[]>;
    const creditCardAccountGuid = settings.creditCardAccountGuid as string;

    if (creditCardAccountGuid) {
      const unmatchedOrders = [...orderMap.values()].filter(
        (o) => o.matchStatus === 'unmatched',
      );

      if (unmatchedOrders.length > 0) {
        const dates = unmatchedOrders.map(
          (o) => new Date(o.orderDate),
        );
        const minDate = dates.reduce((a, b) => (a < b ? a : b));
        const maxDate = dates.reduce((a, b) => (a > b ? a : b));

        const descPatterns =
          (settings.descriptionPatterns as string[] | undefined) ?? [
            '%amzn%',
            '%amazon%',
            '%amz*%',
          ];

        const txResult = await query(
          `SELECT t.guid, t.description, t.post_date::text,
                  ABS(s.value_num::decimal / s.value_denom) as amount,
                  s.guid as split_guid, s.account_guid
           FROM transactions t
           JOIN splits s ON s.tx_guid = t.guid
           WHERE t.post_date BETWEEN ($1::date - INTERVAL '7 days') AND ($2::date + INTERVAL '7 days')
             AND s.account_guid = $3
             AND (t.description ILIKE ANY($4::text[]))
             AND t.guid NOT IN (
               SELECT DISTINCT transaction_guid FROM gnucash_web_amazon_orders
               WHERE transaction_guid IS NOT NULL AND book_guid = $5
             )`,
          [
            minDate.toISOString().split('T')[0],
            maxDate.toISOString().split('T')[0],
            creditCardAccountGuid,
            descPatterns,
            bookGuid,
          ],
        );

        const candidates = txResult.rows.map((r) => ({
          guid: r.guid as string,
          description: r.description as string,
          post_date: r.post_date as string,
          amount: parseFloat(r.amount as string),
          split_guid: r.split_guid as string,
          account_guid: r.account_guid as string,
        }));

        for (const order of unmatchedOrders) {
          const matchAmount = order.chargeAmount ?? order.orderTotal;
          order.matchCandidates = rankAmazonCandidates(
            matchAmount,
            order.orderDate,
            candidates,
          );
        }
      }
    }

    return {
      batch,
      orders: [...orderMap.values()],
    };
  }

  /**
   * Confirm a match between an order and a transaction.
   */
  static async confirmMatch(
    batchId: number,
    bookGuid: string,
    orderId: string,
    transactionGuid: string,
    itemMappings: Array<{ itemName: string; accountGuid: string }>,
  ): Promise<void> {
    // 1. Update all amazon_orders rows for this orderId
    await query(
      `UPDATE gnucash_web_amazon_orders
       SET match_status = 'confirmed', transaction_guid = $1
       WHERE book_guid = $2
         AND order_id = $3
         AND import_batch_id = $4`,
      [transactionGuid, bookGuid, orderId, batchId],
    );

    // 2. Record category mappings for each item
    for (const mapping of itemMappings) {
      await recordMapping(bookGuid, mapping.itemName, mapping.accountGuid);
    }
  }

  /**
   * Apply all confirmed matches in a batch.
   */
  static async applyBatch(
    batchId: number,
    bookGuid: string,
  ): Promise<ApplyResult> {
    // 1. Fetch batch settings
    const batchResult = await query(
      `SELECT settings FROM gnucash_web_import_batches WHERE id = $1 AND book_guid = $2`,
      [batchId, bookGuid],
    );

    if (batchResult.rows.length === 0) {
      throw new Error(`Batch ${batchId} not found`);
    }

    const settings = batchResult.rows[0].settings as Record<string, unknown>;
    const creditCardAccountGuid = settings.creditCardAccountGuid as string;
    const taxMode = (settings.taxMode as 'separate' | 'rolled_in') ?? 'separate';
    const shippingMode = (settings.shippingMode as 'separate' | 'rolled_in') ?? 'separate';
    const taxAccountGuid = settings.taxAccountGuid as string | undefined;
    const shippingAccountGuid = settings.shippingAccountGuid as string | undefined;

    // 2. Fetch all confirmed orders grouped by order_id
    const ordersResult = await query(
      `SELECT id, order_id, item_name, item_price, item_quantity,
              tax_amount, shipping_amount, order_total, charge_amount,
              transaction_guid
       FROM gnucash_web_amazon_orders
       WHERE import_batch_id = $1 AND book_guid = $2 AND match_status = 'confirmed'
       ORDER BY order_id, id`,
      [batchId, bookGuid],
    );

    // Group by order_id
    const orderGroups = new Map<
      string,
      Array<Record<string, unknown>>
    >();
    for (const row of ordersResult.rows) {
      const orderId = row.order_id as string;
      if (!orderGroups.has(orderId)) {
        orderGroups.set(orderId, []);
      }
      orderGroups.get(orderId)!.push(row);
    }

    let applied = 0;
    let failed = 0;
    const applyErrors: Array<{ orderId: string; error: string }> = [];

    // 3. Process each order
    for (const [orderId, items] of orderGroups) {
      try {
        const transactionGuid = items[0].transaction_guid as string;

        // a. Fetch the matched transaction to get its splits
        const txDetail = await TransactionService.getById(transactionGuid);
        if (!txDetail) {
          throw new Error(`Transaction ${transactionGuid} not found`);
        }

        // b. Check for reconciled splits
        const hasReconciled = txDetail.splits.some(
          (s) => s.reconcile_state === 'y',
        );
        if (hasReconciled) {
          throw new Error('Transaction has reconciled splits');
        }

        // c. Find the credit card split
        const ccSplit = txDetail.splits.find(
          (s) => s.account_guid === creditCardAccountGuid,
        );
        if (!ccSplit) {
          throw new Error('Credit card split not found in transaction');
        }

        const ccAmount = Math.abs(
          parseFloat(toDecimal(ccSplit.value_num, ccSplit.value_denom)),
        );

        // Shipping: take from first item row (order-level)
        const shippingAmount = parseFloat(items[0].shipping_amount as string) || 0;

        // d. Generate new splits
        const splitInput: SplitGeneratorInput = {
          items: items.map((item) => ({
            name: item.item_name as string,
            price: parseFloat(item.item_price as string),
            quantity: item.item_quantity as number,
            tax: parseFloat(item.tax_amount as string),
            accountGuid: item.item_name as string, // placeholder; real guid comes from category mappings
          })),
          shippingAmount,
          creditCardAccountGuid,
          creditCardAmount: ccAmount,
          currencyDenom: 100,
          taxMode,
          shippingMode,
          taxAccountGuid,
          shippingAccountGuid,
        };

        // Look up the account guids from category mappings for each item
        for (const splitItem of splitInput.items) {
          const suggestion = await suggestAccount(bookGuid, splitItem.name);
          if (suggestion) {
            splitItem.accountGuid = suggestion.accountGuid;
          }
        }

        const newSplits = generateSplits(splitInput);

        // e. Call TransactionService.update() with the new splits
        await TransactionService.update({
          guid: transactionGuid,
          currency_guid: txDetail.currency_guid,
          num: txDetail.num ?? '',
          post_date: txDetail.post_date ?? new Date(),
          description: txDetail.description ?? '',
          splits: newSplits.map((s) => ({
            account_guid: s.account_guid,
            value_num: s.value_num,
            value_denom: s.value_denom,
            memo: s.memo,
            action: '',
            reconcile_state: 'n' as const,
          })),
        });

        // f. Update apply_status to 'applied'
        await query(
          `UPDATE gnucash_web_amazon_orders
           SET apply_status = 'applied'
           WHERE book_guid = $1 AND order_id = $2 AND import_batch_id = $3`,
          [bookGuid, orderId, batchId],
        );

        applied++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        applyErrors.push({ orderId, error: errorMessage });
        failed++;

        // Update apply_status to 'failed'
        await query(
          `UPDATE gnucash_web_amazon_orders
           SET apply_status = 'failed'
           WHERE book_guid = $1 AND order_id = $2 AND import_batch_id = $3`,
          [bookGuid, orderId, batchId],
        );
      }
    }

    // 4. Update batch status
    const batchStatus =
      failed === 0
        ? 'completed'
        : applied === 0
          ? 'failed'
          : 'partially_applied';

    await query(
      `UPDATE gnucash_web_import_batches
       SET status = $1, completed_at = NOW()
       WHERE id = $2`,
      [batchStatus, batchId],
    );

    return { applied, failed, errors: applyErrors };
  }

  /**
   * Update batch settings.
   */
  static async updateBatchSettings(
    batchId: number,
    bookGuid: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    await query(
      `UPDATE gnucash_web_import_batches
       SET settings = settings || $1::jsonb
       WHERE id = $2 AND book_guid = $3`,
      [JSON.stringify(settings), batchId, bookGuid],
    );
  }

  /**
   * List all imported orders for a book.
   */
  static async listOrders(
    bookGuid: string,
    filters?: { matchStatus?: string; batchId?: number },
  ): Promise<
    Array<{
      id: number;
      orderId: string;
      orderDate: string;
      itemName: string;
      itemPrice: number;
      matchStatus: string;
      applyStatus: string;
      transactionGuid: string | null;
    }>
  > {
    let sql = `
      SELECT id, order_id, order_date::text as order_date, item_name,
             item_price, match_status, apply_status, transaction_guid
      FROM gnucash_web_amazon_orders
      WHERE book_guid = $1
    `;
    const params: unknown[] = [bookGuid];
    let paramIdx = 2;

    if (filters?.matchStatus) {
      sql += ` AND match_status = $${paramIdx}`;
      params.push(filters.matchStatus);
      paramIdx++;
    }

    if (filters?.batchId) {
      sql += ` AND import_batch_id = $${paramIdx}`;
      params.push(filters.batchId);
      paramIdx++;
    }

    sql += ' ORDER BY order_date DESC, order_id, id';

    const result = await query(sql, params);

    return result.rows.map((row) => ({
      id: row.id as number,
      orderId: row.order_id as string,
      orderDate: row.order_date as string,
      itemName: row.item_name as string,
      itemPrice: parseFloat(row.item_price as string),
      matchStatus: row.match_status as string,
      applyStatus: row.apply_status as string,
      transactionGuid: (row.transaction_guid as string) || null,
    }));
  }
}
