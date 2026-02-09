/**
 * GnuCash XML Parser
 *
 * Parses GnuCash XML files (optionally gzip-compressed) into typed data structures.
 * Handles namespace prefixes: gnc:, act:, trn:, split:, cmdty:, ts:, bgt:, cd:, book:, price:, slot:
 */

import { XMLParser } from 'fast-xml-parser';
import { gunzipSync } from 'fflate';
import type {
  GnuCashXmlData,
  GnuCashBook,
  GnuCashCommodity,
  GnuCashPrice,
  GnuCashAccount,
  GnuCashTransaction,
  GnuCashSplit,
  GnuCashBudget,
  GnuCashBudgetAmount,
} from './types';

/**
 * Ensure a value is always an array.
 * fast-xml-parser returns a single object when there's only one element.
 */
function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Extract a date string from a GnuCash timestamp element.
 * GnuCash stores dates as: <ts:date>2024-01-15 10:30:00 +0000</ts:date>
 */
function parseTimestamp(tsObj: unknown): string {
  if (!tsObj) return '';
  if (typeof tsObj === 'string') return tsObj;
  if (typeof tsObj === 'object' && tsObj !== null) {
    const obj = tsObj as Record<string, unknown>;
    // The date is in ts:date
    return String(obj['ts:date'] || obj['date'] || '');
  }
  return '';
}

/**
 * Extract commodity reference { space, id } from a GnuCash commodity element.
 */
function parseCommodityRef(cmdtyObj: unknown): { space: string; id: string } | undefined {
  if (!cmdtyObj || typeof cmdtyObj !== 'object') return undefined;
  const obj = cmdtyObj as Record<string, unknown>;
  const space = String(obj['cmdty:space'] || obj['space'] || '');
  const id = String(obj['cmdty:id'] || obj['id'] || '');
  if (!space && !id) return undefined;
  return { space, id };
}

/**
 * Parse a GnuCash XML file (gzip-compressed or raw XML) into typed data.
 */
export function parseGnuCashXml(data: Buffer | Uint8Array): GnuCashXmlData {
  let xmlString: string;

  // Try to decompress gzip first
  try {
    const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Check for gzip magic number (0x1f, 0x8b)
    if (uint8.length >= 2 && uint8[0] === 0x1f && uint8[1] === 0x8b) {
      const decompressed = gunzipSync(uint8);
      xmlString = new TextDecoder('utf-8').decode(decompressed);
    } else {
      xmlString = new TextDecoder('utf-8').decode(uint8);
    }
  } catch {
    // If gunzip fails, treat as raw XML
    xmlString = new TextDecoder('utf-8').decode(
      data instanceof Uint8Array ? data : new Uint8Array(data)
    );
  }

  // Parse XML
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
  });

  const parsed = parser.parse(xmlString);

  // Navigate to the book element
  // Structure: gnc-v2 > gnc:book (or the book may be directly under gnc-v2)
  const root = parsed['gnc-v2'];
  if (!root) {
    throw new Error('Invalid GnuCash XML: missing gnc-v2 root element');
  }

  const bookElement = root['gnc:book'];
  if (!bookElement) {
    throw new Error('Invalid GnuCash XML: missing gnc:book element');
  }

  // Parse book ID
  const book = parseBook(bookElement);

  // Parse count data
  const countData = parseCountData(bookElement);

  // Parse commodities
  const commodities = parseCommodities(bookElement);

  // Parse price database
  const pricedb = parsePriceDb(bookElement);

  // Parse accounts
  const accounts = parseAccounts(bookElement);

  // Parse transactions
  const transactions = parseTransactions(bookElement);

  // Parse budgets
  const budgets = parseBudgets(bookElement);

  return {
    book,
    commodities,
    pricedb,
    accounts,
    transactions,
    budgets,
    countData,
  };
}

function parseBook(bookElement: Record<string, unknown>): GnuCashBook {
  const bookId = bookElement['book:id'];
  let id = '';
  let idType = 'guid';

  if (typeof bookId === 'string') {
    id = bookId;
  } else if (bookId && typeof bookId === 'object') {
    const obj = bookId as Record<string, unknown>;
    id = String(obj['#text'] || '');
    idType = String(obj['@_type'] || 'guid');
  }

  return { id, idType };
}

function parseCountData(bookElement: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  const countElements = ensureArray(bookElement['gnc:count-data'] as unknown);

  for (const el of countElements) {
    if (typeof el === 'object' && el !== null) {
      const obj = el as Record<string, unknown>;
      const type = String(obj['@_cd:type'] || '');
      const value = parseInt(String(obj['#text'] || '0'), 10);
      if (type) counts[type] = value;
    } else if (typeof el === 'string') {
      // Simple text count without type attribute
    }
  }

  return counts;
}

function parseCommodities(bookElement: Record<string, unknown>): GnuCashCommodity[] {
  const rawCommodities = ensureArray(bookElement['gnc:commodity'] as unknown);
  return rawCommodities.map((raw) => {
    const obj = raw as Record<string, unknown>;
    return {
      space: String(obj['cmdty:space'] || ''),
      id: String(obj['cmdty:id'] || ''),
      name: obj['cmdty:name'] ? String(obj['cmdty:name']) : undefined,
      xcode: obj['cmdty:xcode'] ? String(obj['cmdty:xcode']) : undefined,
      fraction: parseInt(String(obj['cmdty:fraction'] || '1'), 10),
      quoteFlag: obj['cmdty:get_quotes'] !== undefined
        ? parseInt(String(obj['cmdty:get_quotes']), 10)
        : undefined,
      quoteSource: obj['cmdty:quote_source'] ? String(obj['cmdty:quote_source']) : undefined,
      quoteTz: obj['cmdty:quote_tz'] ? String(obj['cmdty:quote_tz']) : undefined,
    };
  });
}

function parsePriceDb(bookElement: Record<string, unknown>): GnuCashPrice[] {
  const pricedb = bookElement['gnc:pricedb'] as Record<string, unknown> | undefined;
  if (!pricedb) return [];

  const rawPrices = ensureArray(pricedb['price'] as unknown);
  return rawPrices.map((raw) => {
    const obj = raw as Record<string, unknown>;

    // Parse price ID
    let priceId = '';
    const idElement = obj['price:id'];
    if (typeof idElement === 'string') {
      priceId = idElement;
    } else if (idElement && typeof idElement === 'object') {
      priceId = String((idElement as Record<string, unknown>)['#text'] || '');
    }

    // Parse value fraction
    const valueObj = obj['price:value'] as string | undefined;
    const value = valueObj ? String(valueObj) : '0/1';

    return {
      id: priceId,
      commodity: parseCommodityRef(obj['price:commodity']) || { space: '', id: '' },
      currency: parseCommodityRef(obj['price:currency']) || { space: '', id: '' },
      date: parseTimestamp(obj['price:time']),
      source: String(obj['price:source'] || ''),
      type: obj['price:type'] ? String(obj['price:type']) : undefined,
      value,
    };
  });
}

function parseAccounts(bookElement: Record<string, unknown>): GnuCashAccount[] {
  const rawAccounts = ensureArray(bookElement['gnc:account'] as unknown);
  return rawAccounts.map((raw) => {
    const obj = raw as Record<string, unknown>;

    // Parse account ID
    let accountId = '';
    const idElement = obj['act:id'];
    if (typeof idElement === 'string') {
      accountId = idElement;
    } else if (idElement && typeof idElement === 'object') {
      accountId = String((idElement as Record<string, unknown>)['#text'] || '');
    }

    // Parse parent ID
    let parentId: string | undefined;
    const parentElement = obj['act:parent'];
    if (typeof parentElement === 'string') {
      parentId = parentElement;
    } else if (parentElement && typeof parentElement === 'object') {
      parentId = String((parentElement as Record<string, unknown>)['#text'] || '');
    }

    // Parse commodity SCU
    const commodityScu = obj['act:commodity-scu']
      ? parseInt(String(obj['act:commodity-scu']), 10)
      : undefined;

    return {
      name: String(obj['act:name'] || ''),
      id: accountId,
      type: String(obj['act:type'] || ''),
      commodity: parseCommodityRef(obj['act:commodity']),
      commodityScu: commodityScu,
      description: obj['act:description'] ? String(obj['act:description']) : undefined,
      parentId: parentId,
    };
  });
}

function parseTransactions(bookElement: Record<string, unknown>): GnuCashTransaction[] {
  const rawTransactions = ensureArray(bookElement['gnc:transaction'] as unknown);
  return rawTransactions.map((raw) => {
    const obj = raw as Record<string, unknown>;

    // Parse transaction ID
    let txId = '';
    const idElement = obj['trn:id'];
    if (typeof idElement === 'string') {
      txId = idElement;
    } else if (idElement && typeof idElement === 'object') {
      txId = String((idElement as Record<string, unknown>)['#text'] || '');
    }

    // Parse currency
    const currency = parseCommodityRef(obj['trn:currency']) || { space: '', id: '' };

    // Parse splits
    const splitsContainer = obj['trn:splits'] as Record<string, unknown> | undefined;
    const rawSplits = splitsContainer ? ensureArray(splitsContainer['trn:split'] as unknown) : [];

    const splits: GnuCashSplit[] = rawSplits.map((rawSplit) => {
      const splitObj = rawSplit as Record<string, unknown>;

      // Parse split ID
      let splitId = '';
      const splitIdElement = splitObj['split:id'];
      if (typeof splitIdElement === 'string') {
        splitId = splitIdElement;
      } else if (splitIdElement && typeof splitIdElement === 'object') {
        splitId = String((splitIdElement as Record<string, unknown>)['#text'] || '');
      }

      // Parse account reference
      let accountId = '';
      const accountElement = splitObj['split:account'];
      if (typeof accountElement === 'string') {
        accountId = accountElement;
      } else if (accountElement && typeof accountElement === 'object') {
        accountId = String((accountElement as Record<string, unknown>)['#text'] || '');
      }

      // Parse lot reference
      let lotId: string | undefined;
      const lotElement = splitObj['split:lot'];
      if (typeof lotElement === 'string') {
        lotId = lotElement;
      } else if (lotElement && typeof lotElement === 'object') {
        lotId = String((lotElement as Record<string, unknown>)['#text'] || '');
      }

      return {
        id: splitId,
        reconciledState: String(splitObj['split:reconciled-state'] || 'n'),
        reconcileDate: splitObj['split:reconcile-date']
          ? parseTimestamp(splitObj['split:reconcile-date'])
          : undefined,
        value: String(splitObj['split:value'] || '0/1'),
        quantity: String(splitObj['split:quantity'] || '0/1'),
        accountId,
        memo: splitObj['split:memo'] ? String(splitObj['split:memo']) : undefined,
        action: splitObj['split:action'] ? String(splitObj['split:action']) : undefined,
        lotId,
      };
    });

    return {
      id: txId,
      currency,
      num: obj['trn:num'] ? String(obj['trn:num']) : undefined,
      datePosted: parseTimestamp(obj['trn:date-posted']),
      dateEntered: parseTimestamp(obj['trn:date-entered']),
      description: String(obj['trn:description'] || ''),
      splits,
    };
  });
}

function parseBudgets(bookElement: Record<string, unknown>): GnuCashBudget[] {
  const rawBudgets = ensureArray(bookElement['gnc:budget'] as unknown);
  return rawBudgets.map((raw) => {
    const obj = raw as Record<string, unknown>;

    // Parse budget ID
    let budgetId = '';
    const idElement = obj['bgt:id'];
    if (typeof idElement === 'string') {
      budgetId = idElement;
    } else if (idElement && typeof idElement === 'object') {
      budgetId = String((idElement as Record<string, unknown>)['#text'] || '');
    }

    // Parse num periods
    const numPeriods = parseInt(String(obj['bgt:num-periods'] || '12'), 10);

    // Parse budget amounts from slots
    // Budget amounts in GnuCash XML are stored in slots
    const amounts: GnuCashBudgetAmount[] = [];
    const slotsContainer = obj['bgt:slots'] as Record<string, unknown> | undefined;
    if (slotsContainer) {
      const slotList = ensureArray(slotsContainer['slot'] as unknown);
      for (const slot of slotList) {
        const slotObj = slot as Record<string, unknown>;
        const slotKey = String(slotObj['slot:key'] || '');

        // Budget amounts have slot keys like account GUIDs
        // and slot values that are frames containing period->amount pairs
        if (slotObj['slot:value']) {
          const slotValue = slotObj['slot:value'] as Record<string, unknown>;
          const innerSlots = ensureArray(slotValue['slot'] as unknown);
          for (const innerSlot of innerSlots) {
            const innerObj = innerSlot as Record<string, unknown>;
            const periodKey = String(innerObj['slot:key'] || '');
            const periodNum = parseInt(periodKey, 10);
            if (!isNaN(periodNum)) {
              const amountVal = innerObj['slot:value'] as string | Record<string, unknown>;
              const amountStr = typeof amountVal === 'string'
                ? amountVal
                : String((amountVal as Record<string, unknown>)?.['#text'] || '0/1');
              amounts.push({
                accountId: slotKey,
                periodNum,
                amount: amountStr,
              });
            }
          }
        }
      }
    }

    return {
      id: budgetId,
      name: String(obj['bgt:name'] || ''),
      description: obj['bgt:description'] ? String(obj['bgt:description']) : undefined,
      numPeriods,
      amounts,
    };
  });
}
