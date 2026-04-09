/**
 * Amazon CSV Parser Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseAmazonCsv,
  extractCsvFromZip,
  detectFormat,
} from '../amazon-csv-parser';

// We mock fflate for the ZIP extraction tests because the jsdom environment
// resolves the browser build of fflate, which handles zipSync/unzipSync
// differently than the node build.
const mockUnzipSync = vi.fn();
vi.mock('fflate', () => ({
  unzipSync: (...args: unknown[]) => mockUnzipSync(...args),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const HEADERS =
  'Order ID,Order Date,Order Status,Shipping Charge,Total Owed,Shipment Item Subtotal,Shipment Item Subtotal Tax,ASIN,Title,Category,Quantity,Payment Instrument Type,Unit Price,Unit Price Tax,Item Subtotal,Item Subtotal Tax,Item Total,Currency';

function makeRow(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    'Order ID': '111-2222222-3333333',
    'Order Date': '2024-03-15',
    'Order Status': 'Shipped',
    'Shipping Charge': '$5.99',
    'Total Owed': '$31.98',
    'Shipment Item Subtotal': '$23.99',
    'Shipment Item Subtotal Tax': '$2.00',
    ASIN: 'B0EXAMPLE1',
    Title: 'USB-C Cable 6ft',
    Category: 'Electronics',
    Quantity: '1',
    'Payment Instrument Type': 'Visa - 1234',
    'Unit Price': '$23.99',
    'Unit Price Tax': '$2.00',
    'Item Subtotal': '$23.99',
    'Item Subtotal Tax': '$2.00',
    'Item Total': '$25.99',
    Currency: 'USD',
  };

  const merged = { ...defaults, ...overrides };
  const headerNames = HEADERS.split(',');
  return headerNames
    .map((h) => {
      const val = merged[h] ?? '';
      return val.includes(',') ? `"${val}"` : val;
    })
    .join(',');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseAmazonCsv', () => {
  it('happy path: parses a multi-order CSV correctly', () => {
    const csv = [
      HEADERS,
      makeRow({
        'Order ID': '111-0000001-0000001',
        'Order Date': '2024-01-10',
        Title: 'Widget A',
        'Item Subtotal': '$10.00',
        'Item Subtotal Tax': '$0.80',
        'Item Total': '$10.80',
        'Shipping Charge': '$3.99',
      }),
      makeRow({
        'Order ID': '111-0000002-0000002',
        'Order Date': '2024-02-20',
        Title: 'Widget B',
        'Item Subtotal': '$20.00',
        'Item Subtotal Tax': '$1.60',
        'Item Total': '$21.60',
        'Shipping Charge': '$0.00',
      }),
    ].join('\n');

    const result = parseAmazonCsv(csv);

    expect(result.errors).toHaveLength(0);
    expect(result.orders).toHaveLength(2);

    const [order1, order2] = result.orders;
    expect(order1.orderId).toBe('111-0000001-0000001');
    expect(order1.orderDate).toEqual(new Date(2024, 0, 10));
    expect(order1.items).toHaveLength(1);
    expect(order1.items[0].name).toBe('Widget A');
    expect(order1.items[0].price).toBe(10.0);
    expect(order1.items[0].tax).toBe(0.8);
    expect(order1.taxTotal).toBe(0.8);
    expect(order1.shippingTotal).toBe(3.99);
    expect(order1.orderTotal).toBe(14.79); // 10.80 + 3.99
    expect(order1.chargeAmount).toBe(14.79);
    expect(order1.currency).toBe('USD');

    expect(order2.orderId).toBe('111-0000002-0000002');
    expect(order2.orderTotal).toBe(21.6);
    expect(order2.shippingTotal).toBe(0);
  });

  it('multi-item order: groups items under one order', () => {
    const csv = [
      HEADERS,
      makeRow({
        'Order ID': '111-MULTI-001',
        Title: 'Item One',
        ASIN: 'B001',
        'Item Subtotal': '$5.00',
        'Item Subtotal Tax': '$0.40',
        'Item Total': '$5.40',
        'Shipping Charge': '$2.00',
      }),
      makeRow({
        'Order ID': '111-MULTI-001',
        Title: 'Item Two',
        ASIN: 'B002',
        'Item Subtotal': '$15.00',
        'Item Subtotal Tax': '$1.20',
        'Item Total': '$16.20',
        'Shipping Charge': '$2.00',
      }),
      makeRow({
        'Order ID': '111-MULTI-001',
        Title: 'Item Three',
        ASIN: 'B003',
        'Item Subtotal': '$8.00',
        'Item Subtotal Tax': '$0.64',
        'Item Total': '$8.64',
        'Shipping Charge': '$2.00',
      }),
    ].join('\n');

    const result = parseAmazonCsv(csv);

    expect(result.orders).toHaveLength(1);
    const order = result.orders[0];
    expect(order.items).toHaveLength(3);
    expect(order.items.map((i) => i.name)).toEqual([
      'Item One',
      'Item Two',
      'Item Three',
    ]);
    expect(order.taxTotal).toBeCloseTo(2.24, 2);
    // Shipping: max of repeated $2.00 = $2.00
    expect(order.shippingTotal).toBe(2.0);
    // Total: 5.40 + 16.20 + 8.64 + 2.00 = 32.24
    expect(order.orderTotal).toBeCloseTo(32.24, 2);
  });

  it('skips cancelled orders', () => {
    const csv = [
      HEADERS,
      makeRow({
        'Order ID': '111-CANCELLED-001',
        'Order Status': 'Cancelled',
        Title: 'Cancelled Widget',
      }),
      makeRow({
        'Order ID': '111-ACTIVE-001',
        'Order Status': 'Shipped',
        Title: 'Active Widget',
      }),
    ].join('\n');

    const result = parseAmazonCsv(csv);

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].orderId).toBe('111-ACTIVE-001');
  });

  it('returns empty orders for headers-only CSV', () => {
    const csv = HEADERS;
    const result = parseAmazonCsv(csv);

    expect(result.orders).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.duplicateCount).toBe(0);
  });

  it('returns error for invalid/unrecognized CSV headers', () => {
    const csv = 'Name,Email,Phone\nJohn,john@test.com,555-1234';
    const result = parseAmazonCsv(csv);

    expect(result.orders).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Unrecognized CSV format');
  });

  it('detects gift card payment and sets chargeAmount to null', () => {
    const csv = [
      HEADERS,
      makeRow({
        'Order ID': '111-GIFT-001',
        'Payment Instrument Type': 'Gift Certificate/Card',
        'Item Subtotal': '$25.00',
        'Item Subtotal Tax': '$2.00',
        'Item Total': '$27.00',
        'Shipping Charge': '$0.00',
        'Total Owed': '$0.00',
      }),
    ].join('\n');

    const result = parseAmazonCsv(csv);

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].chargeAmount).toBeNull();
  });

  it('handles mixed payment with gift card (reduced chargeAmount)', () => {
    const csv = [
      HEADERS,
      makeRow({
        'Order ID': '111-MIXED-001',
        ASIN: 'B001',
        'Payment Instrument Type': 'Visa - 1234',
        'Item Subtotal': '$30.00',
        'Item Subtotal Tax': '$2.40',
        'Item Total': '$32.40',
        'Shipping Charge': '$5.00',
        'Total Owed': '$37.40',
      }),
      makeRow({
        'Order ID': '111-MIXED-001',
        ASIN: 'B002',
        'Payment Instrument Type': 'Gift Certificate/Card',
        'Item Subtotal': '$10.00',
        'Item Subtotal Tax': '$0.80',
        'Item Total': '$10.80',
        'Shipping Charge': '$5.00',
        'Total Owed': '$37.40',
      }),
    ].join('\n');

    const result = parseAmazonCsv(csv);
    const order = result.orders[0];

    // orderTotal = 32.40 + 10.80 + 5.00 = 48.20
    expect(order.orderTotal).toBeCloseTo(48.2, 2);
    // chargeAmount should be Total Owed (37.40) since it's less than orderTotal
    expect(order.chargeAmount).toBe(37.4);
  });

  it('assigns unique csvRowIndex to duplicate items in same order', () => {
    const csv = [
      HEADERS,
      makeRow({
        'Order ID': '111-DUP-001',
        Title: 'Same Item',
        ASIN: 'B0SAME',
        'Item Subtotal': '$10.00',
        'Item Subtotal Tax': '$0.80',
        'Item Total': '$10.80',
      }),
      makeRow({
        'Order ID': '111-DUP-001',
        Title: 'Same Item',
        ASIN: 'B0SAME',
        'Item Subtotal': '$10.00',
        'Item Subtotal Tax': '$0.80',
        'Item Total': '$10.80',
      }),
    ].join('\n');

    const result = parseAmazonCsv(csv);
    const order = result.orders[0];

    expect(order.items).toHaveLength(2);
    expect(order.items[0].csvRowIndex).toBe(0);
    expect(order.items[1].csvRowIndex).toBe(1);
    expect(order.items[0].csvRowIndex).not.toBe(order.items[1].csvRowIndex);
  });

  it('parses various Amazon date formats correctly', () => {
    const formats = [
      { input: '2024-03-15', expected: new Date(2024, 2, 15) },
      { input: '2024-03-15T00:00:00', expected: new Date(2024, 2, 15) },
      { input: '03/15/2024', expected: new Date(2024, 2, 15) },
      { input: 'March 15, 2024', expected: new Date(2024, 2, 15) },
    ];

    for (const { input, expected } of formats) {
      const csv = [
        HEADERS,
        makeRow({
          'Order ID': `DATE-TEST-${input}`,
          'Order Date': input,
        }),
      ].join('\n');

      const result = parseAmazonCsv(csv);
      expect(result.orders).toHaveLength(1);
      expect(result.orders[0].orderDate).toEqual(expected);
    }
  });
});

describe('detectFormat', () => {
  it('identifies "Request My Data" format', () => {
    expect(detectFormat(HEADERS)).toBe('request-my-data');
  });

  it('identifies "Order History Reports" format', () => {
    const ohrHeader =
      'Order Date,Order ID,Payment Instrument Type,Website,Purchase Order Number,Ordering Customer Email,Shipment Date';
    expect(detectFormat(ohrHeader)).toBe('order-history-reports');
  });

  it('returns unknown for unrecognized headers', () => {
    expect(detectFormat('foo,bar,baz')).toBe('unknown');
    expect(detectFormat('')).toBe('unknown');
  });
});

describe('extractCsvFromZip', () => {
  it('extracts CSV from a ZIP containing Retail.OrderHistory directory', async () => {
    const csvContent = `${HEADERS}\n${makeRow()}`;
    const encoder = new TextEncoder();

    mockUnzipSync.mockReturnValue({
      'Retail.OrderHistory.1/Retail.OrderHistory.csv': encoder.encode(csvContent),
    });

    const result = await extractCsvFromZip(Buffer.from('fake-zip'));
    expect(result).toBe(csvContent);
    expect(mockUnzipSync).toHaveBeenCalledOnce();
  });

  it('throws when no matching CSV is found in ZIP', async () => {
    const encoder = new TextEncoder();

    mockUnzipSync.mockReturnValue({
      'other_file.txt': encoder.encode('not a csv'),
    });

    await expect(
      extractCsvFromZip(Buffer.from('fake-zip')),
    ).rejects.toThrow('No Retail.OrderHistory CSV file found');
  });

  it('rejects ZIP entries with path traversal (..)', async () => {
    const encoder = new TextEncoder();

    mockUnzipSync.mockReturnValue({
      'Retail.OrderHistory/../../../etc/Retail.OrderHistory.csv': encoder.encode(HEADERS),
    });

    await expect(
      extractCsvFromZip(Buffer.from('fake-zip')),
    ).rejects.toThrow('path traversal');
  });
});
