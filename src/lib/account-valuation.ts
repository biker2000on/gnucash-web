import { getLatestPrice } from '@/lib/commodities';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';

const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];

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

function isInvestmentAccount(account: AccountValuationInput): boolean {
  return (
    INVESTMENT_TYPES.includes(account.accountType) &&
    !!account.commodityGuid &&
    account.commodityNamespace !== 'CURRENCY'
  );
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
  const multiplierCache = new Map<string, number>();

  for (const account of accounts) {
    const commodityGuid = account.commodityGuid;
    if (!commodityGuid || multiplierCache.has(commodityGuid)) continue;

    if (isInvestmentAccount(account)) {
      const price = await getLatestPrice(
        commodityGuid,
        reportCurrencyGuid ?? undefined,
        asOfDate
      );
      multiplierCache.set(commodityGuid, price?.value ?? 0);
      continue;
    }

    if (account.commodityNamespace === 'CURRENCY') {
      if (!reportCurrencyGuid || commodityGuid === reportCurrencyGuid) {
        multiplierCache.set(commodityGuid, 1);
        continue;
      }

      const rate = await findExchangeRate(commodityGuid, reportCurrencyGuid, asOfDate);
      multiplierCache.set(commodityGuid, rate?.rate ?? 1);
      continue;
    }

    multiplierCache.set(commodityGuid, 1);
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
