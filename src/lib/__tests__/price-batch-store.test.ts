/**
 * Batched price-storage tests.
 *
 * `storeFetchedPrices` writes 500-row chunks with a single multi-row
 * `INSERT ... ON CONFLICT DO UPDATE`. Postgres aborts the WHOLE statement with
 * "command cannot affect row a second time" if one statement touches the same
 * conflict key twice, so a provider returning two entries for one day used to
 * cost the entire chunk. These tests pin the intra-batch dedupe, the per-row
 * fallback, the user-price guard, and the batching of the market-index path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Prisma } from '@prisma/client';

const { db, chartMock, getCurrencyByMnemonicMock } = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(),
    prices: { findMany: vi.fn(), findFirst: vi.fn() },
    commodities: { findFirst: vi.fn(), create: vi.fn() },
    transactions: { findFirst: vi.fn() },
  },
  chartMock: vi.fn(),
  getCurrencyByMnemonicMock: vi.fn(),
}));

vi.mock('@/lib/prisma', async () => {
  const gnucash = await vi.importActual<typeof import('@/lib/gnucash')>('@/lib/gnucash');
  return {
    default: db,
    fromDecimal: gnucash.fromDecimal,
    generateGuid: gnucash.generateGuid,
    toDecimal: gnucash.toDecimal,
  };
});

vi.mock('@/lib/currency', () => ({ getCurrencyByMnemonic: getCurrencyByMnemonicMock }));

vi.mock('yahoo-finance2', () => ({
  default: class {
    chart = chartMock;
  },
}));

import { storeFetchedPrices, PRICE_DENOM } from '../yahoo-price-service';
import { fetchIndexPrices } from '../market-index-service';
import { fromDecimal } from '../gnucash';

/** guid, commodity_guid, currency_guid, date, value_num, value_denom */
const PARAMS_PER_ROW = 6;

interface CapturedRow {
  guid: string;
  commodity_guid: string;
  currency_guid: string;
  date: Date;
  num: bigint;
  denom: bigint;
}

/** Decode the flattened bind parameters of one multi-row INSERT statement. */
function decodeRows(query: Prisma.Sql): CapturedRow[] {
  const values = query.values as unknown[];
  const rows: CapturedRow[] = [];
  for (let i = 0; i < values.length; i += PARAMS_PER_ROW) {
    rows.push({
      guid: values[i] as string,
      commodity_guid: values[i + 1] as string,
      currency_guid: values[i + 2] as string,
      date: values[i + 3] as Date,
      num: values[i + 4] as bigint,
      denom: values[i + 5] as bigint,
    });
  }
  return rows;
}

/** Default behaviour: every submitted row upserts successfully. */
function echoInsert(query: Prisma.Sql) {
  return decodeRows(query).map((row) => ({
    guid: row.guid,
    commodity_guid: row.commodity_guid,
    date: row.date,
  }));
}

function insertCalls(): Prisma.Sql[] {
  return db.$queryRaw.mock.calls.map((call) => call[0] as Prisma.Sql);
}

const USD = 'usd-currency-guid';
const COMMODITY = 'commodity-abc';

beforeEach(() => {
  vi.clearAllMocks();
  db.$queryRaw.mockImplementation(async (query: Prisma.Sql) => echoInsert(query));
  getCurrencyByMnemonicMock.mockResolvedValue({
    guid: USD,
    mnemonic: 'USD',
    fullname: 'US Dollar',
    fraction: 100,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Intra-batch duplicates
// ---------------------------------------------------------------------------

describe('storeFetchedPrices duplicate handling', () => {
  it('collapses a same-day duplicate to one row without losing the rest of the chunk', async () => {
    const inputs = [
      { commodityGuid: COMMODITY, symbol: 'ABC', price: 10, date: new Date('2026-01-05T21:00:00Z') },
      { commodityGuid: COMMODITY, symbol: 'ABC', price: 11, date: new Date('2026-01-06T21:00:00Z') },
      // Same calendar day as the previous row, different intraday timestamp.
      { commodityGuid: COMMODITY, symbol: 'ABC', price: 12, date: new Date('2026-01-06T14:30:00Z') },
      { commodityGuid: COMMODITY, symbol: 'ABC', price: 13, date: new Date('2026-01-07T21:00:00Z') },
      { commodityGuid: COMMODITY, symbol: 'ABC', price: 14, date: new Date('2026-01-08T21:00:00Z') },
    ];

    const stored = await storeFetchedPrices(inputs, USD);

    // One statement, and it carries four rows -- the duplicate day was dropped
    // before chunking rather than aborting the whole statement.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const rows = decodeRows(insertCalls()[0]);
    expect(rows).toHaveLength(4);

    // The other four days all survived.
    expect(stored.size).toBe(4);
    for (const day of ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']) {
      expect(stored.has(`${COMMODITY}:${day}`)).toBe(true);
    }
  });

  it('keeps the last duplicate for a day (last-write-wins)', async () => {
    await storeFetchedPrices(
      [
        { commodityGuid: COMMODITY, symbol: 'ABC', price: 11, date: new Date('2026-01-06T14:30:00Z') },
        { commodityGuid: COMMODITY, symbol: 'ABC', price: 12, date: new Date('2026-01-06T21:00:00Z') },
      ],
      USD,
    );

    const rows = decodeRows(insertCalls()[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].num).toBe(fromDecimal(12, PRICE_DENOM).num);
    expect(rows[0].date.toISOString()).toBe('2026-01-06T21:00:00.000Z');
  });

  it('does not collapse the same day across different commodities', async () => {
    const stored = await storeFetchedPrices(
      [
        { commodityGuid: 'commodity-a', symbol: 'A', price: 1, date: new Date('2026-01-06T21:00:00Z') },
        { commodityGuid: 'commodity-b', symbol: 'B', price: 2, date: new Date('2026-01-06T21:00:00Z') },
      ],
      USD,
    );

    expect(decodeRows(insertCalls()[0])).toHaveLength(2);
    expect(stored.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Chunk failure fallback
// ---------------------------------------------------------------------------

describe('storeFetchedPrices chunk failure fallback', () => {
  it('retries row by row so one poison row costs one price, not the batch', async () => {
    const poisonNum = fromDecimal(999, PRICE_DENOM).num;

    db.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      const rows = decodeRows(query);
      // The multi-row statement blows up (as it would on a bigint overflow).
      if (rows.length > 1) throw new Error('value out of range for type bigint');
      if (rows[0].num === poisonNum) throw new Error('value out of range for type bigint');
      return echoInsert(query);
    });

    const stored = await storeFetchedPrices(
      [
        { commodityGuid: COMMODITY, symbol: 'ABC', price: 10, date: new Date('2026-01-05T21:00:00Z') },
        { commodityGuid: COMMODITY, symbol: 'ABC', price: 999, date: new Date('2026-01-06T21:00:00Z') },
        { commodityGuid: COMMODITY, symbol: 'ABC', price: 12, date: new Date('2026-01-07T21:00:00Z') },
        { commodityGuid: COMMODITY, symbol: 'ABC', price: 13, date: new Date('2026-01-08T21:00:00Z') },
      ],
      USD,
    );

    expect(stored.size).toBe(3);
    expect(stored.has(`${COMMODITY}:2026-01-06`)).toBe(false);
    expect(stored.has(`${COMMODITY}:2026-01-05`)).toBe(true);
    expect(stored.has(`${COMMODITY}:2026-01-07`)).toBe(true);
    expect(stored.has(`${COMMODITY}:2026-01-08`)).toBe(true);
  });

  it('logs a single aggregate line when every row of a chunk fails', async () => {
    db.$queryRaw.mockRejectedValue(new Error('connection terminated'));

    const stored = await storeFetchedPrices(
      Array.from({ length: 4 }, (_, i) => ({
        commodityGuid: COMMODITY,
        symbol: 'ABC',
        price: 10 + i,
        date: new Date(Date.UTC(2026, 0, 5 + i, 21)),
      })),
      USD,
    );

    expect(stored.size).toBe(0);
    const aggregate = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('after per-row retry'),
    );
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0][0]).toContain('Dropped 4/4');
  });
});

// ---------------------------------------------------------------------------
// Upsert semantics that must not regress
// ---------------------------------------------------------------------------

describe('storeFetchedPrices upsert semantics', () => {
  it('keeps the user-price guard, the unique-index conflict target and 1e8 precision', async () => {
    await storeFetchedPrices(
      [{ commodityGuid: COMMODITY, symbol: 'ABC', price: 0.00072, date: new Date('2026-01-05T21:00:00Z') }],
      USD,
    );

    const sql = insertCalls()[0].text.replace(/\s+/g, ' ');
    expect(sql).toContain('ON CONFLICT (commodity_guid, currency_guid, date)');
    expect(sql).toContain('DO UPDATE SET value_num = EXCLUDED.value_num, value_denom = EXCLUDED.value_denom');
    // Never overwrite a manually entered price.
    expect(sql).toContain("WHERE prices.source = 'Finance::Quote'");

    const rows = decodeRows(insertCalls()[0]);
    expect(rows[0].denom).toBe(BigInt(PRICE_DENOM));
    expect(rows[0].num).toBe(72000n); // 0.00072 survives at 1e8, not rounded to 0
    expect(rows[0].currency_guid).toBe(USD);
  });

  it('does not look up a currency when the guid is supplied', async () => {
    await storeFetchedPrices(
      [{ commodityGuid: COMMODITY, symbol: 'ABC', price: 10, date: new Date('2026-01-05T21:00:00Z') }],
      USD,
    );
    expect(getCurrencyByMnemonicMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Market index path
// ---------------------------------------------------------------------------

describe('fetchIndexPrices batching', () => {
  const INDEX_COUNT = 4;
  const QUOTE_DAYS = 6;

  beforeEach(() => {
    db.commodities.findFirst.mockImplementation(async (args: { where: { mnemonic: string } }) => ({
      guid: `index-${args.where.mnemonic}`,
    }));
    // No prices stored yet, so every fetched quote is "missing".
    db.prices.findMany.mockResolvedValue([]);
    chartMock.mockResolvedValue({
      quotes: Array.from({ length: QUOTE_DAYS }, (_, i) => ({
        date: new Date(Date.UTC(2026, 0, 5 + i, 21)),
        close: 100 + i,
      })),
    });
  });

  it('issues one currency lookup per run rather than one per price', async () => {
    await fetchIndexPrices(30);

    // Previously: one getCurrencyByMnemonic + one INSERT per row
    // (4 indices x 6 days = 24 of each).
    expect(getCurrencyByMnemonicMock).toHaveBeenCalledTimes(1);
    expect(getCurrencyByMnemonicMock).toHaveBeenCalledWith('USD');
  });

  it('issues one batched insert per index instead of one per price', async () => {
    const results = await fetchIndexPrices(30);

    expect(db.$queryRaw).toHaveBeenCalledTimes(INDEX_COUNT);
    for (const call of insertCalls()) {
      const rows = decodeRows(call);
      expect(rows).toHaveLength(QUOTE_DAYS);
      // The hoisted guid is threaded through instead of being re-resolved.
      expect(rows.every((row) => row.currency_guid === USD)).toBe(true);
    }

    expect(results).toHaveLength(INDEX_COUNT);
    expect(results.every((r) => r.stored === QUOTE_DAYS)).toBe(true);
  });

  it('skips days already present in the prices table', async () => {
    db.prices.findMany.mockResolvedValue([
      { date: new Date(Date.UTC(2026, 0, 5, 21)) },
      { date: new Date(Date.UTC(2026, 0, 6, 21)) },
    ]);

    const results = await fetchIndexPrices(30);

    for (const call of insertCalls()) {
      expect(decodeRows(call)).toHaveLength(QUOTE_DAYS - 2);
    }
    expect(results.every((r) => r.stored === QUOTE_DAYS - 2)).toBe(true);
  });
});
