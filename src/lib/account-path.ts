export function formatDisplayAccountPath(accountPath?: string | null, fallbackName?: string): string {
    if (!accountPath) {
        return fallbackName || '';
    }

    const segments = accountPath.split(':').filter(Boolean);

    if (segments[0] === 'Root Account') {
        segments.shift();
    } else if (segments[1] === 'Root Account') {
        segments.splice(0, 2);
    }

    return segments.join(':') || fallbackName || '';
}

export interface AccountPathNode {
    guid: string;
    name: string;
    parent_guid: string | null;
}

/** Build `Assets:Checking` paths relative to a book root, never including its name. */
export function buildBookRelativeAccountPaths(
    accounts: AccountPathNode[],
    rootGuid: string,
): Map<string, string> {
    const byGuid = new Map(accounts.map((account) => [account.guid, account]));
    const paths = new Map<string, string>([[rootGuid, '']]);
    const visiting = new Set<string>();

    const resolve = (guid: string): string => {
        const cached = paths.get(guid);
        if (cached !== undefined) return cached;
        const account = byGuid.get(guid);
        if (!account) return '';
        if (visiting.has(guid)) return account.name;
        visiting.add(guid);
        const parentPath = account.parent_guid ? resolve(account.parent_guid) : '';
        visiting.delete(guid);
        const path = parentPath ? `${parentPath}:${account.name}` : account.name;
        paths.set(guid, path);
        return path;
    };

    for (const account of accounts) resolve(account.guid);
    return paths;
}
