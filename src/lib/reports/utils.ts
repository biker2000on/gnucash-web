import prisma from '@/lib/prisma';
import { LineItem } from './types';

/**
 * Convert GnuCash fraction to decimal number.
 * Note: This returns a number, unlike gnucash.ts's toDecimal which returns a string.
 */
export function toDecimal(num: bigint | null, denom: bigint | null): number {
    if (num === null || denom === null || denom === 0n) return 0;
    return Number(num) / Number(denom);
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
 * Build hierarchical line items from flat account list
 */
export function buildHierarchy(accounts: AccountWithBalance[], parentGuid: string | null = null, depth = 0): LineItem[] {
    const children = accounts.filter(a => a.parent_guid === parentGuid);

    return children.map(account => {
        const childItems = buildHierarchy(accounts, account.guid, depth + 1);
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
 * If bookAccountGuids is provided, only includes those accounts.
 */
export async function buildAccountPathMap(bookAccountGuids?: string[]): Promise<Map<string, string>> {
    const accounts = await prisma.accounts.findMany({
        where: bookAccountGuids ? { guid: { in: bookAccountGuids } } : undefined,
        select: {
            guid: true,
            name: true,
            parent_guid: true,
            account_type: true,
        },
    });

    const byGuid = new Map(accounts.map(a => [a.guid, a]));
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
