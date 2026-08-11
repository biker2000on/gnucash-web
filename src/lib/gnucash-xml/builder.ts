/**
 * GnuCash XML Builder
 *
 * Builds valid GnuCash 2.6+ XML from typed data structures.
 * Optionally compresses the output with gzip.
 */

import { XMLBuilder } from 'fast-xml-parser';
import { gzipSync } from 'fflate';
import { buildSlotsContainer } from './slots';
import type { GnuCashXmlData, GnuCashSlot } from './types';

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
      '@_xmlns:fs': 'http://www.gnucash.org/XML/fs',
      '@_xmlns:bgt': 'http://www.gnucash.org/XML/bgt',
      '@_xmlns:recurrence': 'http://www.gnucash.org/XML/recurrence',
      '@_xmlns:lot': 'http://www.gnucash.org/XML/lot',
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
  void data;
  return [
    { '@_cd:type': 'book', '#text': '1' },
  ];
}

function buildBook(data: GnuCashXmlData): Record<string, unknown> {
  const book: Record<string, unknown> = {
    '@_version': '2.0.0',
    'book:id': { '@_type': data.book.idType || 'guid', '#text': data.book.id },
  };

  // book:slots — only when the book KVP frame is non-empty
  const bookSlots = buildSlotsContainer(data.book.slots);
  if (bookSlots) {
    book['book:slots'] = bookSlots;
  }

  // Count data for the book: one entry per element family actually emitted,
  // omitted when zero, in the upstream write_counts order
  // (commodity, account, transaction, budget, price).
  const counts: Record<string, unknown>[] = [];
  if (data.commodities.length > 0) {
    counts.push({ '@_cd:type': 'commodity', '#text': String(data.commodities.length) });
  }
  if (data.accounts.length > 0) {
    counts.push({ '@_cd:type': 'account', '#text': String(data.accounts.length) });
  }
  if (data.transactions.length > 0) {
    counts.push({ '@_cd:type': 'transaction', '#text': String(data.transactions.length) });
  }
  if (data.budgets.length > 0) {
    counts.push({ '@_cd:type': 'budget', '#text': String(data.budgets.length) });
  }
  if (data.pricedb.length > 0) {
    counts.push({ '@_cd:type': 'price', '#text': String(data.pricedb.length) });
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
    '@_version': '2.0.0',
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
  const slots = buildSlotsContainer(commodity.slots);
  if (slots) result['cmdty:slots'] = slots;
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
  if (account.nonStdScu) {
    result['act:non-standard-scu'] = '';
  }
  if (account.code) {
    result['act:code'] = account.code;
  }
  if (account.description) {
    result['act:description'] = account.description;
  }
  // Full slot passthrough, plus the hidden/placeholder/notes column
  // mirrors: mirror slots are only synthesized when the passthrough frame
  // doesn't already carry that key (no duplicates on round-trip).
  const slots: GnuCashSlot[] = account.slots ? [...account.slots] : [];
  const hasKey = (key: string) => slots.some((slot) => slot.key === key);
  if (account.hidden && !hasKey('hidden')) {
    slots.push({ key: 'hidden', value: { type: 'string', value: 'true' } });
  }
  if (account.placeholder && !hasKey('placeholder')) {
    slots.push({ key: 'placeholder', value: { type: 'string', value: 'true' } });
  }
  if (account.notes && !hasKey('notes')) {
    slots.push({ key: 'notes', value: { type: 'string', value: account.notes } });
  }
  const slotsContainer = buildSlotsContainer(slots);
  if (slotsContainer) {
    result['act:slots'] = slotsContainer;
  }
  if (account.parentId) {
    result['act:parent'] = { '@_type': 'guid', '#text': account.parentId };
  }
  // act:lots — sorted by guid, matching the upstream writer
  if (account.lots && account.lots.length > 0) {
    result['act:lots'] = {
      'gnc:lot': [...account.lots]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((lot) => {
          const lotResult: Record<string, unknown> = {
            '@_version': '2.0.0',
            'lot:id': { '@_type': 'guid', '#text': lot.id },
          };
          const lotSlots = buildSlotsContainer(lot.slots);
          if (lotSlots) lotResult['lot:slots'] = lotSlots;
          return lotResult;
        }),
    };
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

  const slots = buildSlotsContainer(tx.slots);
  if (slots) {
    result['trn:slots'] = slots;
  }

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
  const slots = buildSlotsContainer(split.slots);
  if (slots) {
    result['split:slots'] = slots;
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

  // Budget recurrence (required by GnuCash desktop);
  // weekend_adj is only emitted when not "none" (2.2 compat).
  if (budget.recurrence) {
    result['bgt:recurrence'] = {
      '@_version': '1.0.0',
      'recurrence:mult': String(budget.recurrence.mult),
      'recurrence:period_type': budget.recurrence.periodType,
      'recurrence:start': {
        'gdate': budget.recurrence.periodStart,
      },
      ...(budget.recurrence.weekendAdjust && budget.recurrence.weekendAdjust !== 'none'
        ? { 'recurrence:weekend_adj': budget.recurrence.weekendAdjust }
        : {}),
    };
  }

  // Build budget amounts as slots grouped by account, then append any
  // non-amount passthrough slots (per-period notes frames, etc.).
  const slots: Record<string, unknown>[] = [];
  if (budget.amounts.length > 0) {
    const byAccount = new Map<string, { periodNum: number; amount: string }[]>();
    for (const amt of budget.amounts) {
      const existing = byAccount.get(amt.accountId) || [];
      existing.push({ periodNum: amt.periodNum, amount: amt.amount });
      byAccount.set(amt.accountId, existing);
    }

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
  }
  const passthrough = buildSlotsContainer(budget.slots);
  if (passthrough) {
    slots.push(...(passthrough.slot as Record<string, unknown>[]));
  }
  if (slots.length > 0) {
    result['bgt:slots'] = { slot: slots };
  }

  return result;
}
