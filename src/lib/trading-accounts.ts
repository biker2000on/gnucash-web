/**
 * Trading Account Utilities for Multi-Currency Transactions
 *
 * When a transaction involves multiple currencies, GnuCash requires "trading accounts"
 * to maintain the accounting equation where both values AND quantities balance.
 *
 * Example: Transferring USD to EUR account:
 * - USD account: -100.00 USD (value=-100, quantity=-100)
 * - EUR account: +85.00 EUR (value=+100, quantity=+85)
 * - Trading:CURRENCY:USD: (value=0, quantity=+100) - receives USD
 * - Trading:CURRENCY:EUR: (value=0, quantity=-85) - provides EUR
 */

import prisma, { generateGuid } from '@/lib/prisma';

export interface SplitWithCommodity {
  accountGuid: string;
  commodityGuid: string;
  commodityMnemonic: string;
  commodityNamespace: string; // e.g. 'CURRENCY' for fiat, 'NYSE'/'NASDAQ' for stocks
  commodityFraction: number;  // e.g. 100 for USD, 10000 for stocks — used for quantity precision
  value: number;      // in transaction currency
  quantity: number;   // in account's native commodity
}

/**
 * Check if transaction needs trading accounts.
 * Trading accounts are needed when splits involve different commodities.
 */
export function needsTradingAccounts(splits: SplitWithCommodity[]): boolean {
  const commodities = new Set(splits.map(s => s.commodityGuid));
  return commodities.size > 1;
}

export interface CommodityImbalance {
  mnemonic: string;
  namespace: string;
  fraction: number;
  /** Sum of split quantities (in commodity's native units) for this commodity. */
  quantityImbalance: number;
  /** Sum of split values (in transaction currency) for splits whose account is in this commodity. */
  valueImbalance: number;
}

/**
 * Calculate quantity AND value imbalances by commodity.
 *
 * The trading split for a commodity needs to negate BOTH the quantity (to
 * balance commodity totals) AND the value (so the trading account shows the
 * trade in the BUY/SELL columns of the ledger, matching desktop GnuCash).
 *
 * Returns a map of commodityGuid -> CommodityImbalance for non-zero imbalances.
 */
export function calculateImbalances(
  splits: SplitWithCommodity[]
): Map<string, CommodityImbalance> {
  const imbalances = new Map<string, CommodityImbalance>();

  for (const split of splits) {
    const existing = imbalances.get(split.commodityGuid) || {
      mnemonic: split.commodityMnemonic,
      namespace: split.commodityNamespace,
      fraction: split.commodityFraction,
      quantityImbalance: 0,
      valueImbalance: 0,
    };
    existing.quantityImbalance += split.quantity;
    existing.valueImbalance += split.value;
    imbalances.set(split.commodityGuid, existing);
  }

  // Filter to only non-zero quantity imbalances (use small epsilon for floating point).
  // Value imbalance can legitimately be zero on a multi-currency split that already balances.
  for (const [guid, data] of imbalances) {
    if (Math.abs(data.quantityImbalance) < 0.0001) {
      imbalances.delete(guid);
    }
  }

  return imbalances;
}

/**
 * @deprecated kept for backwards compatibility — use calculateImbalances instead.
 */
export function calculateQuantityImbalances(
  splits: SplitWithCommodity[]
): Map<string, { mnemonic: string; namespace: string; imbalance: number }> {
  const full = calculateImbalances(splits);
  const out = new Map<string, { mnemonic: string; namespace: string; imbalance: number }>();
  for (const [guid, data] of full) {
    out.set(guid, {
      mnemonic: data.mnemonic,
      namespace: data.namespace,
      imbalance: data.quantityImbalance,
    });
  }
  return out;
}

/**
 * Get or create Trading:{NAMESPACE}:{MNEMONIC} account hierarchy.
 * Creates the full hierarchy if any part is missing.
 *
 * The middle level matches the commodity's namespace from the commodities table:
 *   - 'CURRENCY' for fiat (USD, EUR, etc.)  → Trading:CURRENCY:USD
 *   - 'NYSE'/'NASDAQ'/etc. for stocks        → Trading:NYSE:VTI
 *
 * Matches GnuCash desktop's behavior. Previously this hardcoded 'CURRENCY'
 * for every commodity, which corrupted security trading splits.
 */
export async function getOrCreateTradingAccount(
  commodityGuid: string,
  commodityMnemonic: string,
  commodityNamespace: string,
  tx?: Parameters<typeof prisma.$transaction>[0] extends (prisma: infer P) => unknown ? P : never
): Promise<string> {
  // Use provided transaction context or default prisma
  const db = tx || prisma;

  // 1. Find root Trading account or create it
  let tradingRoot = await db.accounts.findFirst({
    where: { name: 'Trading', account_type: 'TRADING' },
  });

  if (!tradingRoot) {
    // Find the root account (account_type ROOT)
    const rootAccount = await db.accounts.findFirst({
      where: { account_type: 'ROOT' },
    });

    if (!rootAccount) {
      throw new Error('No root account found in database');
    }

    // Get template commodity (use USD or first currency available)
    const templateCommodity = await db.commodities.findFirst({
      where: { namespace: 'CURRENCY', mnemonic: 'USD' },
    });

    const fallbackCommodity = templateCommodity || await db.commodities.findFirst({
      where: { namespace: 'CURRENCY' },
    });

    tradingRoot = await db.accounts.create({
      data: {
        guid: generateGuid(),
        name: 'Trading',
        account_type: 'TRADING',
        commodity_guid: fallbackCommodity?.guid || commodityGuid,
        commodity_scu: 100,
        non_std_scu: 0,
        parent_guid: rootAccount.guid,
        hidden: 0,
        placeholder: 1,
      },
    });
  }

  // 2. Find or create namespace group under Trading (CURRENCY, NYSE, NASDAQ, etc.)
  let namespaceGroup = await db.accounts.findFirst({
    where: { name: commodityNamespace, parent_guid: tradingRoot.guid },
  });

  if (!namespaceGroup) {
    namespaceGroup = await db.accounts.create({
      data: {
        guid: generateGuid(),
        name: commodityNamespace,
        account_type: 'TRADING',
        commodity_guid: tradingRoot.commodity_guid,
        commodity_scu: 100,
        non_std_scu: 0,
        parent_guid: tradingRoot.guid,
        hidden: 0,
        placeholder: 1,
      },
    });
  }

  // 3. Find or create specific commodity account (e.g., Trading:NYSE:VTI or Trading:CURRENCY:EUR)
  let commodityAccount = await db.accounts.findFirst({
    where: { name: commodityMnemonic, parent_guid: namespaceGroup.guid },
  });

  if (!commodityAccount) {
    commodityAccount = await db.accounts.create({
      data: {
        guid: generateGuid(),
        name: commodityMnemonic,
        account_type: 'TRADING',
        commodity_guid: commodityGuid,
        commodity_scu: 100,
        non_std_scu: 0,
        parent_guid: namespaceGroup.guid,
        hidden: 0,
        placeholder: 0,
      },
    });
  }

  return commodityAccount.guid;
}

/**
 * Generate trading splits to balance the transaction by commodity quantity AND value.
 *
 * For each imbalanced commodity, the trading split has:
 *   - value    = -(sum of values of original splits in that commodity)
 *   - quantity = -(sum of quantities of original splits in that commodity)
 *
 * This matches GnuCash desktop's behavior: trading splits show in the BUY/SELL
 * columns of the ledger (because they have non-zero values), and balance the
 * commodity totals (because they negate the imbalanced quantity).
 *
 * Quantity precision uses the commodity's `fraction` from the commodities table
 * (100 for USD, 10000 for typical stocks) so we don't truncate share quantities.
 *
 * Value precision uses denom=100 (matches the transaction currency, typically USD).
 */
export function generateTradingSplits(
  imbalances: Map<string, CommodityImbalance>,
  tradingAccountGuids: Map<string, string>, // commodityGuid -> tradingAccountGuid
): Array<{
  accountGuid: string;
  valueNum: number;
  valueDenom: number;
  quantityNum: number;
  quantityDenom: number;
}> {
  const tradingSplits: Array<{
    accountGuid: string;
    valueNum: number;
    valueDenom: number;
    quantityNum: number;
    quantityDenom: number;
  }> = [];

  const VALUE_DENOM = 100; // Transaction currency precision (USD)

  for (const [commodityGuid, { quantityImbalance, valueImbalance, fraction }] of imbalances) {
    const tradingAccountGuid = tradingAccountGuids.get(commodityGuid);
    if (!tradingAccountGuid) continue;

    const quantityDenom = fraction > 0 ? fraction : 100;
    const quantityValue = -quantityImbalance;
    const valueValue = -valueImbalance;

    tradingSplits.push({
      accountGuid: tradingAccountGuid,
      valueNum: Math.round(valueValue * VALUE_DENOM),
      valueDenom: VALUE_DENOM,
      quantityNum: Math.round(quantityValue * quantityDenom),
      quantityDenom,
    });
  }

  return tradingSplits;
}

/**
 * Process a transaction's splits and add trading splits if needed.
 * This is the main entry point for the trading account logic.
 */
export async function processMultiCurrencySplits(
  splits: Array<{
    guid?: string;
    account_guid: string;
    value_num: number;
    value_denom: number;
    quantity_num?: number;
    quantity_denom?: number;
    memo?: string;
    action?: string;
    reconcile_state?: 'n' | 'c' | 'y';
  }>,
  tx: Parameters<typeof prisma.$transaction>[0] extends (prisma: infer P) => unknown ? P : never
): Promise<{
  isMultiCurrency: boolean;
  allSplits: Array<{
    guid?: string;
    account_guid: string;
    value_num: number;
    value_denom: number;
    quantity_num: number;
    quantity_denom: number;
    memo?: string;
    action?: string;
    reconcile_state?: 'n' | 'c' | 'y';
  }>;
}> {
  // Fetch commodity info for each split's account
  const accountGuids = splits.map(s => s.account_guid);
  const accounts = await tx.accounts.findMany({
    where: { guid: { in: accountGuids } },
    include: { commodity: true },
  });

  const accountMap = new Map(accounts.map(a => [a.guid, a]));

  // Build splits with commodity info
  const splitsWithCommodity: SplitWithCommodity[] = splits.map(split => {
    const account = accountMap.get(split.account_guid);
    const quantityNum = split.quantity_num ?? split.value_num;
    const quantityDenom = split.quantity_denom ?? split.value_denom;
    const quantity = quantityNum / quantityDenom;

    return {
      accountGuid: split.account_guid,
      commodityGuid: account?.commodity_guid || '',
      commodityMnemonic: account?.commodity?.mnemonic || '',
      commodityNamespace: account?.commodity?.namespace || 'CURRENCY',
      commodityFraction: account?.commodity?.fraction || 100,
      value: split.value_num / split.value_denom,
      quantity,
    };
  });

  // Check if multi-currency
  if (!needsTradingAccounts(splitsWithCommodity)) {
    // Not multi-currency, return splits with quantity fields filled in
    return {
      isMultiCurrency: false,
      allSplits: splits.map(s => ({
        ...s,
        quantity_num: s.quantity_num ?? s.value_num,
        quantity_denom: s.quantity_denom ?? s.value_denom,
      })),
    };
  }

  // Calculate quantity AND value imbalances
  const imbalances = calculateImbalances(splitsWithCommodity);

  // Get or create trading accounts for each imbalanced commodity
  const tradingAccountGuids = new Map<string, string>();
  for (const [commodityGuid, { mnemonic, namespace }] of imbalances) {
    const tradingGuid = await getOrCreateTradingAccount(commodityGuid, mnemonic, namespace, tx);
    tradingAccountGuids.set(commodityGuid, tradingGuid);
  }

  // Generate trading splits
  const tradingSplits = generateTradingSplits(imbalances, tradingAccountGuids);

  // Combine original splits with trading splits
  const allSplits = [
    ...splits.map(s => ({
      ...s,
      quantity_num: s.quantity_num ?? s.value_num,
      quantity_denom: s.quantity_denom ?? s.value_denom,
    })),
    ...tradingSplits.map(ts => ({
      account_guid: ts.accountGuid,
      value_num: ts.valueNum,
      value_denom: ts.valueDenom,
      quantity_num: ts.quantityNum,
      quantity_denom: ts.quantityDenom,
      memo: 'Trading split',
      action: '',
      reconcile_state: 'n' as const,
    })),
  ];

  return {
    isMultiCurrency: true,
    allSplits,
  };
}
