import prisma from '@/lib/prisma';
import { toDecimal as toDecimalString } from '@/lib/gnucash';
import { getBaseCurrency } from '@/lib/currency';

const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];
const TRIANGULATION_MNEMONICS = ['USD', 'EUR'];

export interface AccountValuationInput {
  accountType: string;
  commodityGuid: string | null;
  commodityNamespace?: string | null;
}

export interface AccountValuationContext {
  reportCurrencyGuid: string | null;
  reportCurrencyMnemonic: string;
  getMultiplier(account: AccountValuationInput): number;
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

function toDecimal(num: bigint | number | string, denom: bigint | number | string): number {
  return parseFloat(toDecimalString(num, denom));
}

function pairKey(fromGuid: string, toGuid: string): string {
  return `${fromGuid}:${toGuid}`;
}

async function loadLatestPricePairs(commodityGuids: string[], asOfDate: Date): Promise<Map<string, number>> {
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
    ORDER BY p.commodity_guid, p.currency_guid, p.date DESC
  `;

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

function getCurrencyRate(
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
 * Builds a per-request valuation context for account hierarchy/report-currency
 * balances. Raw balances stay in account commodity units; this multiplier
 * converts those units into the active book/report currency.
 */
export async function buildAccountValuationContext(
  accounts: AccountValuationInput[],
  asOfDate?: Date
): Promise<AccountValuationContext> {
  const reportCurrency = await getBaseCurrency();
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

  const pricePairs = await loadLatestPricePairs([...commodityGuids], asOf);

  for (const account of accounts) {
    const commodityGuid = account.commodityGuid;
    if (!commodityGuid || multiplierCache.has(commodityGuid)) continue;

    if (!reportCurrencyGuid) {
      multiplierCache.set(commodityGuid, 1);
    } else if (isInvestmentAccount(account)) {
      multiplierCache.set(
        commodityGuid,
        pricePairs.get(pairKey(commodityGuid, reportCurrencyGuid)) ?? 0
      );
    } else if (account.commodityNamespace === 'CURRENCY') {
      multiplierCache.set(
        commodityGuid,
        getCurrencyRate(pricePairs, commodityGuid, reportCurrencyGuid, pivotGuids) ?? 1
      );
    } else {
      multiplierCache.set(commodityGuid, 1);
    }
  }

  return {
    reportCurrencyGuid,
    reportCurrencyMnemonic: reportCurrency?.mnemonic ?? 'USD',
    getMultiplier(account: AccountValuationInput) {
      if (!account.commodityGuid) return 1;
      return multiplierCache.get(account.commodityGuid) ?? 1;
    },
  };
}
