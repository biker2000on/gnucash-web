/**
 * Financial Summary Service
 *
 * Reusable service for computing core financial metrics:
 * - Net worth (assets - liabilities + investments at market price)
 * - Income and expenses with multi-currency conversion
 * - Savings rate
 * - Top expense category
 *
 * Extracted from the KPI API route to enable reuse by FIRE calculator
 * and other financial planning tools.
 */

import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';
import type { Currency } from '@/lib/currency';

const ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'RECEIVABLE'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'];
const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];

export interface NetWorthResult {
  assets: number;
  liabilities: number;
  investmentValue: number;
  netWorth: number;
}

export interface NetWorthSummary {
  start: NetWorthResult;
  end: NetWorthResult;
  change: number;
  changePercent: number;
}

export interface IncomeExpenseSummary {
  totalIncome: number;
  totalExpenses: number;
  expenseByAccount: Map<string, number>;
}

export interface TopExpenseCategory {
  name: string;
  amount: number;
}

export interface FinancialSummary {
  netWorth: number;
  netWorthChange: number;
  netWorthChangePercent: number;
  totalIncome: number;
  totalExpenses: number;
  savingsRate: number;
  topExpenseCategory: string;
  topExpenseAmount: number;
  investmentValue: number;
}

/**
 * Service class for financial summary computations.
 * All methods are static and query the database directly.
 */
export class FinancialSummaryService {
  /**
   * Compute the full financial summary for a date range.
   * This is the primary entry point used by the KPI route.
   */
  static async computeFullSummary(
    bookAccountGuids: string[],
    startDate: Date,
    endDate: Date
  ): Promise<FinancialSummary> {
    const baseCurrency = await getBaseCurrency();

    const netWorthSummary = await this.computeNetWorthSummary(
      bookAccountGuids,
      startDate,
      endDate,
      baseCurrency
    );

    const incomeExpense = await this.computeIncomeExpenses(
      bookAccountGuids,
      startDate,
      endDate,
      baseCurrency
    );

    const savingsRate = this.computeSavingsRate(
      incomeExpense.totalIncome,
      incomeExpense.totalExpenses
    );

    const topCategory = await this.computeTopExpenseCategory(
      bookAccountGuids,
      incomeExpense.expenseByAccount
    );

    return {
      netWorth: round2(netWorthSummary.end.netWorth),
      netWorthChange: round2(netWorthSummary.change),
      netWorthChangePercent: round2(netWorthSummary.changePercent),
      totalIncome: round2(incomeExpense.totalIncome),
      totalExpenses: round2(incomeExpense.totalExpenses),
      savingsRate: round2(savingsRate),
      topExpenseCategory: topCategory.name,
      topExpenseAmount: round2(topCategory.amount),
      investmentValue: round2(netWorthSummary.end.investmentValue),
    };
  }

  /**
   * Compute net worth at start and end dates, including change metrics.
   */
  static async computeNetWorthSummary(
    bookAccountGuids: string[],
    startDate: Date,
    endDate: Date,
    baseCurrency: Currency | null
  ): Promise<NetWorthSummary> {
    // Fetch all non-hidden accounts of relevant types in active book
    const accounts = await prisma.accounts.findMany({
      where: {
        guid: { in: bookAccountGuids },
        hidden: 0,
        account_type: {
          in: [...ASSET_TYPES, ...LIABILITY_TYPES, ...INVESTMENT_TYPES],
        },
      },
      select: {
        guid: true,
        account_type: true,
        commodity_guid: true,
        commodity: {
          select: {
            namespace: true,
          },
        },
      },
    });

    const assetAccountGuids = accounts
      .filter(a => ASSET_TYPES.includes(a.account_type))
      .map(a => a.guid);

    const liabilityAccountGuids = accounts
      .filter(a => LIABILITY_TYPES.includes(a.account_type))
      .map(a => a.guid);

    const investmentAccounts = accounts.filter(
      a => INVESTMENT_TYPES.includes(a.account_type) && a.commodity?.namespace !== 'CURRENCY'
    );
    const investmentAccountGuids = investmentAccounts.map(a => a.guid);

    // Fetch splits for asset + liability accounts (up to endDate for net worth)
    const cashSplits = await prisma.splits.findMany({
      where: {
        account_guid: {
          in: [...assetAccountGuids, ...liabilityAccountGuids],
        },
        transaction: {
          post_date: { lte: endDate },
        },
      },
      select: {
        account_guid: true,
        quantity_num: true,
        quantity_denom: true,
        transaction: {
          select: {
            post_date: true,
          },
        },
      },
    });

    // Fetch investment splits (up to endDate for net worth)
    const investmentSplits = await prisma.splits.findMany({
      where: {
        account_guid: {
          in: investmentAccountGuids,
        },
        transaction: {
          post_date: { lte: endDate },
        },
      },
      select: {
        account_guid: true,
        quantity_num: true,
        quantity_denom: true,
        transaction: {
          select: {
            post_date: true,
          },
        },
      },
    });

    // Fetch all prices for investment commodities
    const investmentCommodityGuids = [
      ...new Set(
        investmentAccounts
          .map(a => a.commodity_guid)
          .filter((g): g is string => g !== null)
      ),
    ];

    const allPrices = await prisma.prices.findMany({
      where: {
        commodity_guid: {
          in: investmentCommodityGuids,
        },
      },
      select: {
        commodity_guid: true,
        date: true,
        value_num: true,
        value_denom: true,
      },
      orderBy: {
        date: 'desc',
      },
    });

    // Build price lookup
    const priceMap = new Map<string, Array<{ date: Date; value: number }>>();
    for (const p of allPrices) {
      const arr = priceMap.get(p.commodity_guid) || [];
      arr.push({
        date: p.date,
        value: parseFloat(toDecimal(p.value_num, p.value_denom)),
      });
      priceMap.set(p.commodity_guid, arr);
    }

    const accountCommodityMap = new Map<string, string>();
    for (const a of investmentAccounts) {
      if (a.commodity_guid) {
        accountCommodityMap.set(a.guid, a.commodity_guid);
      }
    }

    const assetSet = new Set(assetAccountGuids);
    const liabilitySet = new Set(liabilityAccountGuids);

    // Build account -> currency guid map for cash/liability accounts
    const accountCurrencyMap = new Map<string, string>();
    for (const a of accounts) {
      if (a.commodity_guid && !INVESTMENT_TYPES.includes(a.account_type)) {
        accountCurrencyMap.set(a.guid, a.commodity_guid);
      }
    }

    // Identify non-base currency GUIDs from cash/liability accounts
    const nonBaseCurrencyGuids = [
      ...new Set(
        [...assetAccountGuids, ...liabilityAccountGuids]
          .map(guid => accountCurrencyMap.get(guid))
          .filter((g): g is string => g !== undefined && g !== baseCurrency?.guid)
      ),
    ];

    // Fetch exchange rates at startDate and endDate for each non-base currency
    const startRates = new Map<string, number>();
    const endRates = new Map<string, number>();

    for (const currGuid of nonBaseCurrencyGuids) {
      if (!baseCurrency) continue;
      const startRate = await findExchangeRate(currGuid, baseCurrency.guid, startDate);
      const endRate = await findExchangeRate(currGuid, baseCurrency.guid, endDate);
      startRates.set(currGuid, startRate ? startRate.rate : 1);
      endRates.set(currGuid, endRate ? endRate.rate : 1);
    }

    function getLatestPriceAsOf(commodityGuid: string, asOf: Date): number {
      const prices = priceMap.get(commodityGuid);
      if (!prices || prices.length === 0) return 0;
      for (const p of prices) {
        if (p.date <= asOf) return p.value;
      }
      return 0;
    }

    function computeNetWorthAtDate(
      asOf: Date,
      ratesForDate: Map<string, number>
    ): NetWorthResult {
      let assetTotal = 0;
      let liabilityTotal = 0;

      for (const split of cashSplits) {
        const postDate = split.transaction.post_date;
        if (!postDate || postDate > asOf) continue;
        const rawValue = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
        const accountCurrGuid = accountCurrencyMap.get(split.account_guid);
        const rate = (accountCurrGuid && baseCurrency && accountCurrGuid !== baseCurrency.guid)
          ? (ratesForDate.get(accountCurrGuid) || 1)
          : 1;
        const value = rawValue * rate;
        if (assetSet.has(split.account_guid)) {
          assetTotal += value;
        } else if (liabilitySet.has(split.account_guid)) {
          liabilityTotal += value;
        }
      }

      const sharesByAccount = new Map<string, number>();
      for (const split of investmentSplits) {
        const postDate = split.transaction.post_date;
        if (!postDate || postDate > asOf) continue;
        const qty = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
        sharesByAccount.set(
          split.account_guid,
          (sharesByAccount.get(split.account_guid) || 0) + qty
        );
      }

      let investmentValue = 0;
      for (const [accountGuid, shares] of sharesByAccount) {
        const commodityGuid = accountCommodityMap.get(accountGuid);
        if (!commodityGuid) continue;
        const price = getLatestPriceAsOf(commodityGuid, asOf);
        investmentValue += shares * price;
      }

      return {
        assets: assetTotal,
        liabilities: liabilityTotal,
        investmentValue,
        netWorth: assetTotal + investmentValue + liabilityTotal,
      };
    }

    const endNW = computeNetWorthAtDate(endDate, endRates);
    const startNW = computeNetWorthAtDate(startDate, startRates);
    const change = endNW.netWorth - startNW.netWorth;
    const changePercent = startNW.netWorth !== 0
      ? (change / Math.abs(startNW.netWorth)) * 100
      : 0;

    return {
      start: startNW,
      end: endNW,
      change,
      changePercent,
    };
  }

  /**
   * Compute total income and expenses for a date range with multi-currency conversion.
   * GnuCash stores income as negative values; this method negates them.
   */
  static async computeIncomeExpenses(
    bookAccountGuids: string[],
    startDate: Date,
    endDate: Date,
    baseCurrency: Currency | null
  ): Promise<IncomeExpenseSummary> {
    // Fetch all accounts in active book
    const allAccounts = await prisma.accounts.findMany({
      where: {
        guid: { in: bookAccountGuids },
      },
      select: {
        guid: true,
        name: true,
        account_type: true,
        parent_guid: true,
        hidden: true,
        commodity_guid: true,
      },
    });

    const incomeAccounts = allAccounts.filter(
      a => a.account_type === 'INCOME' && a.hidden === 0
    );
    const expenseAccounts = allAccounts.filter(
      a => a.account_type === 'EXPENSE' && a.hidden === 0
    );

    const incomeGuids = new Set(incomeAccounts.map(a => a.guid));
    const expenseGuids = new Set(expenseAccounts.map(a => a.guid));

    // Build currency map for income/expense accounts
    const ieAccountCurrencyMap = new Map<string, string>();
    for (const acc of [...incomeAccounts, ...expenseAccounts]) {
      if (acc.commodity_guid) {
        ieAccountCurrencyMap.set(acc.guid, acc.commodity_guid);
      }
    }

    // Pre-fetch exchange rates for non-base I/E currencies
    const ieNonBaseCurrencyGuids = new Set<string>();
    for (const currGuid of ieAccountCurrencyMap.values()) {
      if (baseCurrency && currGuid !== baseCurrency.guid) {
        ieNonBaseCurrencyGuids.add(currGuid);
      }
    }

    const exchangeRates = new Map<string, number>();
    for (const currGuid of ieNonBaseCurrencyGuids) {
      const rate = await findExchangeRate(currGuid, baseCurrency!.guid, endDate);
      if (rate) {
        exchangeRates.set(currGuid, rate.rate);
      }
    }

    // Fetch income/expense splits within date range
    const iesplits = await prisma.splits.findMany({
      where: {
        account_guid: {
          in: [...incomeGuids, ...expenseGuids],
        },
        transaction: {
          post_date: {
            gte: startDate,
            lte: endDate,
          },
        },
      },
      select: {
        account_guid: true,
        quantity_num: true,
        quantity_denom: true,
      },
    });

    let totalIncome = 0;
    let totalExpenses = 0;
    const expenseByAccount = new Map<string, number>();

    for (const split of iesplits) {
      const rawValue = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
      const accountCurrGuid = ieAccountCurrencyMap.get(split.account_guid);
      const rate = (accountCurrGuid && accountCurrGuid !== baseCurrency?.guid)
        ? (exchangeRates.get(accountCurrGuid) || 1) : 1;
      const value = rawValue * rate;

      if (incomeGuids.has(split.account_guid)) {
        totalIncome += -value; // negate: income is negative in GnuCash
      } else if (expenseGuids.has(split.account_guid)) {
        totalExpenses += value;
        expenseByAccount.set(
          split.account_guid,
          (expenseByAccount.get(split.account_guid) || 0) + value
        );
      }
    }

    return { totalIncome, totalExpenses, expenseByAccount };
  }

  /**
   * Compute savings rate as a percentage.
   * Returns 0 if income is zero or negative.
   */
  static computeSavingsRate(totalIncome: number, totalExpenses: number): number {
    if (totalIncome <= 0) return 0;
    return ((totalIncome - totalExpenses) / totalIncome) * 100;
  }

  /**
   * Find the top expense category by grouping expenses under
   * their top-level parent in the expense hierarchy.
   */
  static async computeTopExpenseCategory(
    bookAccountGuids: string[],
    expenseByAccount: Map<string, number>
  ): Promise<TopExpenseCategory> {
    if (expenseByAccount.size === 0) {
      return { name: '', amount: 0 };
    }

    const allAccounts = await prisma.accounts.findMany({
      where: {
        guid: { in: bookAccountGuids },
      },
      select: {
        guid: true,
        name: true,
        account_type: true,
        parent_guid: true,
      },
    });

    const accountNameMap = new Map(
      allAccounts.map(a => [a.guid, { name: a.name, parent_guid: a.parent_guid }])
    );

    const rootAccount = allAccounts.find(
      a => a.account_type === 'ROOT' && !a.name.toLowerCase().includes('template')
    );
    const expenseRoot = rootAccount
      ? allAccounts.find(
        a => a.account_type === 'EXPENSE' && a.parent_guid === rootAccount.guid
      )
      : null;

    function getTopLevelCategory(accountGuid: string): string | null {
      if (!expenseRoot) return null;
      let currentGuid: string | null = accountGuid;
      let lastBeforeRoot = accountGuid;

      while (currentGuid) {
        const acc = accountNameMap.get(currentGuid);
        if (!acc) break;
        if (acc.parent_guid === expenseRoot.guid) {
          return acc.name;
        }
        if (currentGuid === expenseRoot.guid) {
          const directAcc = accountNameMap.get(lastBeforeRoot);
          return directAcc?.name || null;
        }
        lastBeforeRoot = currentGuid;
        currentGuid = acc.parent_guid;
      }
      return null;
    }

    const categoryTotals = new Map<string, number>();
    for (const [accountGuid, amount] of expenseByAccount) {
      const category = getTopLevelCategory(accountGuid) || 'Other';
      categoryTotals.set(category, (categoryTotals.get(category) || 0) + amount);
    }

    let topName = '';
    let topAmount = 0;
    for (const [category, amount] of categoryTotals) {
      if (amount > topAmount) {
        topAmount = amount;
        topName = category;
      }
    }

    return { name: topName, amount: topAmount };
  }
}

/** Round to 2 decimal places */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
