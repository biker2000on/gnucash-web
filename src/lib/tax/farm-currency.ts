import prisma from '@/lib/prisma';
import { findExchangeRate } from '@/lib/currency';

interface DailySplitRow {
  account_guid: string;
  currency_guid: string;
  post_date: Date;
  total: number;
}

export interface FarmCurrencyTotal {
  accountGuid: string;
  total: number;
}

export interface FarmCurrencySumResult {
  totals: FarmCurrencyTotal[];
  currencyGuid: string;
  currencyCode: string;
  convertedCurrencies: string[];
}

export class FarmCurrencyConversionError extends Error {
  readonly missingRates: string[];

  constructor(missingRates: string[]) {
    super(
      `Farm totals cannot be calculated because exchange rates are missing: ${missingRates.join(', ')}. Add historical prices for these dates and retry.`,
    );
    this.name = 'FarmCurrencyConversionError';
    this.missingRates = missingRates;
  }
}

/**
 * Sum farm splits into the book's report currency. Split values are expressed
 * in the transaction currency, so foreign-currency rows are converted at the
 * latest available rate on that posting date. Missing rates block the result;
 * mixed currencies are never silently added.
 */
export async function sumFarmSplitsInBookCurrency(
  bookGuid: string,
  accountGuids: string[],
  start: Date,
  end: Date,
): Promise<FarmCurrencySumResult> {
  const book = await prisma.books.findUnique({
    where: { guid: bookGuid },
    select: { root_account_guid: true },
  });
  const root = book
    ? await prisma.accounts.findUnique({
        where: { guid: book.root_account_guid },
        select: {
          commodity: { select: { guid: true, mnemonic: true } },
        },
      })
    : null;
  const base = root?.commodity;
  if (!base) {
    throw new Error('The book root has no report currency.');
  }
  if (accountGuids.length === 0) {
    return {
      totals: [],
      currencyGuid: base.guid,
      currencyCode: base.mnemonic,
      convertedCurrencies: [],
    };
  }

  const rows = await prisma.$queryRaw<DailySplitRow[]>`
    SELECT
      s.account_guid,
      t.currency_guid,
      date_trunc('day', t.post_date) AS post_date,
      SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS total
    FROM splits s
    JOIN transactions t ON t.guid = s.tx_guid
    WHERE s.account_guid = ANY(${accountGuids}::text[])
      AND t.post_date >= ${start}
      AND t.post_date <= ${end}
      AND NOT (s.quantity_num = 0 AND s.value_num <> 0)
    GROUP BY s.account_guid, t.currency_guid, date_trunc('day', t.post_date)
  `;

  const currencyRows = await prisma.commodities.findMany({
    where: { guid: { in: [...new Set(rows.map((row) => row.currency_guid))] } },
    select: { guid: true, mnemonic: true },
  });
  const currencyCodes = new Map(currencyRows.map((row) => [row.guid, row.mnemonic]));
  const totals = new Map<string, number>();
  const rateCache = new Map<string, number | null>();
  const missing = new Set<string>();
  const converted = new Set<string>();

  for (const row of rows) {
    let rate = 1;
    if (row.currency_guid !== base.guid) {
      const day = row.post_date.toISOString().slice(0, 10);
      const cacheKey = `${row.currency_guid}|${day}`;
      let cached = rateCache.get(cacheKey);
      if (cached === undefined) {
        const exchangeRate = await findExchangeRate(
          row.currency_guid,
          base.guid,
          new Date(`${day}T23:59:59.999Z`),
        );
        cached =
          exchangeRate && Number.isFinite(exchangeRate.rate) && exchangeRate.rate > 0
            ? exchangeRate.rate
            : null;
        rateCache.set(cacheKey, cached);
      }
      if (cached === null) {
        missing.add(`${currencyCodes.get(row.currency_guid) ?? row.currency_guid} on ${day}`);
        continue;
      }
      rate = cached;
      converted.add(currencyCodes.get(row.currency_guid) ?? row.currency_guid);
    }
    totals.set(
      row.account_guid,
      (totals.get(row.account_guid) ?? 0) + row.total * rate,
    );
  }

  if (missing.size > 0) {
    throw new FarmCurrencyConversionError([...missing].sort());
  }

  return {
    totals: [...totals].map(([accountGuid, total]) => ({ accountGuid, total })),
    currencyGuid: base.guid,
    currencyCode: base.mnemonic,
    convertedCurrencies: [...converted].sort(),
  };
}
