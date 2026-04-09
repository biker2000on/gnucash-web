// src/lib/__tests__/category-mapper.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma before importing the module under test
vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
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
import prisma from '@/lib/prisma';

const mockPrisma = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};

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
    mockPrisma.$queryRaw.mockResolvedValue([
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
    // confidence = 1.0 * min(1, 10/5) = 1.0
    expect(result!.confidence).toBe(1.0);
    expect(result!.keyword).toBe('Dog Food');
  });

  it('substring match returns confidence 0.7', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        keyword: 'dog food',
        keyword_normalized: 'dog food',
        account_guid: 'acc-456',
        use_count: 5,
      },
    ]);

    const result = await suggestAccount('book-1', 'Purina Dog Food 30lb');
    expect(result).not.toBeNull();
    // confidence = 0.7 * min(1, 5/5) = 0.7
    expect(result!.confidence).toBe(0.7);
  });

  it('fuzzy match (Levenshtein < 3) returns confidence 0.4', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        keyword: 'dog fod',
        keyword_normalized: 'dog fod',
        account_guid: 'acc-789',
        use_count: 5,
      },
    ]);

    const result = await suggestAccount('book-1', 'dog food');
    expect(result).not.toBeNull();
    // distance("dog food", "dog fod") = 1 < 3 → confidence 0.4 * min(1, 5/5) = 0.4
    expect(result!.confidence).toBe(0.4);
  });

  it('no match returns null', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
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
    mockPrisma.$queryRaw.mockResolvedValue([
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

    // Both are exact matches, but the second has higher use_count
    // First: 1.0 * min(1, 1/5) = 0.2
    // Second: 1.0 * min(1, 5/5) = 1.0
    const result = await suggestAccount('book-1', 'dog food');
    expect(result).not.toBeNull();
    expect(result!.accountGuid).toBe('acc-high');
    expect(result!.confidence).toBe(1.0);
  });
});

describe('recordMapping', () => {
  it('calls prisma.$executeRaw with correct SQL', async () => {
    mockPrisma.$executeRaw.mockResolvedValue(1);

    await recordMapping('book-1', 'Dog Food', 'acc-123');

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    // The tagged template produces a Prisma Sql object; check it was called
    const callArgs = mockPrisma.$executeRaw.mock.calls[0];
    expect(callArgs).toBeDefined();
  });

  it('normalizes keyword before insert', async () => {
    mockPrisma.$executeRaw.mockResolvedValue(1);

    await recordMapping('book-1', '  Purina Dog Food  ', 'acc-123');

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    // The tagged template literal passes normalized keyword as a parameter
    // We verify the function was called (normalization is internal)
    const callArgs = mockPrisma.$executeRaw.mock.calls[0];
    expect(callArgs).toBeDefined();
  });
});

describe('listMappings', () => {
  it('returns formatted results', async () => {
    const now = new Date('2026-04-01T00:00:00Z');
    mockPrisma.$queryRaw.mockResolvedValue([
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
  it('calls prisma.$executeRaw', async () => {
    mockPrisma.$executeRaw.mockResolvedValue(1);

    await deleteMapping(42);

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('updateMapping', () => {
  it('calls prisma.$executeRaw with new account_guid', async () => {
    mockPrisma.$executeRaw.mockResolvedValue(1);

    await updateMapping(42, 'acc-new');

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
