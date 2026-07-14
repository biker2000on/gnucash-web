/**
 * Ownership resolution tests
 *
 * Covers the pure inheritance core (resolveOwnersFromData) and the
 * prisma-backed wrapper (resolveAccountOwners).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrefsFindMany = vi.fn();
const mockAccountsFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_account_preferences: {
      findMany: (...args: unknown[]) => mockPrefsFindMany(...args),
    },
    accounts: {
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
    },
  },
}));

import {
  resolveOwnersFromData,
  resolveAccountOwners,
  withRetirementSelfDefault,
  type AccountOwner,
} from '../ownership';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveOwnersFromData', () => {
  it('returns the account\'s own owner when set directly', () => {
    const map = resolveOwnersFromData(
      [{ account_guid: 'a', owner: 'self' }],
      [{ guid: 'a', parent_guid: null }],
    );
    expect(map.get('a')).toBe('self');
  });

  it('inherits from the parent and grandparent', () => {
    const map = resolveOwnersFromData(
      [{ account_guid: 'root-assets', owner: 'joint' }],
      [
        { guid: 'root-assets', parent_guid: null },
        { guid: 'checking', parent_guid: 'root-assets' },
        { guid: 'sub-checking', parent_guid: 'checking' },
      ],
    );
    expect(map.get('root-assets')).toBe('joint');
    expect(map.get('checking')).toBe('joint');
    expect(map.get('sub-checking')).toBe('joint');
  });

  it('lets the nearest ancestor win over a farther one (child override)', () => {
    const map = resolveOwnersFromData(
      [
        { account_guid: 'parent', owner: 'joint' },
        { account_guid: 'child', owner: 'spouse' },
      ],
      [
        { guid: 'parent', parent_guid: null },
        { guid: 'child', parent_guid: 'parent' },
        { guid: 'grandchild', parent_guid: 'child' },
      ],
    );
    expect(map.get('parent')).toBe('joint');
    expect(map.get('child')).toBe('spouse');
    expect(map.get('grandchild')).toBe('spouse');
  });

  it('omits accounts with no owner anywhere in their ancestry', () => {
    const map = resolveOwnersFromData(
      [{ account_guid: 'owned', owner: 'self' }],
      [
        { guid: 'owned', parent_guid: null },
        { guid: 'orphan', parent_guid: null },
        { guid: 'orphan-child', parent_guid: 'orphan' },
      ],
    );
    expect(map.has('orphan')).toBe(false);
    expect(map.has('orphan-child')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('ignores invalid or null owner values', () => {
    const map = resolveOwnersFromData(
      [
        { account_guid: 'a', owner: 'household' },
        { account_guid: 'b', owner: null },
      ],
      [
        { guid: 'a', parent_guid: null },
        { guid: 'b', parent_guid: 'a' },
      ],
    );
    expect(map.size).toBe(0);
  });

  it('does not hang on a parent cycle', () => {
    const map = resolveOwnersFromData(
      [{ account_guid: 'other', owner: 'self' }],
      [
        { guid: 'x', parent_guid: 'y' },
        { guid: 'y', parent_guid: 'x' },
        { guid: 'other', parent_guid: null },
      ],
    );
    expect(map.has('x')).toBe(false);
    expect(map.has('y')).toBe(false);
    expect(map.get('other')).toBe('self');
  });

  it('does not inherit through an ancestor outside the provided scope', () => {
    // parent is not in the accounts list (e.g. filtered out of the book)
    const map = resolveOwnersFromData(
      [{ account_guid: 'outside-parent', owner: 'self' }],
      [{ guid: 'child', parent_guid: 'outside-parent' }],
    );
    expect(map.has('child')).toBe(false);
  });
});

describe('resolveAccountOwners', () => {
  it('returns an empty map without querying when scope is empty', async () => {
    const map = await resolveAccountOwners([]);
    expect(map.size).toBe(0);
    expect(mockPrefsFindMany).not.toHaveBeenCalled();
    expect(mockAccountsFindMany).not.toHaveBeenCalled();
  });

  it('short-circuits when no owner preferences exist', async () => {
    mockPrefsFindMany.mockResolvedValue([]);
    const map = await resolveAccountOwners(['a', 'b']);
    expect(map.size).toBe(0);
    expect(mockAccountsFindMany).not.toHaveBeenCalled();
  });

  it('loads prefs and accounts and applies inheritance', async () => {
    mockPrefsFindMany.mockResolvedValue([
      { account_guid: 'brokerage', owner: 'spouse' },
    ]);
    mockAccountsFindMany.mockResolvedValue([
      { guid: 'brokerage', parent_guid: null },
      { guid: 'brokerage-vti', parent_guid: 'brokerage' },
      { guid: 'unrelated', parent_guid: null },
    ]);

    const map = await resolveAccountOwners(['brokerage', 'brokerage-vti', 'unrelated']);
    expect(map.get('brokerage')).toBe('spouse');
    expect(map.get('brokerage-vti')).toBe('spouse');
    expect(map.has('unrelated')).toBe(false);
  });
});

describe('withRetirementSelfDefault', () => {
  it('defaults ownerless retirement accounts to self', () => {
    const owners = new Map<string, AccountOwner>([['taxable', 'joint']]);
    const merged = withRetirementSelfDefault(owners, ['ira', '401k']);
    expect(merged.get('ira')).toBe('self');
    expect(merged.get('401k')).toBe('self');
    expect(merged.get('taxable')).toBe('joint');
  });

  it('never overrides an explicit or inherited owner', () => {
    const owners = new Map<string, AccountOwner>([['spouse-ira', 'spouse']]);
    const merged = withRetirementSelfDefault(owners, ['spouse-ira', 'my-ira']);
    expect(merged.get('spouse-ira')).toBe('spouse');
    expect(merged.get('my-ira')).toBe('self');
  });

  it('does not mutate the input map', () => {
    const owners = new Map<string, AccountOwner>();
    withRetirementSelfDefault(owners, ['ira']);
    expect(owners.size).toBe(0);
  });
});
