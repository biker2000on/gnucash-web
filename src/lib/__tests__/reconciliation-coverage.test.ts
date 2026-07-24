import { describe, expect, it } from 'vitest';
import { classifyCoverage } from '@/lib/reconciliation-coverage';

const NOW = new Date('2026-07-24T12:00:00Z');

describe('classifyCoverage', () => {
  it('classifies current accounts and computes split coverage', () => {
    const account = classifyCoverage({
      account_guid: 'a'.repeat(32),
      name: 'Operating Checking',
      account_type: 'BANK',
      total_splits: '10',
      reconciled_splits: '9',
      cleared_splits: '1',
      outstanding_splits: '0',
      last_activity_date: new Date('2026-07-20T00:00:00Z'),
      verified_through: new Date('2026-07-15T00:00:00Z'),
    }, NOW);
    expect(account.status).toBe('current');
    expect(account.coveragePercent).toBe(90);
    expect(account.staleDays).toBe(9);
  });

  it('separates stale from never-reconciled accounts', () => {
    const base = {
      account_guid: 'b'.repeat(32),
      name: 'Card',
      account_type: 'CREDIT',
      total_splits: '2',
      reconciled_splits: '0',
      cleared_splits: '0',
      outstanding_splits: '2',
      last_activity_date: NOW,
    };
    expect(classifyCoverage({ ...base, verified_through: new Date('2026-01-01T00:00:00Z') }, NOW).status).toBe('stale');
    expect(classifyCoverage({ ...base, verified_through: null }, NOW).status).toBe('never');
  });

  it('treats empty accounts as fully covered without inventing a verified date', () => {
    const account = classifyCoverage({
      account_guid: 'c'.repeat(32),
      name: 'Reserve',
      account_type: 'BANK',
      total_splits: '0',
      reconciled_splits: '0',
      cleared_splits: '0',
      outstanding_splits: '0',
      last_activity_date: null,
      verified_through: null,
    }, NOW);
    expect(account.coveragePercent).toBe(100);
    expect(account.status).toBe('never');
  });
});
