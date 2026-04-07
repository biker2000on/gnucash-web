/**
 * Amazon CSV Parser
 *
 * Parses Amazon "Request My Data" order history CSV exports into structured
 * order objects suitable for creating GnuCash transaction splits.
 */

import { unzipSync } from 'fflate';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AmazonOrder {
  orderId: string;
  orderDate: Date;
  items: AmazonOrderItem[];
  orderTotal: number;
  taxTotal: number;
  shippingTotal: number;
  chargeAmount: number | null;
  currency: string;
}

export interface AmazonOrderItem {
  name: string;
  price: number;
  quantity: number;
  tax: number;
  category: string | null;
  csvRowIndex: number;
}

export interface ParseResult {
  orders: AmazonOrder[];
  duplicateCount: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

const REQUEST_MY_DATA_COLUMNS = [
  'Order ID',
  'Order Date',
  'Unit Price',
  'Quantity',
  'ASIN',
];

const ORDER_HISTORY_REPORTS_COLUMNS = [
  'Order Date',
  'Order ID',
  'Payment Instrument Type',
  'Website',
  'Purchase Order Number',
];

export function detectFormat(
  headerRow: string,
): 'request-my-data' | 'order-history-reports' | 'unknown' {
  if (REQUEST_MY_DATA_COLUMNS.every((col) => headerRow.includes(col))) {
    return 'request-my-data';
  }
  if (ORDER_HISTORY_REPORTS_COLUMNS.every((col) => headerRow.includes(col))) {
    return 'order-history-reports';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Parse a CSV line respecting quoted fields (handles commas and newlines inside quotes).
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Split CSV content into lines, handling quoted fields that span multiple lines.
 */
function splitCsvLines(content: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && i + 1 < content.length && content[i + 1] === '\n') {
        i++; // skip \r\n
      }
      if (current.length > 0) {
        lines.push(current);
      }
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function parseNumber(value: string): number {
  if (!value) return 0;
  // Remove currency symbols and whitespace
  const cleaned = value.replace(/[$€£¥,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseAmazonDate(value: string): Date {
  if (!value) return new Date(NaN);

  // Amazon uses several date formats:
  // "2024-01-15T00:00:00" (ISO-ish)
  // "01/15/2024"
  // "January 15, 2024"
  // "2024-01-15"

  // Try ISO format first
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    // Parse as local date (not UTC) to avoid timezone shifts
    const parts = value.split(/[T ]/)[0].split('-');
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  }

  // Try MM/DD/YYYY
  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return new Date(
      parseInt(slashMatch[3]),
      parseInt(slashMatch[1]) - 1,
      parseInt(slashMatch[2]),
    );
  }

  // Try "Month DD, YYYY"
  const longMatch = value.match(
    /^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/,
  );
  if (longMatch) {
    const parsed = new Date(`${longMatch[1]} ${longMatch[2]}, ${longMatch[3]}`);
    // Return a date with no time component
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  // Fallback
  const d = new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseAmazonCsv(csvContent: string): ParseResult {
  const errors: string[] = [];
  const lines = splitCsvLines(csvContent);

  if (lines.length === 0) {
    return { orders: [], duplicateCount: 0, errors: ['CSV is empty'] };
  }

  const headerLine = lines[0];
  const format = detectFormat(headerLine);

  if (format === 'unknown') {
    return {
      orders: [],
      duplicateCount: 0,
      errors: ['Unrecognized CSV format. Expected Amazon "Request My Data" export.'],
    };
  }

  if (format === 'order-history-reports') {
    return {
      orders: [],
      duplicateCount: 0,
      errors: [
        'Amazon "Order History Reports" format detected but not yet supported. Please use "Request My Data" export.',
      ],
    };
  }

  const headers = parseCsvLine(headerLine);
  const colIndex = new Map<string, number>();
  headers.forEach((h, i) => colIndex.set(h, i));

  // Validate required columns
  const requiredColumns = [
    'Order ID',
    'Order Date',
    'Quantity',
    'Order Status',
  ];
  const missingColumns = requiredColumns.filter((c) => !colIndex.has(c));
  if (missingColumns.length > 0) {
    return {
      orders: [],
      duplicateCount: 0,
      errors: [`Missing required columns: ${missingColumns.join(', ')}`],
    };
  }

  // Helper to get column value
  const col = (row: string[], name: string): string => {
    const idx = colIndex.get(name);
    return idx !== undefined && idx < row.length ? row[idx] : '';
  };

  // Group rows by Order ID
  const orderMap = new Map<
    string,
    { items: AmazonOrderItem[]; rows: string[][]; rowIndices: number[] }
  >();
  const seenItemKeys = new Set<string>();
  let duplicateCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length < 3) continue; // skip malformed rows

    const status = col(row, 'Order Status');
    if (status.toLowerCase().includes('cancelled')) continue;

    const orderId = col(row, 'Order ID');
    if (!orderId) continue;

    // Deduplication key: orderId + ASIN + row position
    const asin = col(row, 'ASIN');
    const itemKey = `${orderId}|${asin}|${col(row, 'Title') || col(row, 'Product Name')}`;

    // Track items for the order
    if (!orderMap.has(orderId)) {
      orderMap.set(orderId, { items: [], rows: [], rowIndices: [] });
    }

    const orderData = orderMap.get(orderId)!;
    const csvRowIndex = i - 1; // 0-based data row index

    // Check for exact duplicate (same key and already seen)
    const fullKey = `${itemKey}|${csvRowIndex}`;
    if (seenItemKeys.has(fullKey)) {
      duplicateCount++;
      continue;
    }
    seenItemKeys.add(fullKey);

    const itemName =
      col(row, 'Title') || col(row, 'Product Name') || `Unknown item (${asin})`;
    const quantity = parseInt(col(row, 'Quantity')) || 1;

    // Price: prefer Item Subtotal (total for qty), fall back to Unit Price * qty
    let price = parseNumber(col(row, 'Item Subtotal'));
    if (price === 0) {
      price = parseNumber(col(row, 'Unit Price')) * quantity;
    }

    const tax = parseNumber(col(row, 'Item Subtotal Tax')) || parseNumber(col(row, 'Unit Price Tax')) * quantity;

    const category = col(row, 'Category') || null;

    orderData.items.push({
      name: itemName,
      price,
      quantity,
      tax,
      category,
      csvRowIndex,
    });
    orderData.rows.push(row);
    orderData.rowIndices.push(csvRowIndex);
  }

  // Build AmazonOrder objects
  const orders: AmazonOrder[] = [];

  for (const [orderId, data] of orderMap) {
    if (data.items.length === 0) continue;

    const firstRow = data.rows[0];

    const orderDate = parseAmazonDate(col(firstRow, 'Order Date'));
    if (isNaN(orderDate.getTime())) {
      errors.push(`Order ${orderId}: Invalid date "${col(firstRow, 'Order Date')}"`);
      continue;
    }

    // Shipping: take the max value (it's repeated on every row)
    let shippingTotal = 0;
    for (const row of data.rows) {
      const shipping = parseNumber(col(row, 'Shipping Charge'));
      if (shipping > shippingTotal) shippingTotal = shipping;
    }

    // Tax total: sum of item taxes
    const taxTotal = data.items.reduce((sum, item) => sum + item.tax, 0);

    // Order total: sum of Item Total (price + tax) + shipping
    let orderTotal = 0;
    for (let i = 0; i < data.items.length; i++) {
      const itemTotal = parseNumber(col(data.rows[i], 'Item Total'));
      if (itemTotal > 0) {
        orderTotal += itemTotal;
      } else {
        orderTotal += data.items[i].price + data.items[i].tax;
      }
    }
    orderTotal += shippingTotal;

    // Round to avoid floating-point artifacts
    orderTotal = Math.round(orderTotal * 100) / 100;
    const taxTotalRounded = Math.round(taxTotal * 100) / 100;
    shippingTotal = Math.round(shippingTotal * 100) / 100;

    // Payment instrument / gift card detection
    let chargeAmount: number | null = orderTotal;
    const paymentTypes = new Set<string>();
    for (const row of data.rows) {
      const pt = col(row, 'Payment Instrument Type');
      if (pt) paymentTypes.add(pt);
    }

    const hasGiftCard = [...paymentTypes].some(
      (pt) =>
        pt.toLowerCase().includes('gift') ||
        pt.toLowerCase().includes('promotional'),
    );

    if (hasGiftCard) {
      // If all payment types are gift card, no CC charge
      const allGift = [...paymentTypes].every(
        (pt) =>
          pt.toLowerCase().includes('gift') ||
          pt.toLowerCase().includes('promotional'),
      );
      if (allGift) {
        chargeAmount = null;
      } else {
        // Mixed payment — we can't determine the exact split from CSV alone,
        // but Total Owed sometimes reflects the CC portion
        const totalOwed = parseNumber(col(firstRow, 'Total Owed'));
        if (totalOwed > 0 && totalOwed < orderTotal) {
          chargeAmount = Math.round(totalOwed * 100) / 100;
        }
        // Otherwise keep chargeAmount = orderTotal as best estimate
      }
    }

    // Currency detection
    const currency = col(firstRow, 'Currency') || 'USD';

    orders.push({
      orderId,
      orderDate,
      items: data.items,
      orderTotal,
      taxTotal: taxTotalRounded,
      shippingTotal,
      chargeAmount,
      currency,
    });
  }

  // Sort by date
  orders.sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime());

  return { orders, duplicateCount, errors };
}

// ---------------------------------------------------------------------------
// ZIP extraction
// ---------------------------------------------------------------------------

export async function extractCsvFromZip(zipBuffer: Buffer | Uint8Array): Promise<string> {
  const uint8 =
    zipBuffer instanceof Uint8Array && !(zipBuffer instanceof Buffer)
      ? zipBuffer
      : new Uint8Array((zipBuffer as Buffer).buffer, (zipBuffer as Buffer).byteOffset, (zipBuffer as Buffer).byteLength);
  const files = unzipSync(uint8);

  for (const path of Object.keys(files)) {
    // Path traversal protection
    if (path.includes('..')) {
      throw new Error(`Rejected ZIP entry with path traversal: ${path}`);
    }
  }

  // Look for Retail.OrderHistory.csv or any CSV in a Retail.OrderHistory directory
  for (const path of Object.keys(files)) {
    const normalized = path.replace(/\\/g, '/');
    if (
      normalized.includes('Retail.OrderHistory') &&
      normalized.endsWith('.csv')
    ) {
      return new TextDecoder().decode(files[path]);
    }
  }

  throw new Error(
    'No Retail.OrderHistory CSV file found in ZIP archive',
  );
}
