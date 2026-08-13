import prisma from '@/lib/prisma';
import { toDecimalNumber as toDecimal } from '@/lib/gnucash';
import { getBaseCurrency, type Currency } from '@/lib/currency';

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
}

/**
 * Materiality policy for coverage reporting: quantities at or below this are
 * treated as an empty account rather than a hidden holding. Summing split
 * fractions leaves float dust well under this bound, so the threshold exists to
 * keep closed accounts out of the warning list -- NOT to hide small holdings.
 * Any real position, including a single unit of the smallest-denominated
 * commodity GnuCash supports, is orders of magnitude larger and is disclosed.
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

  for (const { account, quantity } of balances) {
    if (Math.abs(quantity) <= UNVALUED_QUANTITY_EPSILON) continue;
    if (valuation.isConvertible?.(account) === false) {
      unvaluedAccountCount++;
      if (account.commodityGuid) unvaluedCommodityGuids.add(account.commodityGuid);
    }
  }

  return {
    complete: unvaluedAccountCount === 0,
    unvaluedAccountCount,
    gaps: (valuation.gaps ?? []).filter(gap => unvaluedCommodityGuids.has(gap.commodityGuid)),
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
  return {
    complete: a.complete && b.complete,
    unvaluedAccountCount: Math.max(a.unvaluedAccountCount, b.unvaluedAccountCount),
    gaps,
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
}

interface PricePairRow {
  commodity_guid: string;
  currency_guid: string;
  commodity_mnemonic: string;
  currency_mnemonic: string;
  value_num: bigint | number | string;
  value_denom: bigint | number | string;
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
): Promise<Map<string, number>> {
  const uniqueGuids = [...new Set(commodityGuids.filter(Boolean))];
  if (uniqueGuids.length === 0) return new Map();

  const rows = await prisma.$queryRaw<PricePairRow[]>`
    SELECT DISTINCT ON (p.commodity_guid, p.currency_guid)
      p.commodity_guid,
      p.currency_guid,
      pc.mnemonic AS commodity_mnemonic,
      cc.mnemonic AS currency_mnemonic,
      p.value_num,
      p.value_denom
    FROM prices p
    JOIN commodities pc ON pc.guid = p.commodity_guid
    JOIN commodities cc ON cc.guid = p.currency_guid
    WHERE p.date <= ${asOfDate}
      AND p.commodity_guid = ANY(${uniqueGuids}::text[])
      AND p.currency_guid = ANY(${uniqueGuids}::text[])
      AND p.value_num > 0
    ORDER BY p.commodity_guid, p.currency_guid, p.date DESC
  `;

  if (mnemonics) {
    for (const row of rows) {
      mnemonics.set(row.commodity_guid, row.commodity_mnemonic);
      mnemonics.set(row.currency_guid, row.currency_mnemonic);
    }
  }

  return new Map(
    rows.map(row => [
      pairKey(row.commodity_guid, row.currency_guid),
      toDecimal(row.value_num, row.value_denom),
    ])
  );
}

function getPairRate(pricePairs: Map<string, number>, fromGuid: string, toGuid: string): number | null {
  if (fromGuid === toGuid) return 1;

  const direct = pricePairs.get(pairKey(fromGuid, toGuid));
  if (direct !== undefined) return direct;

  const inverse = pricePairs.get(pairKey(toGuid, fromGuid));
  if (inverse !== undefined) return inverse !== 0 ? 1 / inverse : 0;

  return null;
}

/**
 * Direct, inverse, or pivot-triangulated rate from one commodity to another.
 * Used for both currency holdings and securities quoted in a currency other
 * than the report currency.
 */
function getConversionRate(
  pricePairs: Map<string, number>,
  fromGuid: string,
  toGuid: string,
  pivotGuids: string[]
): number | null {
  const directOrInverse = getPairRate(pricePairs, fromGuid, toGuid);
  if (directOrInverse !== null) return directOrInverse;

  for (const pivotGuid of pivotGuids) {
    if (pivotGuid === fromGuid || pivotGuid === toGuid) continue;
    const fromToPivot = getPairRate(pricePairs, fromGuid, pivotGuid);
    const pivotToTarget = getPairRate(pricePairs, pivotGuid, toGuid);
    if (fromToPivot !== null && pivotToTarget !== null) {
      return fromToPivot * pivotToTarget;
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
  const pricePairs = await loadLatestPricePairs([...commodityGuids], asOf, mnemonics);
  const gapReasons = new Map<string, ValuationGapReason>();
  const reportMnemonic = reportCurrency?.mnemonic ?? 'the report currency';

  for (const account of accounts) {
    const commodityGuid = account.commodityGuid;
    if (!commodityGuid || multiplierCache.has(commodityGuid)) continue;

    if (!reportCurrencyGuid) {
      multiplierCache.set(commodityGuid, 1);
    } else if (isInvestmentAccount(account)) {
      // Securities quoted in a currency other than the report currency still
      // have a value; triangulate rather than valuing the holding at zero.
      const rate = getConversionRate(pricePairs, commodityGuid, reportCurrencyGuid, pivotGuids);
      if (rate === null) {
        gapReasons.set(commodityGuid, 'missing-security-price');
      }
      multiplierCache.set(commodityGuid, rate ?? 0);
    } else if (account.commodityNamespace === 'CURRENCY') {
      const rate = getConversionRate(pricePairs, commodityGuid, reportCurrencyGuid, pivotGuids);
      if (rate === null) {
        // Falling back to 1 here would present a made-up parity rate as real.
        // Report the gap and let the caller exclude the balance out loud.
        gapReasons.set(commodityGuid, 'missing-exchange-rate');
      }
      multiplierCache.set(commodityGuid, rate ?? 0);
    } else {
      multiplierCache.set(commodityGuid, 1);
    }
  }

  if (gapReasons.size > 0) {
    await resolveMissingMnemonics([...gapReasons.keys()], mnemonics);
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
  };
}
