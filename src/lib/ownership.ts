/**
 * Account ownership resolution.
 *
 * Accounts can carry an `owner` preference ('self' | 'spouse' | 'joint') in
 * gnucash_web_account_preferences. Ownership inherits down the account tree:
 * an account's effective owner is its own owner, or the nearest ancestor's
 * owner. Accounts with no owner anywhere in their ancestry have no effective
 * owner and are absent from the resolved map.
 *
 * Mirrors the inheritance style used for retirement flags
 * (getRetirementAccountGuids in src/lib/reports/contribution-classifier.ts).
 */

import prisma from '@/lib/prisma';

export type AccountOwner = 'self' | 'spouse' | 'joint';

export function isAccountOwner(value: unknown): value is AccountOwner {
  return value === 'self' || value === 'spouse' || value === 'joint';
}

/**
 * Pure resolution core (exported for unit tests).
 *
 * @param ownerPrefs - accounts with an explicitly set owner
 * @param accounts   - all accounts in scope (guid + parent_guid)
 * @returns map of account guid -> effective owner. Accounts without an owner
 *          anywhere in their ancestry are absent.
 */
export function resolveOwnersFromData(
  ownerPrefs: Array<{ account_guid: string; owner: string | null }>,
  accounts: Array<{ guid: string; parent_guid: string | null }>,
): Map<string, AccountOwner> {
  const ownOwner = new Map<string, AccountOwner>();
  for (const pref of ownerPrefs) {
    if (isAccountOwner(pref.owner)) {
      ownOwner.set(pref.account_guid, pref.owner);
    }
  }

  const resolved = new Map<string, AccountOwner>();
  if (ownOwner.size === 0) return resolved;

  const parentOf = new Map(accounts.map(a => [a.guid, a.parent_guid]));

  // Memoized upward walk: own owner wins, else nearest ancestor's owner.
  const memo = new Map<string, AccountOwner | null>();
  const resolve = (guid: string): AccountOwner | null => {
    if (memo.has(guid)) return memo.get(guid)!;

    // Walk up collecting the chain until we hit an answer (or run out).
    const chain: string[] = [];
    let current: string | null = guid;
    let answer: AccountOwner | null = null;
    const visiting = new Set<string>();
    while (current !== null && parentOf.has(current)) {
      if (memo.has(current)) {
        answer = memo.get(current)!;
        break;
      }
      if (visiting.has(current)) break; // cycle guard
      visiting.add(current);
      const own = ownOwner.get(current);
      if (own) {
        answer = own;
        chain.push(current);
        break;
      }
      chain.push(current);
      current = parentOf.get(current) ?? null;
    }

    for (const g of chain) {
      memo.set(g, answer);
    }
    // The account whose direct owner terminated the walk keeps its own owner;
    // everything below it inherits. (chain memoization above sets all entries
    // to `answer`, which is exactly the nearest-ancestor semantics: the direct
    // owner IS the answer for the terminating account.)
    return answer;
  };

  for (const account of accounts) {
    const owner = resolve(account.guid);
    if (owner) resolved.set(account.guid, owner);
  }

  return resolved;
}

/**
 * Load owner preferences for the given book accounts and resolve effective
 * ownership with ancestor inheritance.
 */
export async function resolveAccountOwners(
  bookAccountGuids: string[],
): Promise<Map<string, AccountOwner>> {
  if (bookAccountGuids.length === 0) return new Map();

  const ownerPrefs = await prisma.gnucash_web_account_preferences.findMany({
    where: {
      account_guid: { in: bookAccountGuids },
      owner: { not: null },
    },
    select: { account_guid: true, owner: true },
  });

  if (ownerPrefs.length === 0) return new Map();

  const accounts = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids } },
    select: { guid: true, parent_guid: true },
  });

  return resolveOwnersFromData(ownerPrefs, accounts);
}
