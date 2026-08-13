import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { toDecimalNumber } from '@/lib/gnucash';
import { LineItem } from './types';

/**
 * Convert GnuCash fraction to decimal number.
 * Note: This returns a number, unlike gnucash.ts's toDecimal which returns a string.
 * Delegates to the canonical converter so the two can't drift apart.
 */
export function toDecimal(num: bigint | null, denom: bigint | null): number {
    return toDecimalNumber(num, denom);
}

export interface SplitSums {
    /** SUM(quantity_num / quantity_denom) over the matched splits */
    quantity: NumericString;
    /** SUM(value_num / value_denom) over the matched splits */
    value: NumericString;
}

/**
 * A decimal value returned by PostgreSQL's `numeric` type.
 *
 * node-postgres deliberately returns `numeric` values as strings so it does
 * not lose precision by coercing them to an IEEE-754 number. Keep this type
 * through aggregation; report generators explicitly convert at their legacy
 * number-valued output boundary.
 */
export type NumericString = string & { readonly __numericString: unique symbol };

export const ZERO_NUMERIC = '0' as NumericString;

/**
 * Deliberately convert an exact PostgreSQL numeric string for the existing
 * number-valued report output contract. Call this only at that output edge;
 * aggregation and transport remain exact decimal strings.
 */
export function numericToNumber(value: NumericString): number {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
        throw new RangeError(`PostgreSQL numeric cannot be represented as a finite JavaScript number: ${value}`);
    }
    return numberValue;
}

/**
 * Batched per-account split sums via a single GROUP BY query.
 *
 * Replaces the one-query-per-account pattern in the report generators.
 * Sums are computed as exact PostgreSQL `numeric` per-split quotients. The
 * pg driver returns those numeric results as strings, which are preserved in
 * the map rather than being implicitly rounded to IEEE-754 numbers.
 * Accounts with no matching splits are simply absent from the map (callers
 * default to 0, same as an empty findMany result).
 *
 * `dateRange` mirrors the Prisma post_date filters previously used:
 * `lt`/`gte`/`lte` are combined with AND. Splits whose transaction has a NULL
 * post_date are excluded, exactly like the previous
 * `transaction: { post_date: ... }` Prisma filters.
 */
export async function sumSplitsByAccount(
    accountGuids: string[],
    dateRange: { lt?: Date; gte?: Date; lte?: Date }
): Promise<Map<string, SplitSums>> {
    if (accountGuids.length === 0) return new Map();

    const rows = await prisma.$queryRaw<Array<{
        account_guid: string;
        quantity_sum: string;
        value_sum: string;
    }>>`
        SELECT s.account_guid,
               COALESCE(SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric), 0)::numeric AS quantity_sum,
               COALESCE(SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric), 0)::numeric AS value_sum
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${accountGuids}::text[])
        ${dateRange.gte ? Prisma.sql`AND t.post_date >= ${dateRange.gte}` : Prisma.empty}
        ${dateRange.lt ? Prisma.sql`AND t.post_date < ${dateRange.lt}` : Prisma.empty}
        ${dateRange.lte ? Prisma.sql`AND t.post_date <= ${dateRange.lte}` : Prisma.empty}
        GROUP BY s.account_guid
    `;

    return new Map(rows.map(r => [r.account_guid, {
        quantity: r.quantity_sum as NumericString,
        value: r.value_sum as NumericString,
    }]));
}

export interface AccountWithBalance {
    guid: string;
    name: string;
    account_type: string;
    parent_guid: string | null;
    commodity_guid?: string | null;
    balance: number;
    previousBalance?: number;
}

/**
 * Build hierarchical line items from flat account list.
 *
 * Accounts whose parent is not present in the provided list (e.g. because the
 * parent is hidden and was filtered out upstream, or belongs to another
 * section) would otherwise be unreachable and their balances silently dropped.
 * Such accounts are re-attached to the requested root so no balance is lost.
 */
export function buildHierarchy(accounts: AccountWithBalance[], parentGuid: string | null = null): LineItem[] {
    const guids = new Set(accounts.map(a => a.guid));
    const attachable = accounts.map(account =>
        account.parent_guid === parentGuid || (account.parent_guid !== null && guids.has(account.parent_guid))
            ? account
            : { ...account, parent_guid: parentGuid }
    );
    return buildHierarchyLevel(attachable, parentGuid, 0);
}

function buildHierarchyLevel(accounts: AccountWithBalance[], parentGuid: string | null, depth: number): LineItem[] {
    const children = accounts.filter(a => a.parent_guid === parentGuid);

    return children.map(account => {
        const childItems = buildHierarchyLevel(accounts, account.guid, depth + 1);
        const childrenTotal = childItems.reduce((sum, item) => sum + item.amount, 0);

        return {
            guid: account.guid,
            name: account.name,
            amount: account.balance + childrenTotal,
            previousAmount: account.previousBalance !== undefined
                ? account.previousBalance + childItems.reduce((sum, item) => sum + (item.previousAmount || 0), 0)
                : undefined,
            children: childItems.length > 0 ? childItems : undefined,
            depth,
        };
    });
}

/**
 * Resolve the root account GUID from book-scoped accounts or fallback to default root.
 */
export async function resolveRootGuid(bookAccountGuids?: string[]): Promise<string | null> {
    if (bookAccountGuids && bookAccountGuids.length > 0) {
        const rootAccount = await prisma.accounts.findFirst({
            where: {
                guid: { in: bookAccountGuids },
                account_type: 'ROOT',
            },
            select: { guid: true }
        });
        return rootAccount?.guid || null;
    } else {
        const rootAccount = await prisma.accounts.findFirst({
            where: {
                account_type: 'ROOT',
                name: { startsWith: 'Root' }
            },
            select: { guid: true }
        });
        return rootAccount?.guid || null;
    }
}

/**
 * Build a map of account GUID to full account path (e.g. "Assets:Current Assets:Checking")
 * Excludes the root account name from the path.
 * If bookAccountGuids is provided, only includes those accounts. Ancestors of
 * the provided accounts that are missing from the list are fetched in batches
 * so paths stay complete even for a partial (e.g. per-page) guid list.
 */
export async function buildAccountPathMap(bookAccountGuids?: string[]): Promise<Map<string, string>> {
    const accountSelect = {
        guid: true,
        name: true,
        parent_guid: true,
        account_type: true,
    } as const;
    const accounts = await prisma.accounts.findMany({
        where: bookAccountGuids ? { guid: { in: bookAccountGuids } } : undefined,
        select: accountSelect,
    });

    const byGuid = new Map(accounts.map(a => [a.guid, a]));

    // Resolve missing ancestors (no-op when the list already contains them,
    // e.g. full book account lists)
    if (bookAccountGuids) {
        let missingParents = [...new Set(
            accounts
                .map(a => a.parent_guid)
                .filter((g): g is string => Boolean(g) && !byGuid.has(g!)),
        )];
        while (missingParents.length > 0) {
            const parents = await prisma.accounts.findMany({
                where: { guid: { in: missingParents } },
                select: accountSelect,
            });
            if (parents.length === 0) break;
            for (const p of parents) byGuid.set(p.guid, p);
            missingParents = [...new Set(
                parents
                    .map(p => p.parent_guid)
                    .filter((g): g is string => Boolean(g) && !byGuid.has(g!)),
            )];
        }
    }
    const pathCache = new Map<string, string>();

    function getPath(guid: string): string {
        if (pathCache.has(guid)) return pathCache.get(guid)!;

        const account = byGuid.get(guid);
        if (!account) return '';

        // Root accounts don't appear in paths
        if (account.account_type === 'ROOT') {
            pathCache.set(guid, '');
            return '';
        }

        const parentPath = account.parent_guid ? getPath(account.parent_guid) : '';
        const fullPath = parentPath ? `${parentPath}:${account.name}` : account.name;
        pathCache.set(guid, fullPath);
        return fullPath;
    }

    for (const account of accounts) {
        getPath(account.guid);
    }

    return pathCache;
}
