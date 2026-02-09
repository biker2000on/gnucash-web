/**
 * GnuCash XML Builder
 *
 * Builds valid GnuCash 2.6+ XML from typed data structures.
 * Optionally compresses the output with gzip.
 */

import { XMLBuilder } from 'fast-xml-parser';
import { gzipSync } from 'fflate';
import type { GnuCashXmlData } from './types';

/**
 * Build a GnuCash XML string from structured data.
 */
export function buildGnuCashXml(data: GnuCashXmlData): string {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    indentBy: '  ',
    suppressBooleanAttributes: false,
    suppressEmptyNode: true,
  });

  // Build the full document structure
  const doc = {
    '?xml': { '@_version': '1.0', '@_encoding': 'utf-8' },
    'gnc-v2': {
      '@_xmlns:gnc': 'http://www.gnucash.org/XML/gnc',
      '@_xmlns:act': 'http://www.gnucash.org/XML/act',
      '@_xmlns:book': 'http://www.gnucash.org/XML/book',
      '@_xmlns:cd': 'http://www.gnucash.org/XML/cd',
      '@_xmlns:cmdty': 'http://www.gnucash.org/XML/cmdty',
      '@_xmlns:price': 'http://www.gnucash.org/XML/price',
      '@_xmlns:slot': 'http://www.gnucash.org/XML/slot',
      '@_xmlns:split': 'http://www.gnucash.org/XML/split',
      '@_xmlns:sx': 'http://www.gnucash.org/XML/sx',
      '@_xmlns:trn': 'http://www.gnucash.org/XML/trn',
      '@_xmlns:ts': 'http://www.gnucash.org/XML/ts',
      '@_xmlns:bgt': 'http://www.gnucash.org/XML/bgt',
      'gnc:count-data': buildTopLevelCountData(data),
      'gnc:book': buildBook(data),
    },
  };

  return builder.build(doc);
}

/**
 * Compress a GnuCash XML string to gzip format.
 */
export function compressGnuCashXml(xml: string): Uint8Array {
  const encoded = new TextEncoder().encode(xml);
  return gzipSync(encoded);
}

function buildTopLevelCountData(data: GnuCashXmlData): Record<string, unknown>[] {
  return [
    { '@_cd:type': 'book', '#text': '1' },
  ];
}

function buildBook(data: GnuCashXmlData): Record<string, unknown> {
  const book: Record<string, unknown> = {
    '@_version': '2.0.0',
    'book:id': { '@_type': data.book.idType || 'guid', '#text': data.book.id },
  };

  // Count data for the book
  const counts: Record<string, unknown>[] = [];
  if (data.accounts.length > 0) {
    counts.push({ '@_cd:type': 'account', '#text': String(data.accounts.length) });
  }
  if (data.transactions.length > 0) {
    counts.push({ '@_cd:type': 'transaction', '#text': String(data.transactions.length) });
  }
  if (data.commodities.length > 0) {
    counts.push({ '@_cd:type': 'commodity', '#text': String(data.commodities.length) });
  }
  if (data.budgets.length > 0) {
    counts.push({ '@_cd:type': 'budget', '#text': String(data.budgets.length) });
  }
  if (counts.length > 0) {
    book['gnc:count-data'] = counts;
  }

  // Commodities
  if (data.commodities.length > 0) {
    book['gnc:commodity'] = data.commodities.map(buildCommodity);
  }

  // Price database
  if (data.pricedb.length > 0) {
    book['gnc:pricedb'] = {
      '@_version': '1',
      price: data.pricedb.map(buildPrice),
    };
  }

  // Accounts
  if (data.accounts.length > 0) {
    book['gnc:account'] = data.accounts.map(buildAccount);
  }

  // Transactions
  if (data.transactions.length > 0) {
    book['gnc:transaction'] = data.transactions.map(buildTransaction);
  }

  // Budgets
  if (data.budgets.length > 0) {
    book['gnc:budget'] = data.budgets.map(buildBudget);
  }

  return book;
}

function buildCommodity(commodity: GnuCashXmlData['commodities'][0]): Record<string, unknown> {
  const result: Record<string, unknown> = {
    'cmdty:space': commodity.space,
    'cmdty:id': commodity.id,
  };
  if (commodity.name) result['cmdty:name'] = commodity.name;
  if (commodity.xcode) result['cmdty:xcode'] = commodity.xcode;
  result['cmdty:fraction'] = String(commodity.fraction);
  if (commodity.quoteFlag !== undefined) {
    result['cmdty:get_quotes'] = '';
    if (commodity.quoteSource) result['cmdty:quote_source'] = commodity.quoteSource;
    if (commodity.quoteTz) result['cmdty:quote_tz'] = commodity.quoteTz;
  }
  return result;
}

function buildPrice(price: GnuCashXmlData['pricedb'][0]): Record<string, unknown> {
  return {
    'price:id': { '@_type': 'guid', '#text': price.id },
    'price:commodity': {
      'cmdty:space': price.commodity.space,
      'cmdty:id': price.commodity.id,
    },
    'price:currency': {
      'cmdty:space': price.currency.space,
      'cmdty:id': price.currency.id,
    },
    'price:time': {
      'ts:date': price.date,
    },
    'price:source': price.source,
    ...(price.type ? { 'price:type': price.type } : {}),
    'price:value': price.value,
  };
}

function buildAccount(account: GnuCashXmlData['accounts'][0]): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'act:name': account.name,
    'act:id': { '@_type': 'guid', '#text': account.id },
    'act:type': account.type,
  };
  if (account.commodity) {
    result['act:commodity'] = {
      'cmdty:space': account.commodity.space,
      'cmdty:id': account.commodity.id,
    };
  }
  if (account.commodityScu !== undefined) {
    result['act:commodity-scu'] = String(account.commodityScu);
  }
  if (account.description) {
    result['act:description'] = account.description;
  }
  if (account.parentId) {
    result['act:parent'] = { '@_type': 'guid', '#text': account.parentId };
  }
  return result;
}

function buildTransaction(tx: GnuCashXmlData['transactions'][0]): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'trn:id': { '@_type': 'guid', '#text': tx.id },
    'trn:currency': {
      'cmdty:space': tx.currency.space,
      'cmdty:id': tx.currency.id,
    },
  };
  if (tx.num) {
    result['trn:num'] = tx.num;
  }
  result['trn:date-posted'] = { 'ts:date': tx.datePosted };
  result['trn:date-entered'] = { 'ts:date': tx.dateEntered };
  result['trn:description'] = tx.description;

  if (tx.splits.length > 0) {
    result['trn:splits'] = {
      'trn:split': tx.splits.map(buildSplit),
    };
  }

  return result;
}

function buildSplit(split: GnuCashXmlData['transactions'][0]['splits'][0]): Record<string, unknown> {
  const result: Record<string, unknown> = {
    'split:id': { '@_type': 'guid', '#text': split.id },
    'split:reconciled-state': split.reconciledState,
  };
  if (split.reconcileDate) {
    result['split:reconcile-date'] = { 'ts:date': split.reconcileDate };
  }
  result['split:value'] = split.value;
  result['split:quantity'] = split.quantity;
  result['split:account'] = { '@_type': 'guid', '#text': split.accountId };
  if (split.memo) {
    result['split:memo'] = split.memo;
  }
  if (split.action) {
    result['split:action'] = split.action;
  }
  if (split.lotId) {
    result['split:lot'] = { '@_type': 'guid', '#text': split.lotId };
  }
  return result;
}

function buildBudget(budget: GnuCashXmlData['budgets'][0]): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'bgt:id': { '@_type': 'guid', '#text': budget.id },
    'bgt:name': budget.name,
  };
  if (budget.description) {
    result['bgt:description'] = budget.description;
  }
  result['bgt:num-periods'] = String(budget.numPeriods);

  // Build budget amounts as slots grouped by account
  if (budget.amounts.length > 0) {
    const byAccount = new Map<string, { periodNum: number; amount: string }[]>();
    for (const amt of budget.amounts) {
      const existing = byAccount.get(amt.accountId) || [];
      existing.push({ periodNum: amt.periodNum, amount: amt.amount });
      byAccount.set(amt.accountId, existing);
    }

    const slots: Record<string, unknown>[] = [];
    for (const [accountId, periods] of byAccount) {
      slots.push({
        'slot:key': accountId,
        'slot:value': {
          '@_type': 'frame',
          slot: periods.map((p) => ({
            'slot:key': String(p.periodNum),
            'slot:value': { '@_type': 'numeric', '#text': p.amount },
          })),
        },
      });
    }

    result['bgt:slots'] = { slot: slots };
  }

  return result;
}
