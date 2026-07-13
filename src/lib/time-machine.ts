/**
 * Time Machine
 *
 * "What did my book look like on <date>?" — computes the account tree with
 * balances as of end-of-day on an arbitrary date:
 *
 *   - Currency accounts: sum of split quantities through the date.
 *   - STOCK/MUTUAL accounts: share balance × the latest price ≤ the date
 *     (same valuation approach as account-current-value.ts / balance sheet;
 *     implied $0 prices skipped).
 *
 * Plus a summary (net worth, assets, liabilities, per-type totals) and a diff
 * helper `compareAsOf(a, b)` for compare mode.
 *
 * The date filters are also applied in JS (defense-in-depth over the SQL
 * filters), which keeps the pure helpers below honestly unit-testable.
 */

import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AsOfAccount {
    guid: string;
    name: string;
    path: string;
    type: string;
    /** Raw balance in the account's commodity units (dollars or shares). */
    quantity: number;
    /** Own balance valued in currency units (qty × price for securities). */
    balance: number;
    /** Own balance + all descendants' balances. */
    total: number;
    children: AsOfAccount[];
}

export interface AsOfSummary {
    /** assets + liabilities (liabilities are negative); equity excluded. */
    netWorth: number;
    assets: number;
    /** Signed (≤ 0 when liabilities are owed). */
    liabilities: number;
    /** Signed valued total per account type (BANK, STOCK, LIABILITY, ...). */
    byType: Record<string, number>;
}

export interface BookAsOf {
    /** The requested as-of date (YYYY-MM-DD, end of day). */
    asOf: string;
    tree: AsOfAccount[];
    /** Flat list of every account (same objects as in the tree). */
    accounts: Array<Omit<AsOfAccount, 'children'>>;
    summary: AsOfSummary;
}

export interface AccountDelta {
    guid: string;
    name: string;
    path: string;
    type: string;
    from: number;
    to: number;
    delta: number;
}

export interface AsOfComparison {
    fromDate: string;
    toDate: string;
    /** Per-account balance delta (own balance, valued), keyed by guid. */
    byGuid: Record<string, AccountDelta>;
    summary: {
        netWorth: number;
        assets: number;
        liabilities: number;
    };
}

const ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** End-of-day instant for a YYYY-MM-DD date string (UTC). */
export function endOfDay(date: string): Date {
    return new Date(`${date}T23:59:59.999Z`);
}

export interface SplitLike {
    account_guid: string;
    quantity_num: bigint | number | string;
    quantity_denom: bigint | number | string;
    transaction: { post_date: Date | null };
}

/**
 * Sum split quantities per account, counting only splits posted on or before
 * `cutoff`. Splits without a post date are ignored.
 */
export function sumQuantitiesAsOf(splits: SplitLike[], cutoff: Date): Map<string, number> {
    const sums = new Map<string, number>();
    for (const split of splits) {
        const postDate = split.transaction.post_date;
        if (!postDate || postDate.getTime() > cutoff.getTime()) continue;
        const qty = toDecimalNumber(split.quantity_num, split.quantity_denom);
        sums.set(split.account_guid, (sums.get(split.account_guid) ?? 0) + qty);
    }
    return sums;
}

export interface PriceLike {
    commodity_guid: string;
    date: Date;
    value_num: bigint | number | string;
    value_denom: bigint | number | string;
}

/**
 * Latest price per commodity on or before `cutoff`, skipping non-positive
 * (implied $0) prices. Rows may arrive in any order.
 */
export function pickLatestPricesAsOf(prices: PriceLike[], cutoff: Date): Map<string, number> {
    const best = new Map<string, { date: number; value: number }>();
    for (const price of prices) {
        if (price.date.getTime() > cutoff.getTime()) continue;
        const value = toDecimalNumber(price.value_num, price.value_denom);
        if (value <= 0) continue;
        const existing = best.get(price.commodity_guid);
        if (!existing || price.date.getTime() > existing.date) {
            best.set(price.commodity_guid, { date: price.date.getTime(), value });
        }
    }
    return new Map([...best].map(([guid, p]) => [guid, p.value]));
}

interface AccountMeta {
    guid: string;
    name: string;
    account_type: string;
    parent_guid: string | null;
    commodity_guid: string | null;
    commodityNamespace: string | null;
}

/** True when the account holds a non-currency commodity (valued via prices). */
function isSecurity(account: AccountMeta): boolean {
    return !!account.commodity_guid && account.commodityNamespace !== 'CURRENCY';
}

/**
 * Assemble the valued account tree + flat list from account metadata,
 * per-account quantities, and per-commodity prices. Pure.
 */
export function buildAsOfTree(
    accounts: AccountMeta[],
    quantities: Map<string, number>,
    prices: Map<string, number>,
): { tree: AsOfAccount[]; flat: AsOfAccount[] } {
    const byGuid = new Map<string, AsOfAccount>();
    const metaByGuid = new Map(accounts.map(a => [a.guid, a]));

    for (const account of accounts) {
        const quantity = quantities.get(account.guid) ?? 0;
        const balance = isSecurity(account)
            ? quantity * (prices.get(account.commodity_guid as string) ?? 0)
            : quantity;
        byGuid.set(account.guid, {
            guid: account.guid,
            name: account.name,
            path: account.name, // finalized below
            type: account.account_type,
            quantity,
            balance,
            total: 0,
            children: [],
        });
    }

    // Path: walk parents within the set (the book root is not in the set).
    for (const account of accounts) {
        const parts = [account.name];
        let parent = account.parent_guid ? metaByGuid.get(account.parent_guid) : undefined;
        while (parent) {
            parts.unshift(parent.name);
            parent = parent.parent_guid ? metaByGuid.get(parent.parent_guid) : undefined;
        }
        byGuid.get(account.guid)!.path = parts.join(':');
    }

    // Tree: accounts whose parent is outside the set become roots.
    const roots: AsOfAccount[] = [];
    for (const account of accounts) {
        const node = byGuid.get(account.guid)!;
        const parent = account.parent_guid ? byGuid.get(account.parent_guid) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
    }

    const sortRec = (nodes: AsOfAccount[]): void => {
        nodes.sort((a, b) => a.name.localeCompare(b.name));
        nodes.forEach(n => sortRec(n.children));
    };
    sortRec(roots);

    const totalRec = (node: AsOfAccount): number => {
        node.total = node.balance + node.children.reduce((sum, c) => sum + totalRec(c), 0);
        return node.total;
    };
    roots.forEach(totalRec);

    return { tree: roots, flat: [...byGuid.values()] };
}

/** Net worth / assets / liabilities / per-type totals from the flat list. Pure. */
export function summarizeAsOf(flat: Array<Pick<AsOfAccount, 'type' | 'balance'>>): AsOfSummary {
    let assets = 0;
    let liabilities = 0;
    const byType: Record<string, number> = {};
    for (const account of flat) {
        byType[account.type] = (byType[account.type] ?? 0) + account.balance;
        if (ASSET_TYPES.includes(account.type)) assets += account.balance;
        else if (LIABILITY_TYPES.includes(account.type)) liabilities += account.balance;
    }
    return { netWorth: assets + liabilities, assets, liabilities, byType };
}

/**
 * Per-account delta between two as-of snapshots (b − a). Accounts present in
 * only one snapshot are treated as 0 on the other side. Pure.
 */
export function compareAsOf(a: BookAsOf, b: BookAsOf): AsOfComparison {
    const aByGuid = new Map(a.accounts.map(acc => [acc.guid, acc]));
    const bByGuid = new Map(b.accounts.map(acc => [acc.guid, acc]));
    const guids = new Set([...aByGuid.keys(), ...bByGuid.keys()]);

    const byGuid: Record<string, AccountDelta> = {};
    for (const guid of guids) {
        const from = aByGuid.get(guid);
        const to = bByGuid.get(guid);
        const meta = to ?? from!;
        byGuid[guid] = {
            guid,
            name: meta.name,
            path: meta.path,
            type: meta.type,
            from: from?.balance ?? 0,
            to: to?.balance ?? 0,
            delta: (to?.balance ?? 0) - (from?.balance ?? 0),
        };
    }

    return {
        fromDate: a.asOf,
        toDate: b.asOf,
        byGuid,
        summary: {
            netWorth: b.summary.netWorth - a.summary.netWorth,
            assets: b.summary.assets - a.summary.assets,
            liabilities: b.summary.liabilities - a.summary.liabilities,
        },
    };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * The book's account tree, balances, and summary as of end-of-day on `date`
 * (YYYY-MM-DD). `bookAccountGuids` comes from getBookAccountGuids() (session
 * routes) or an equivalent recursive CTE.
 */
export async function bookAsOf(bookAccountGuids: string[], date: string): Promise<BookAsOf> {
    const cutoff = endOfDay(date);

    const accounts = await prisma.accounts.findMany({
        where: {
            guid: { in: bookAccountGuids },
            account_type: { not: 'ROOT' },
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
            commodity_guid: true,
            commodity: { select: { namespace: true } },
        },
    });

    const metas: AccountMeta[] = accounts.map(a => ({
        guid: a.guid,
        name: a.name,
        account_type: a.account_type,
        parent_guid: a.parent_guid,
        commodity_guid: a.commodity_guid,
        commodityNamespace: a.commodity?.namespace ?? null,
    }));
    const accountGuids = metas.map(a => a.guid);

    const splits = accountGuids.length === 0 ? [] : await prisma.splits.findMany({
        where: {
            account_guid: { in: accountGuids },
            transaction: { post_date: { lte: cutoff } },
        },
        select: {
            account_guid: true,
            quantity_num: true,
            quantity_denom: true,
            transaction: { select: { post_date: true } },
        },
    });
    const quantities = sumQuantitiesAsOf(splits, cutoff);

    const commodityGuids = [...new Set(
        metas.filter(isSecurity).map(a => a.commodity_guid as string),
    )];
    const priceRows = commodityGuids.length === 0 ? [] : await prisma.prices.findMany({
        where: {
            commodity_guid: { in: commodityGuids },
            date: { lte: cutoff },
            value_num: { gt: 0 },
        },
        select: {
            commodity_guid: true,
            date: true,
            value_num: true,
            value_denom: true,
        },
    });
    const prices = pickLatestPricesAsOf(priceRows, cutoff);

    const { tree, flat } = buildAsOfTree(metas, quantities, prices);

    return {
        asOf: date,
        tree,
        accounts: flat.map(node => ({
            guid: node.guid,
            name: node.name,
            path: node.path,
            type: node.type,
            quantity: node.quantity,
            balance: node.balance,
            total: node.total,
        })),
        summary: summarizeAsOf(flat),
    };
}
