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
import { accountNameLockKey, acquireNamedXactLock, isTopLevelPrismaClient } from '@/lib/book-lock';

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

/** Transaction-currency precision used for every trading split's value. */
const VALUE_DENOM = 100;

/** Quantities below this are representation noise, not a real commodity imbalance. */
const QUANTITY_EPSILON = 0.0001;

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

  // Drop a commodity only when BOTH its quantity and its value net to zero.
  // A commodity can net to zero shares while still carrying value — a return
  // of capital posts 0 shares and -$500 basis to the security account — and
  // dropping it there would leave that $500 with nothing to offset it.
  for (const [guid, data] of imbalances) {
    const quantityMaterial = Math.abs(data.quantityImbalance) >= QUANTITY_EPSILON;
    const valueMaterial = Math.round(data.valueImbalance * VALUE_DENOM) !== 0;
    if (!quantityMaterial && !valueMaterial) {
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
  bookAccountGuids: Set<string>,
  tx?: TradingTx
): Promise<string> {
  const client = (tx ?? prisma) as TradingTx;
  // The per-(parent, name) serializer below is transaction-scoped, so open a
  // transaction when we were not handed one rather than run the locks in
  // autocommit, where they would be released before their own re-check.
  if (isTopLevelPrismaClient(client)) {
    return (client as unknown as typeof prisma).$transaction(inner =>
      getOrCreateTradingAccountWithin(
        inner as TradingTx, commodityGuid, commodityMnemonic, commodityNamespace, bookAccountGuids,
      ),
    );
  }
  return getOrCreateTradingAccountWithin(
    client, commodityGuid, commodityMnemonic, commodityNamespace, bookAccountGuids,
  );
}

type TradingTx = Parameters<typeof prisma.$transaction>[0] extends (prisma: infer P) => unknown ? P : never;

async function getOrCreateTradingAccountWithin(
  db: TradingTx,
  commodityGuid: string,
  commodityMnemonic: string,
  commodityNamespace: string,
  bookAccountGuids: Set<string>,
): Promise<string> {
  const scopedGuids = [...bookAccountGuids];
  if (scopedGuids.length === 0) {
    throw new Error('Cannot create a trading account for an empty book scope');
  }

  // Each check-then-create below is guarded by a per-(parent, name)
  // advisory lock with a re-check after acquiring it, so two concurrent
  // multi-currency saves can no longer create duplicate Trading trees.
  // `db` is always transactional here (see getOrCreateTradingAccount); only
  // in-memory test doubles without $queryRaw skip the lock, and they report
  // that by returning false instead of pretending to have locked.

  // 1. Find root Trading account or create it
  let tradingRoot = await db.accounts.findFirst({
    where: {
      name: 'Trading',
      account_type: 'TRADING',
      guid: { in: scopedGuids },
    },
    orderBy: { guid: 'asc' },
  });

  if (!tradingRoot) {
    // Find this book's root account, never an arbitrary root from another
    // book. The supplied scope came from the caller's session-derived book.
    const rootAccount = await db.accounts.findFirst({
      where: { account_type: 'ROOT', guid: { in: scopedGuids } },
      orderBy: { guid: 'asc' },
    });

    if (!rootAccount) {
      throw new Error('No root account found in database');
    }

    const locked = await acquireNamedXactLock(db, accountNameLockKey(rootAccount.guid, 'Trading'));
    if (locked) {
      tradingRoot = await db.accounts.findFirst({
        // Do not use the caller's cached account list here: this re-check
        // specifically has to see a Trading root created after that list was
        // populated by a prior save. rootAccount is already in scope.
        where: { name: 'Trading', account_type: 'TRADING', parent_guid: rootAccount.guid },
        orderBy: { guid: 'asc' },
      });
    }

    if (!tradingRoot) {
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
      // The caller's scope was captured before this hierarchy existed. Keep
      // it current so a later commodity in this same save can reuse this new
      // Trading root and so the route's output assertion recognizes it.
      bookAccountGuids.add(tradingRoot.guid);
    }
  }

  // 2. Find or create namespace group under Trading (CURRENCY, NYSE, NASDAQ, etc.)
  let namespaceGroup = await db.accounts.findFirst({
    where: { name: commodityNamespace, parent_guid: tradingRoot.guid },
    orderBy: { guid: 'asc' },
  });

  if (!namespaceGroup) {
    const locked = await acquireNamedXactLock(db, accountNameLockKey(tradingRoot.guid, commodityNamespace));
    if (locked) {
      namespaceGroup = await db.accounts.findFirst({
        where: { name: commodityNamespace, parent_guid: tradingRoot.guid },
        orderBy: { guid: 'asc' },
      });
    }
  }

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
    bookAccountGuids.add(namespaceGroup.guid);
  }

  // 3. Find or create specific commodity account (e.g., Trading:NYSE:VTI or Trading:CURRENCY:EUR)
  let commodityAccount = await db.accounts.findFirst({
    where: { name: commodityMnemonic, parent_guid: namespaceGroup.guid },
    orderBy: { guid: 'asc' },
  });

  if (!commodityAccount) {
    const locked = await acquireNamedXactLock(db, accountNameLockKey(namespaceGroup.guid, commodityMnemonic));
    if (locked) {
      commodityAccount = await db.accounts.findFirst({
        where: { name: commodityMnemonic, parent_guid: namespaceGroup.guid },
        orderBy: { guid: 'asc' },
      });
    }
  }

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
    bookAccountGuids.add(commodityAccount.guid);
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

  for (const [commodityGuid, { quantityImbalance, valueImbalance, fraction }] of imbalances) {
    const tradingAccountGuid = tradingAccountGuids.get(commodityGuid);
    if (!tradingAccountGuid) continue;

    const quantityDenom = fraction > 0 ? fraction : 100;

    tradingSplits.push({
      accountGuid: tradingAccountGuid,
      valueNum: roundToInt(-valueImbalance, VALUE_DENOM),
      valueDenom: VALUE_DENOM,
      quantityNum: roundToInt(-quantityImbalance, quantityDenom),
      quantityDenom,
    });
  }

  return tradingSplits;
}

/** Round to an integer numerator, normalizing -0 (which Postgres would reject as a surprise). */
function roundToInt(value: number, denom: number): number {
  const num = Math.round(value * denom);
  return num === 0 ? 0 : num;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

/**
 * Post-condition for the trading-split generator: the full split set must sum
 * to exactly zero in value. Compared over the least common denominator so the
 * check is exact integer arithmetic rather than float tolerance.
 *
 * Throws rather than returning a flag: `processMultiCurrencySplits` runs after
 * the API route's own validation and its output is never re-validated, so an
 * unbalanced set here would be written straight to the books.
 */
export function assertValueBalanced(
  splits: Array<{ value_num: number; value_denom: number }>,
): void {
  if (splits.length === 0) return;

  let common = 1n;
  for (const s of splits) {
    const d = BigInt(s.value_denom);
    if (d === 0n) throw new Error('Split has a zero value denominator');
    common = (common / gcd(common, d)) * d;
  }

  let total = 0n;
  for (const s of splits) {
    total += BigInt(s.value_num) * (common / BigInt(s.value_denom));
  }

  if (total !== 0n) {
    throw new Error(
      `Trading splits do not balance: value sums to ${Number(total) / Number(common)} instead of 0. `
      + 'Refusing to write an unbalanced transaction.',
    );
  }
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
  tx: Parameters<typeof prisma.$transaction>[0] extends (prisma: infer P) => unknown ? P : never,
  bookAccountGuids: Set<string>,
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
    const tradingGuid = await getOrCreateTradingAccount(
      commodityGuid,
      mnemonic,
      namespace,
      bookAccountGuids,
      tx,
    );
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

  assertValueBalanced(allSplits);

  return {
    isMultiCurrency: true,
    allSplits,
  };
}
