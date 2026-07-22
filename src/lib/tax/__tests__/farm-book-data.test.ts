/**
 * Farm subtree expansion — pure graph logic tests for
 * expandGuidsToDescendants (no prisma / no I/O).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ default: {} }));

import { expandGuidsToDescendants } from '../farm-book-data';

const node = (guid: string, parent: string | null) => ({
  guid,
  parent_guid: parent,
});

describe('expandGuidsToDescendants', () => {
  it('expands selected roots to all descendants, leaving siblings out', () => {
    // income -> honey -> {retail, wholesale}; income -> pollination; expenses -> feed
    const accounts = [
      node('income', null),
      node('honey', 'income'),
      node('retail', 'honey'),
      node('wholesale', 'honey'),
      node('pollination', 'income'),
      node('expenses', null),
      node('feed', 'expenses'),
    ];
    const expanded = expandGuidsToDescendants(['honey'], accounts);
    expect([...expanded].sort()).toEqual(['honey', 'retail', 'wholesale']);
    expect(expanded).not.toContain('pollination');
    expect(expanded).not.toContain('feed');
  });

  it('ignores roots outside the book and dedups overlapping root selections', () => {
    const accounts = [
      node('a', null),
      node('b', 'a'),
      node('c', 'b'),
    ];
    // 'ghost' is not in the book; 'a' already covers 'b' and 'c'.
    const expanded = expandGuidsToDescendants(['ghost', 'a', 'b'], accounts);
    expect([...expanded].sort()).toEqual(['a', 'b', 'c']);
    expect(expandGuidsToDescendants(['ghost'], accounts)).toEqual([]);
  });

  it('terminates on a parent cycle without duplicating guids', () => {
    // Defensive: corrupt data where two accounts claim each other as parent.
    const accounts = [node('x', 'y'), node('y', 'x'), node('z', 'y')];
    const expanded = expandGuidsToDescendants(['x'], accounts);
    expect([...expanded].sort()).toEqual(['x', 'y', 'z']);
  });
});
