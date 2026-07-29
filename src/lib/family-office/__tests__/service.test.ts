import { describe, expect, it } from 'vitest';
import { ownershipByBook, resolveConnectedBookGuids } from '../service';

describe('Family Office permission boundary', () => {
  it('never expands through a link to an unauthorized book', () => {
    const connected = resolveConnectedBookGuids(
      'household',
      ['household', 'business-a'],
      [
        { householdBookGuid: 'household', businessBookGuid: 'business-a' },
        { householdBookGuid: 'household', businessBookGuid: 'secret-business' },
        { householdBookGuid: 'secret-household', businessBookGuid: 'business-a' },
      ],
    );
    expect([...connected].sort()).toEqual(['business-a', 'household']);
  });

  it('returns no graph when the active book itself is unauthorized', () => {
    expect(resolveConnectedBookGuids('missing', ['household'], [])).toEqual(new Set());
  });

  it('walks only the connected component within the authorized set', () => {
    const connected = resolveConnectedBookGuids(
      'household',
      ['household', 'business-a', 'business-b', 'unrelated'],
      [
        { householdBookGuid: 'household', businessBookGuid: 'business-a' },
        { householdBookGuid: 'household', businessBookGuid: 'business-b' },
      ],
    );
    expect(connected.has('unrelated')).toBe(false);
    expect(connected.size).toBe(3);
  });

  it('applies cumulative ownership through nested entities', () => {
    const ownership = ownershipByBook({
      rootBookGuid: 'household',
      entities: [
        { bookGuid: 'household', name: 'Household', entityType: 'household', entityName: null, role: 'admin', reportingCurrency: 'USD' },
        { bookGuid: 'holding', name: 'Holding Co', entityType: 'llc', entityName: null, role: 'admin', reportingCurrency: 'USD' },
        { bookGuid: 'operating', name: 'Operating Co', entityType: 'llc', entityName: null, role: 'readonly', reportingCurrency: 'USD' },
      ],
      relationships: [
        { fromBookGuid: 'household', toBookGuid: 'holding', type: 'owned_business', ownershipPercent: 80 },
        { fromBookGuid: 'holding', toBookGuid: 'operating', type: 'owned_business', ownershipPercent: 50 },
      ],
    });
    expect(ownership.get('household')).toBe(100);
    expect(ownership.get('holding')).toBe(80);
    expect(ownership.get('operating')).toBe(40);
  });
});
