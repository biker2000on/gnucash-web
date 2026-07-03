/**
 * Limit Coverage Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindManyLimits = vi.fn();
const mockFindManyPermissions = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_contribution_limits: {
      findMany: (...args: unknown[]) => mockFindManyLimits(...args),
    },
    gnucash_web_book_permissions: {
      findMany: (...args: unknown[]) => mockFindManyPermissions(...args),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

const mockCreateNotification = vi.fn();
vi.mock('@/lib/notifications', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  ensureNotificationsTable: vi.fn().mockResolvedValue(undefined),
}));

import {
  yearsToCheck,
  getExpectedLimitTypes,
  computeMissingTypes,
  checkLimitCoverage,
  notifyMissingLimitCoverage,
} from '../limit-coverage.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('yearsToCheck', () => {
  it('returns only the current year before November', () => {
    expect(yearsToCheck(new Date('2026-07-02T12:00:00'))).toEqual([2026]);
    expect(yearsToCheck(new Date('2026-10-31T12:00:00'))).toEqual([2026]);
  });

  it('includes next year from November onward', () => {
    expect(yearsToCheck(new Date('2026-11-01T12:00:00'))).toEqual([2026, 2027]);
    expect(yearsToCheck(new Date('2026-12-15T12:00:00'))).toEqual([2026, 2027]);
  });
});

describe('getExpectedLimitTypes', () => {
  it('includes limit-bearing retirement types and excludes no-limit types', () => {
    const types = getExpectedLimitTypes(new Date('2026-07-02T12:00:00'));
    expect(types).toContain('401k');
    expect(types).toContain('hsa');
    expect(types).toContain('coverdell_esa');
    // No federal limit
    expect(types).not.toContain('brokerage');
    expect(types).not.toContain('education_529');
    // Never present in code defaults (employer-set)
    expect(types).not.toContain('hra');
  });
});

describe('computeMissingTypes', () => {
  it('returns expected types not covered', () => {
    expect(computeMissingTypes(['401k', 'hsa', 'fsa'], ['hsa'])).toEqual(['401k', 'fsa']);
    expect(computeMissingTypes(['401k'], ['401k'])).toEqual([]);
  });
});

describe('checkLimitCoverage', () => {
  it('reports no missing types for a year fully covered by code defaults', async () => {
    mockFindManyLimits.mockResolvedValue([]);
    const result = await checkLimitCoverage(new Date('2026-07-02T12:00:00'));
    expect(result).toHaveLength(1);
    expect(result[0].year).toBe(2026);
    expect(result[0].missingTypes).toEqual([]);
  });

  it('reports missing types for a year with no defaults and no overrides', async () => {
    mockFindManyLimits.mockResolvedValue([]);
    const result = await checkLimitCoverage(new Date('2035-03-01T12:00:00'));
    expect(result[0].year).toBe(2035);
    expect(result[0].missingTypes).toContain('401k');
    expect(result[0].missingTypes).toContain('hsa');
  });

  it('treats DB overrides as coverage', async () => {
    mockFindManyLimits.mockResolvedValue([
      { account_type: '401k' },
      { account_type: 'hsa' },
    ]);
    const result = await checkLimitCoverage(new Date('2035-03-01T12:00:00'));
    expect(result[0].missingTypes).not.toContain('401k');
    expect(result[0].missingTypes).not.toContain('hsa');
    expect(result[0].missingTypes).toContain('roth_ira');
  });
});

describe('notifyMissingLimitCoverage', () => {
  const editPerm = { user_id: 1, role: { name: 'edit' } };
  const readonlyPerm = { user_id: 2, role: { name: 'readonly' } };

  it('creates nothing when coverage is complete', async () => {
    mockFindManyLimits.mockResolvedValue([]);
    const result = await notifyMissingLimitCoverage(new Date('2026-07-02T12:00:00'));
    expect(result.notified).toBe(0);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockFindManyPermissions).not.toHaveBeenCalled();
  });

  it('notifies edit/admin users once per missing year', async () => {
    mockFindManyLimits.mockResolvedValue([]);
    mockFindManyPermissions.mockResolvedValue([editPerm, readonlyPerm]);
    mockQueryRaw.mockResolvedValue([]); // no existing unread notification

    const result = await notifyMissingLimitCoverage(new Date('2035-03-01T12:00:00'));
    expect(result.notified).toBe(1);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const arg = mockCreateNotification.mock.calls[0][0];
    expect(arg.userId).toBe(1);
    expect(arg.title).toContain('2035');
    expect(arg.href).toBe('/settings/limits');
    expect(arg.sourceId).toBe('limit-coverage:2035');
  });

  it('skips users with an existing unread notification for the same year', async () => {
    mockFindManyLimits.mockResolvedValue([]);
    mockFindManyPermissions.mockResolvedValue([editPerm]);
    mockQueryRaw.mockResolvedValue([{ id: 42 }]); // unread notification exists

    const result = await notifyMissingLimitCoverage(new Date('2035-03-01T12:00:00'));
    expect(result.notified).toBe(0);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
