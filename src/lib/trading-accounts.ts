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
  value: number;      // in transaction currency
  quantity: number;   // in account's native currency
}

/**
 * Check if transaction needs trading accounts.
 * Trading accounts are needed when splits involve different commodities.
 */
export function needsTradingAccounts(splits: SplitWithCommodity[]): boolean {
  const commodities = new Set(splits.map(s => s.commodityGuid));
  return commodities.size > 1;
}

/**
 * Calculate quantity imbalances by commodity.
 * Returns a map of commodityGuid -> { mnemonic, imbalance } for non-zero imbalances.
 */
export function calculateQuantityImbalances(
  splits: SplitWithCommodity[]
): Map<string, { mnemonic: string; imbalance: number }> {
  const imbalances = new Map<string, { mnemonic: string; imbalance: number }>();

  for (const split of splits) {
    const existing = imbalances.get(split.commodityGuid) || {
      mnemonic: split.commodityMnemonic,
      imbalance: 0,
    };
    existing.imbalance += split.quantity;
    imbalances.set(split.commodityGuid, existing);
  }

  // Filter to only non-zero imbalances (use small epsilon for floating point)
  for (const [guid, data] of imbalances) {
    if (Math.abs(data.imbalance) < 0.0001) {
      imbalances.delete(guid);
    }
  }

  return imbalances;
}

/**
 * Get or create Trading:CURRENCY:XXX account hierarchy.
 * Creates the full hierarchy if any part is missing.
 */
export async function getOrCreateTradingAccount(
  commodityGuid: string,
  commodityMnemonic: string,
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

  // 2. Find or create CURRENCY group under Trading
  let currencyGroup = await db.accounts.findFirst({
    where: { name: 'CURRENCY', parent_guid: tradingRoot.guid },
  });

  if (!currencyGroup) {
    currencyGroup = await db.accounts.create({
      data: {
        guid: generateGuid(),
        name: 'CURRENCY',
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

  // 3. Find or create specific currency account (e.g., Trading:CURRENCY:EUR)
  let currencyAccount = await db.accounts.findFirst({
    where: { name: commodityMnemonic, parent_guid: currencyGroup.guid },
  });

  if (!currencyAccount) {
    currencyAccount = await db.accounts.create({
      data: {
        guid: generateGuid(),
        name: commodityMnemonic,
        account_type: 'TRADING',
        commodity_guid: commodityGuid,
        commodity_scu: 100,
        non_std_scu: 0,
        parent_guid: currencyGroup.guid,
        hidden: 0,
        placeholder: 0,
      },
    });
  }

  return currencyAccount.guid;
}

/**
 * Generate trading splits to balance the transaction by commodity quantity.
 * Trading splits have value=0 (don't affect value balance) but non-zero quantity.
 */
export function generateTradingSplits(
  imbalances: Map<string, { mnemonic: string; imbalance: number }>,
  tradingAccountGuids: Map<string, string> // commodityGuid -> tradingAccountGuid
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

  for (const [commodityGuid, { imbalance }] of imbalances) {
    const tradingAccountGuid = tradingAccountGuids.get(commodityGuid);
    if (!tradingAccountGuid) continue;

    // Trading split has value=0 (doesn't affect transaction value balance)
    // but quantity = -imbalance (balances the commodity quantities)
    // Use standard denom of 100 for currency precision
    const denom = 100;
    const quantityValue = -imbalance; // Negate to balance

    tradingSplits.push({
      accountGuid: tradingAccountGuid,
      valueNum: 0,
      valueDenom: denom,
      quantityNum: Math.round(quantityValue * denom),
      quantityDenom: denom,
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

  // Calculate quantity imbalances
  const imbalances = calculateQuantityImbalances(splitsWithCommodity);

  // Get or create trading accounts for each imbalanced commodity
  const tradingAccountGuids = new Map<string, string>();
  for (const [commodityGuid, { mnemonic }] of imbalances) {
    const tradingGuid = await getOrCreateTradingAccount(commodityGuid, mnemonic, tx);
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
