import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
const mockUpsert = vi.fn();
const mockDeleteMany = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_category_mappings: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

import {
  normalizeKeyword,
  suggestAccount,
  recordMapping,
  listMappings,
  deleteMapping,
  updateMapping,
} from '../category-mapper';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('normalizeKeyword', () => {
  it('lowercases and trims whitespace', () => {
    expect(normalizeKeyword('  Purina Dog Food 30lb  ')).toBe('purina dog food 30lb');
  });

  it('preserves hyphens and numbers', () => {
    expect(normalizeKeyword('K-Cup 100-Count')).toBe('k-cup 100-count');
  });
});

describe('suggestAccount', () => {
  it('exact match returns confidence 1.0 with use_count weighting', async () => {
    mockFindMany.mockResolvedValue([
      {
        keyword: 'Dog Food',
        keyword_normalized: 'dog food',
        account_guid: 'acc-123',
        use_count: 10,
      },
    ]);

    const result = await suggestAccount('book-1', 'Dog Food');
    expect(result).not.toBeNull();
    expect(result!.accountGuid).toBe('acc-123');
    expect(result!.confidence).toBe(1.0);
    expect(result!.keyword).toBe('Dog Food');
  });

  it('substring match returns confidence 0.7', async () => {
    mockFindMany.mockResolvedValue([
      {
        keyword: 'dog food',
        keyword_normalized: 'dog food',
        account_guid: 'acc-456',
        use_count: 5,
      },
    ]);

    const result = await suggestAccount('book-1', 'Purina Dog Food 30lb');
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.7);
  });

  it('fuzzy match (Levenshtein < 3) returns confidence 0.4', async () => {
    mockFindMany.mockResolvedValue([
      {
        keyword: 'dog fod',
        keyword_normalized: 'dog fod',
        account_guid: 'acc-789',
        use_count: 5,
      },
    ]);

    const result = await suggestAccount('book-1', 'dog food');
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.4);
  });

  it('no match returns null', async () => {
    mockFindMany.mockResolvedValue([
      {
        keyword: 'electronics',
        keyword_normalized: 'electronics',
        account_guid: 'acc-000',
        use_count: 5,
      },
    ]);

    const result = await suggestAccount('book-1', 'dog food');
    expect(result).toBeNull();
  });

  it('use_count weighting: higher count produces stronger signal', async () => {
    mockFindMany.mockResolvedValue([
      {
        keyword: 'dog food',
        keyword_normalized: 'dog food',
        account_guid: 'acc-low',
        use_count: 1,
      },
      {
        keyword: 'Dog Food',
        keyword_normalized: 'dog food',
        account_guid: 'acc-high',
        use_count: 5,
      },
    ]);

    const result = await suggestAccount('book-1', 'dog food');
    expect(result).not.toBeNull();
    expect(result!.accountGuid).toBe('acc-high');
    expect(result!.confidence).toBe(1.0);
  });
});

describe('recordMapping', () => {
  it('calls prisma upsert with correct compound key', async () => {
    mockUpsert.mockResolvedValue({});

    await recordMapping('book-1', 'Dog Food', 'acc-123');

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const call = mockUpsert.mock.calls[0][0];
    expect(call.where.book_guid_source_keyword_normalized).toEqual({
      book_guid: 'book-1',
      source: 'amazon',
      keyword_normalized: 'dog food',
    });
    expect(call.create.account_guid).toBe('acc-123');
    expect(call.update.account_guid).toBe('acc-123');
  });
});

describe('listMappings', () => {
  it('returns formatted results', async () => {
    const now = new Date('2026-04-01T00:00:00Z');
    mockFindMany.mockResolvedValue([
      {
        id: 1,
        keyword: 'Dog Food',
        keyword_normalized: 'dog food',
        account_guid: 'acc-123',
        use_count: 3,
        last_used_at: now,
      },
    ]);

    const result = await listMappings('book-1', 'amazon');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 1,
      keyword: 'Dog Food',
      keywordNormalized: 'dog food',
      accountGuid: 'acc-123',
      useCount: 3,
      lastUsedAt: now,
    });
  });
});

describe('deleteMapping', () => {
  it('calls prisma deleteMany', async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });

    await deleteMapping(42);

    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: 42 } });
  });
});

describe('updateMapping', () => {
  it('calls prisma update with new account_guid', async () => {
    mockUpdate.mockResolvedValue({});

    await updateMapping(42, 'acc-new');

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { account_guid: 'acc-new' },
    });
  });
});
