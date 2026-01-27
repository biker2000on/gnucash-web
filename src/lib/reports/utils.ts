import prisma from '@/lib/prisma';

/**
 * Build a map of account GUID to full account path (e.g. "Assets:Current Assets:Checking")
 * Excludes the root account name from the path.
 */
export async function buildAccountPathMap(): Promise<Map<string, string>> {
    const accounts = await prisma.accounts.findMany({
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
