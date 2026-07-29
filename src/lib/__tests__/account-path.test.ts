import { describe, expect, it } from 'vitest';
import { buildBookRelativeAccountPaths, formatDisplayAccountPath } from '@/lib/account-path';

describe('book-relative account paths', () => {
  it('keeps the book name separate from account fullnames', () => {
    const paths = buildBookRelativeAccountPaths([
      { guid: 'root', name: 'Crawford Personal Finances', parent_guid: null },
      { guid: 'assets', name: 'Assets', parent_guid: 'root' },
      { guid: 'checking', name: 'Checking', parent_guid: 'assets' },
    ], 'root');

    expect(paths.get('root')).toBe('');
    expect(paths.get('assets')).toBe('Assets');
    expect(paths.get('checking')).toBe('Assets:Checking');
  });

  it('still formats legacy Root Account paths', () => {
    expect(formatDisplayAccountPath('My Book:Root Account:Assets:Checking')).toBe('Assets:Checking');
  });
});
