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
import {
  buildAccountValuationContext,
  collectValuationCoverage,
  mergeValuationCoverage,
  type AccountValuationContext,
  type ValuationCoverage,
} from '@/lib/account-valuation';

export type { ValuationCoverage };

const ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'RECEIVABLE'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'];
const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];

/**
 * Coverage of a period-over-period change, which depends on BOTH endpoints.
 * A gap at only one endpoint is worse than a partial total: the holding enters
 * or leaves the valued set, so the change contains a swing that never happened.
 */
export interface NetWorthChangeCoverage extends ValuationCoverage {
  /**
   * False when the endpoints exclude different commodities. The change and
   * change-percent are then artifacts and must not be shown as gain or loss.
   */
  comparable: boolean;
}

export interface NetWorthResult {
  assets: number;
  liabilities: number;
  investmentValue: number;
  netWorth: number;
  coverage: ValuationCoverage;
}

export interface NetWorthSummary {
  start: NetWorthResult;
  end: NetWorthResult;
  change: number;
  changePercent: number;
  /** Coverage of change/changePercent, folding in BOTH endpoints. */
  changeCoverage: NetWorthChangeCoverage;
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
  /**
   * Coverage of netWorth/investmentValue as of the end date. Surfaces alongside
   * the numbers so an unpriceable holding reads as "excluded" rather than
   * silently shrinking the headline figure.
   */
  coverage: ValuationCoverage;
  /** Coverage of netWorthChange/netWorthChangePercent, across both endpoints. */
  changeCoverage: NetWorthChangeCoverage;
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
    endDate: Date,
    baseCurrencyOverride?: Currency | null,
  ): Promise<FinancialSummary> {
    const baseCurrency = baseCurrencyOverride === undefined
      ? await getBaseCurrency()
      : baseCurrencyOverride;

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
      coverage: netWorthSummary.end.coverage,
      changeCoverage: netWorthSummary.changeCoverage,
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
    // Use the same report-currency valuation engine as the balance sheet and
    // account reports. This keeps FX, inverse-rate, triangulation, and
    // security-price behavior consistent across every net-worth surface.
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

    const accountByGuid = new Map(accounts.map(account => [account.guid, account]));
    const valuationInputs = accounts.map(account => ({
      accountType: account.account_type,
      commodityGuid: account.commodity_guid,
      commodityNamespace: account.commodity?.namespace,
    }));
    const [splits, startValuation, endValuation] = await Promise.all([
      prisma.splits.findMany({
        where: {
          account_guid: { in: accounts.map(account => account.guid) },
          transaction: { post_date: { lte: endDate } },
        },
        select: {
          account_guid: true,
          quantity_num: true,
          quantity_denom: true,
          transaction: { select: { post_date: true } },
        },
      }),
      buildAccountValuationContext(valuationInputs, startDate, baseCurrency),
      buildAccountValuationContext(valuationInputs, endDate, baseCurrency),
    ]);

    function computeNetWorthAtDate(
      asOf: Date,
      valuation: AccountValuationContext,
    ): NetWorthResult {
      let assetTotal = 0;
      let liabilityTotal = 0;
      let investmentValue = 0;
      const valuedBalances: Array<{ account: typeof valuationInputs[number]; quantity: number }> = [];
      const quantityByAccount = new Map<string, number>();

      for (const split of splits) {
        const postDate = split.transaction.post_date;
        if (!postDate || postDate > asOf) continue;
        const quantity = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
        quantityByAccount.set(
          split.account_guid,
          (quantityByAccount.get(split.account_guid) ?? 0) + quantity,
        );
      }

      for (const [accountGuid, quantity] of quantityByAccount) {
        const account = accountByGuid.get(accountGuid);
        if (!account) continue;
        const valuationInput = {
          accountType: account.account_type,
          commodityGuid: account.commodity_guid,
          commodityNamespace: account.commodity?.namespace,
        };
        // A balance we cannot price contributes 0 -- track it so the caller can
        // say the total is partial instead of showing a quietly shrunken figure.
        valuedBalances.push({ account: valuationInput, quantity });
        const value = quantity * valuation.getMultiplier(valuationInput);
        if (ASSET_TYPES.includes(account.account_type)) {
          assetTotal += value;
        } else if (LIABILITY_TYPES.includes(account.account_type)) {
          liabilityTotal += value;
        } else if (INVESTMENT_TYPES.includes(account.account_type)) {
          investmentValue += value;
        }
      }

      return {
        assets: assetTotal,
        liabilities: liabilityTotal,
        investmentValue,
        netWorth: assetTotal + investmentValue + liabilityTotal,
        coverage: collectValuationCoverage(valuation, valuedBalances),
      };
    }

    const endNW = computeNetWorthAtDate(endDate, endValuation);
    const startNW = computeNetWorthAtDate(startDate, startValuation);
    const change = endNW.netWorth - startNW.netWorth;
    const changePercent = startNW.netWorth !== 0
      ? (change / Math.abs(startNW.netWorth)) * 100
      : 0;

    // The change spans both endpoints, so it inherits both sets of gaps. When
    // the endpoints exclude DIFFERENT commodities the holding enters or leaves
    // the valued set between them, and the resulting swing is an artifact of
    // the missing data rather than a gain or loss.
    const startGapKeys = startNW.coverage.gaps.map(gap => gap.commodityGuid).sort();
    const endGapKeys = endNW.coverage.gaps.map(gap => gap.commodityGuid).sort();
    const changeCoverage: NetWorthChangeCoverage = {
      ...mergeValuationCoverage(startNW.coverage, endNW.coverage),
      comparable:
        startGapKeys.length === endGapKeys.length &&
        startGapKeys.every((guid, index) => guid === endGapKeys[index]),
    };

    return {
      start: startNW,
      end: endNW,
      change,
      changePercent,
      changeCoverage,
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
