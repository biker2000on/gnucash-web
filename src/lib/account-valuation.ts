import prisma from '@/lib/prisma';
import { toDecimalNumber as toDecimal } from '@/lib/gnucash';
import { getBaseCurrency, type Currency } from '@/lib/currency';
import {
  describeStalePrice,
  isPriceStale,
  stalenessDaysFor,
  WEEKEND_EVIDENCE_DAYS,
  type StalePriceDisclosure,
} from '@/lib/price-staleness';

export type { StalePriceDisclosure } from '@/lib/price-staleness';

const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];
const TRIANGULATION_MNEMONICS = ['USD', 'EUR'];

export interface AccountValuationInput {
  accountType: string;
  commodityGuid: string | null;
  commodityNamespace?: string | null;
}

export type ValuationGapReason = 'missing-security-price' | 'missing-exchange-rate';

/**
 * One commodity that could not be expressed in the report currency. Balances in
 * that commodity are left OUT of any total rather than being valued at zero on
 * purpose or converted at a fabricated 1:1 rate, so callers can report
 * "$X plus these unvalued holdings" instead of a confidently wrong $X.
 */
export interface ValuationGap {
  commodityGuid: string;
  /** Commodity mnemonic when it is known, otherwise the raw GUID. */
  label: string;
  reason: ValuationGapReason;
  /** User-facing sentence describing what was left out and why. */
  message: string;
}

/**
 * How much of a set of balances a total actually covers. `complete` is true for
 * the ordinary fully-priced book; when it is false the total omits the listed
 * commodities and must never be presented as a whole figure -- nor may any
 * identity derived from it (a balance check, a period-over-period change) be
 * presented as assessable.
 */
export interface ValuationCoverage {
  complete: boolean;
  /** Accounts with a material balance that contributed nothing to the total. */
  unvaluedAccountCount: number;
  /** The commodities behind those accounts, with user-facing explanations. */
  gaps: ValuationGap[];
  /**
   * Commodities that ARE in the total but were priced from a quote older than
   * the bound for their instrument class (`stalenessDaysFor`). Each entry's
   * `message` states the bound it was judged against, since two commodities in
   * one statement can be held to different ones.
   *
   * A distinct list from `gaps` because it makes a distinct statement, and the
   * two must not be read as one: a gap says a balance was left OUT, so the
   * statement's balance check cannot be assessed; a stale price says the
   * balance is IN, at a value that may have moved since it was quoted. Folding
   * staleness into `gaps` would tell a reader their holdings were excluded when
   * they were not, and would flip `complete` — and with it the balance check —
   * over a price age that does not unbalance anything.
   */
  stalePrices: StalePriceDisclosure[];
}

/**
 * Materiality POLICY for coverage reporting: quantities at or below this are
 * treated as an empty account rather than a hidden holding, so closed accounts
 * stay out of the warning list.
 *
 * This is a floating-point comparison against balances accumulated as floats,
 * not an exact-fraction test, and it is chosen rather than derived -- it is not
 * a proof that every commodity denomination sorts correctly against it. An
 * exact-fraction balance assertion is tracked separately.
 */
export const UNVALUED_QUANTITY_EPSILON = 1e-9;

/**
 * Builds the coverage record for a set of valued balances. Only accounts
 * carrying a material quantity count, so a closed account in a dead commodity
 * does not raise a warning about a total it does not affect.
 */
export function collectValuationCoverage(
  valuation: AccountValuationContext,
  balances: Iterable<{ account: AccountValuationInput; quantity: number }>,
): ValuationCoverage {
  let unvaluedAccountCount = 0;
  const unvaluedCommodityGuids = new Set<string>();
  // Same materiality policy as the gaps above: a stale quote for a position the
  // book no longer holds cannot move a total it does not appear in.
  const heldCommodityGuids = new Set<string>();

  for (const { account, quantity } of balances) {
    if (Math.abs(quantity) <= UNVALUED_QUANTITY_EPSILON) continue;
    if (account.commodityGuid) heldCommodityGuids.add(account.commodityGuid);
    if (valuation.isConvertible?.(account) === false) {
      unvaluedAccountCount++;
      if (account.commodityGuid) unvaluedCommodityGuids.add(account.commodityGuid);
    }
  }

  return {
    complete: unvaluedAccountCount === 0,
    unvaluedAccountCount,
    gaps: (valuation.gaps ?? []).filter(gap => unvaluedCommodityGuids.has(gap.commodityGuid)),
    stalePrices: (valuation.stalePrices ?? []).filter(
      stale => heldCommodityGuids.has(stale.commodityGuid),
    ),
  };
}

/** Union of two coverage records, for a figure derived from both. */
export function mergeValuationCoverage(
  a: ValuationCoverage,
  b: ValuationCoverage,
): ValuationCoverage {
  const gaps = [...a.gaps];
  for (const gap of b.gaps) {
    if (!gaps.some(existing => existing.commodityGuid === gap.commodityGuid)) {
      gaps.push(gap);
    }
  }
  const stalePrices = [...(a.stalePrices ?? [])];
  for (const stale of b.stalePrices ?? []) {
    if (!stalePrices.some(existing => existing.commodityGuid === stale.commodityGuid)) {
      stalePrices.push(stale);
    }
  }
  return {
    complete: a.complete && b.complete,
    unvaluedAccountCount: Math.max(a.unvaluedAccountCount, b.unvaluedAccountCount),
    gaps,
    stalePrices,
  };
}

export interface AccountValuationContext {
  reportCurrencyGuid: string | null;
  reportCurrencyMnemonic: string;
  /**
   * Units of report currency per unit of account commodity. Returns 0 when no
   * price or rate path exists; that 0 means "not valued", NOT "worthless", so
   * pair it with isConvertible()/gaps before folding it into a headline total.
   */
  getMultiplier(account: AccountValuationInput): number;
  /**
   * False when getMultiplier() returned 0 only because no price path to the
   * report currency exists -- not because the holding is genuinely worthless.
   * Optional so existing test doubles of this context stay valid.
   */
  isConvertible?(account: AccountValuationInput): boolean;
  /** One entry per commodity that could not be valued in the report currency. */
  gaps?: ValuationGap[];
  /** Human-readable reasons for each unconvertible commodity, one per gap. */
  warnings?: string[];
  /**
   * One entry per commodity that WAS valued, from a quote older than the
   * staleness bound. Optional so existing test doubles of this context stay
   * valid; `collectValuationCoverage` reads it through `?? []`.
   */
  stalePrices?: StalePriceDisclosure[];
}

interface PricePairRow {
  commodity_guid: string;
  currency_guid: string;
  commodity_mnemonic: string;
  currency_mnemonic: string;
  value_num: bigint | number | string;
  value_denom: bigint | number | string;
  /** Quote date of the selected row, for the staleness bound. */
  date: Date | string | null;
  /**
   * Distinct weekend days carrying a quote for this commodity in the sampled
   * window — the observed evidence that its venue does not close. See
   * `isContinuousMarket`.
   */
  weekend_quote_days: bigint | number | null;
}


/**
 * A rate together with the date of the oldest quote it was built from. The date
 * is null only when no quote was involved at all (a commodity converted to
 * itself), which is the one rate that cannot age.
 */
interface DatedRate {
  rate: number;
  date: Date | string | null;
}

/** The older of two quote dates; null only when neither leg has one. */
function olderDate(
  a: Date | string | null,
  b: Date | string | null,
): Date | string | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function isInvestmentAccount(account: AccountValuationInput): boolean {
  return (
    INVESTMENT_TYPES.includes(account.accountType) &&
    !!account.commodityGuid &&
    account.commodityNamespace !== 'CURRENCY'
  );
}

function pairKey(fromGuid: string, toGuid: string): string {
  return `${fromGuid}:${toGuid}`;
}

async function loadLatestPricePairs(
  commodityGuids: string[],
  asOfDate: Date,
  mnemonics?: Map<string, string>,
  weekendQuoteDays?: Map<string, number>,
): Promise<Map<string, DatedRate>> {
  const uniqueGuids = [...new Set(commodityGuids.filter(Boolean))];
  if (uniqueGuids.length === 0) return new Map();

  // One round trip, two facts per pair: the newest quote, and whether this
  // commodity is quoted on days an exchange would be shut. The second is what
  // lets the staleness bound be chosen from what the venue DOES rather than from
  // what someone typed in the namespace column.
  const rows = await prisma.$queryRaw<PricePairRow[]>`
    WITH latest AS (
      SELECT DISTINCT ON (p.commodity_guid, p.currency_guid)
        p.commodity_guid,
        p.currency_guid,
        pc.mnemonic AS commodity_mnemonic,
        cc.mnemonic AS currency_mnemonic,
        p.value_num,
        p.value_denom,
        p.date
      FROM prices p
      JOIN commodities pc ON pc.guid = p.commodity_guid
      JOIN commodities cc ON cc.guid = p.currency_guid
      WHERE p.date <= ${asOfDate}
        AND p.commodity_guid = ANY(${uniqueGuids}::text[])
        AND p.currency_guid = ANY(${uniqueGuids}::text[])
        AND p.value_num > 0
      ORDER BY p.commodity_guid, p.currency_guid, p.date DESC
    ),
    weekend AS (
      SELECT p.commodity_guid, COUNT(DISTINCT p.date::date) AS weekend_quote_days
      FROM prices p
      WHERE p.commodity_guid = ANY(${uniqueGuids}::text[])
        AND p.date <= ${asOfDate}
        AND p.date > ${asOfDate}::timestamp - make_interval(days => ${WEEKEND_EVIDENCE_DAYS})
        AND p.value_num > 0
        -- ISO day-of-week 6/7 = Saturday/Sunday. Read off the stored timestamp
        -- without a zone conversion, which is how the rest of this file treats
        -- the price date.
        AND EXTRACT(ISODOW FROM p.date) >= 6
      GROUP BY p.commodity_guid
    )
    SELECT latest.*, COALESCE(weekend.weekend_quote_days, 0) AS weekend_quote_days
    FROM latest
    LEFT JOIN weekend ON weekend.commodity_guid = latest.commodity_guid
  `;

  if (mnemonics) {
    for (const row of rows) {
      mnemonics.set(row.commodity_guid, row.commodity_mnemonic);
      mnemonics.set(row.currency_guid, row.currency_mnemonic);
    }
  }

  if (weekendQuoteDays) {
    for (const row of rows) {
      // COUNT() arrives as bigint over the wire, and an older cached test
      // double may not send the column at all.
      weekendQuoteDays.set(row.commodity_guid, Number(row.weekend_quote_days ?? 0));
    }
  }

  return new Map(
    rows.map(row => [
      pairKey(row.commodity_guid, row.currency_guid),
      { rate: toDecimal(row.value_num, row.value_denom), date: row.date ?? null },
    ])
  );
}

function getPairRate(
  pricePairs: Map<string, DatedRate>,
  fromGuid: string,
  toGuid: string,
): DatedRate | null {
  if (fromGuid === toGuid) return { rate: 1, date: null };

  const direct = pricePairs.get(pairKey(fromGuid, toGuid));
  if (direct !== undefined) return direct;

  const inverse = pricePairs.get(pairKey(toGuid, fromGuid));
  if (inverse !== undefined) {
    // Inverting a quote does not refresh it: the date rides along.
    return { rate: inverse.rate !== 0 ? 1 / inverse.rate : 0, date: inverse.date };
  }

  return null;
}

/**
 * Direct, inverse, or pivot-triangulated rate from one commodity to another.
 * Used for both currency holdings and securities quoted in a currency other
 * than the report currency.
 */
function getConversionRate(
  pricePairs: Map<string, DatedRate>,
  fromGuid: string,
  toGuid: string,
  pivotGuids: string[]
): DatedRate | null {
  const directOrInverse = getPairRate(pricePairs, fromGuid, toGuid);
  if (directOrInverse !== null) return directOrInverse;

  for (const pivotGuid of pivotGuids) {
    if (pivotGuid === fromGuid || pivotGuid === toGuid) continue;
    const fromToPivot = getPairRate(pricePairs, fromGuid, pivotGuid);
    const pivotToTarget = getPairRate(pricePairs, pivotGuid, toGuid);
    if (fromToPivot !== null && pivotToTarget !== null) {
      return {
        rate: fromToPivot.rate * pivotToTarget.rate,
        // A product is only as current as its older leg.
        date: olderDate(fromToPivot.date, pivotToTarget.date),
      };
    }
  }

  return null;
}

/**
 * Fills in mnemonics for commodities that never appeared in a price row, so a
 * gap can name the symbol the user knows instead of a raw GUID. Only called
 * when at least one gap exists, keeping the fully-priced path query-for-query
 * identical.
 */
async function resolveMissingMnemonics(
  commodityGuids: string[],
  mnemonics: Map<string, string>,
): Promise<void> {
  const missing = commodityGuids.filter(guid => !mnemonics.has(guid));
  if (missing.length === 0) return;

  const rows = await prisma.commodities.findMany({
    where: { guid: { in: missing } },
    select: { guid: true, mnemonic: true },
  });

  for (const row of rows) {
    if (row.mnemonic) mnemonics.set(row.guid, row.mnemonic);
  }
}

/**
 * Builds a per-request valuation context for account hierarchy/report-currency
 * balances. Raw balances stay in account commodity units; this multiplier
 * converts those units into the active book/report currency.
 */
export async function buildAccountValuationContext(
  accounts: AccountValuationInput[],
  asOfDate?: Date,
  reportCurrencyOverride?: Currency | null,
): Promise<AccountValuationContext> {
  const reportCurrency = reportCurrencyOverride === undefined
    ? await getBaseCurrency()
    : reportCurrencyOverride;
  const reportCurrencyGuid = reportCurrency?.guid ?? null;
  const asOf = asOfDate ?? new Date();
  const multiplierCache = new Map<string, number>();
  const commodityGuids = new Set<string>();
  const pivotGuids: string[] = [];

  if (reportCurrencyGuid) {
    commodityGuids.add(reportCurrencyGuid);
  }

  for (const account of accounts) {
    if (account.commodityGuid) {
      commodityGuids.add(account.commodityGuid);
    }
  }

  if (reportCurrencyGuid) {
    const pivots = await prisma.commodities.findMany({
      where: {
        namespace: 'CURRENCY',
        mnemonic: { in: TRIANGULATION_MNEMONICS },
      },
      select: { guid: true },
    });

    for (const pivot of pivots) {
      commodityGuids.add(pivot.guid);
      pivotGuids.push(pivot.guid);
    }
  }

  const mnemonics = new Map<string, string>();
  // Weekend quote days per commodity — the observed half of the continuous-market
  // determination, and the half that survives a namespace nobody anticipated.
  // Comes back on the same query as the prices.
  const weekendQuoteDays = new Map<string, number>();
  const pricePairs = await loadLatestPricePairs(
    [...commodityGuids], asOf, mnemonics, weekendQuoteDays,
  );
  const gapReasons = new Map<string, ValuationGapReason>();
  // Quote date behind each commodity's multiplier, for the staleness bound.
  // Absent when the multiplier rests on no quote (report currency, or an
  // account type valued at face value), which cannot go stale.
  const rateDates = new Map<string, Date | string>();
  // Namespace per commodity, kept only so the staleness bound can be chosen per
  // instrument: a continuously-traded commodity has no weekend to excuse a
  // silent week (see `stalenessDaysFor`). Recorded from the account rows already
  // in hand, so this costs no extra query.
  const namespaces = new Map<string, string | null>();
  const reportMnemonic = reportCurrency?.mnemonic ?? 'the report currency';

  for (const account of accounts) {
    const commodityGuid = account.commodityGuid;
    if (!commodityGuid || multiplierCache.has(commodityGuid)) continue;
    namespaces.set(commodityGuid, account.commodityNamespace ?? null);

    if (!reportCurrencyGuid) {
      multiplierCache.set(commodityGuid, 1);
    } else if (isInvestmentAccount(account)) {
      // Securities quoted in a currency other than the report currency still
      // have a value; triangulate rather than valuing the holding at zero.
      const rate = getConversionRate(pricePairs, commodityGuid, reportCurrencyGuid, pivotGuids);
      if (rate === null) {
        gapReasons.set(commodityGuid, 'missing-security-price');
      } else if (rate.date !== null) {
        rateDates.set(commodityGuid, rate.date);
      }
      multiplierCache.set(commodityGuid, rate?.rate ?? 0);
    } else if (account.commodityNamespace === 'CURRENCY') {
      const rate = getConversionRate(pricePairs, commodityGuid, reportCurrencyGuid, pivotGuids);
      if (rate === null) {
        // Falling back to 1 here would present a made-up parity rate as real.
        // Report the gap and let the caller exclude the balance out loud.
        gapReasons.set(commodityGuid, 'missing-exchange-rate');
      } else if (rate.date !== null) {
        rateDates.set(commodityGuid, rate.date);
      }
      multiplierCache.set(commodityGuid, rate?.rate ?? 0);
    } else {
      multiplierCache.set(commodityGuid, 1);
    }
  }

  // The bound is per instrument, not per book: seven days of silence is the
  // ordinary shape of a market week for a listed security and is a week of
  // undisclosed exposure for something that trades through the weekend. Which
  // one an instrument is gets decided from its own price history first and its
  // namespace second — `commodities.namespace` is free text, so `=== 'CRYPTO'`
  // would answer for only the subset that happens to be spelled that way.
  const boundFor = (guid: string) => stalenessDaysFor({
    namespace: namespaces.get(guid),
    mnemonic: mnemonics.get(guid),
    weekendQuoteDays: weekendQuoteDays.get(guid),
  });

  // A stale quote names the commodity the same way a gap does, so both need the
  // mnemonic backfill. A fully priced, fully current book still triggers
  // neither, keeping that path query-for-query identical.
  const staleGuids = [...rateDates.keys()].filter(
    guid => isPriceStale(rateDates.get(guid), asOf, boundFor(guid)),
  );
  if (gapReasons.size > 0 || staleGuids.length > 0) {
    await resolveMissingMnemonics([...gapReasons.keys(), ...staleGuids], mnemonics);
  }

  const stalePrices: StalePriceDisclosure[] = [];
  for (const guid of staleGuids) {
    const disclosure = describeStalePrice(
      guid,
      mnemonics.get(guid) ?? guid,
      rateDates.get(guid),
      asOf,
      boundFor(guid),
    );
    if (disclosure) stalePrices.push(disclosure);
  }

  const asOfLabel = asOf.toISOString().slice(0, 10);
  const gaps: ValuationGap[] = [...gapReasons].map(([commodityGuid, reason]) => {
    const label = mnemonics.get(commodityGuid) ?? commodityGuid;
    return {
      commodityGuid,
      label,
      reason,
      message: reason === 'missing-security-price'
        ? `${label} excluded: no price path to ${reportMnemonic} as of ${asOfLabel}.`
        : `${label} excluded: no exchange rate to ${reportMnemonic} as of ${asOfLabel}; a 1:1 rate is never assumed.`,
    };
  });
  const warnings = gaps.map(gap => gap.message);

  return {
    reportCurrencyGuid,
    reportCurrencyMnemonic: reportCurrency?.mnemonic ?? 'USD',
    getMultiplier(account: AccountValuationInput) {
      if (!account.commodityGuid) return 1;
      return multiplierCache.get(account.commodityGuid) ?? 1;
    },
    isConvertible(account: AccountValuationInput) {
      if (!account.commodityGuid) return true;
      return !gapReasons.has(account.commodityGuid);
    },
    gaps,
    warnings,
    stalePrices,
  };
}
