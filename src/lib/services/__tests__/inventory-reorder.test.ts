/**
 * Reorder-point scan tests — the pure dedupe key (the notification identity
 * that keeps repeat scans from re-alerting) plus the never-throws guarantee
 * of scanInventoryReorder when the database is unavailable.
 */

import { describe, it, expect, vi } from 'vitest';

// The service module imports prisma + notifications at module scope; stub
// them so tests never touch a database or Redis.
vi.mock('@/lib/prisma', () => ({
  default: {
    // scanInventoryReorder's first DB call (ensureInventoryTables) rejects —
    // the scan must swallow it and report an empty result.
    $executeRawUnsafe: vi.fn().mockRejectedValue(new Error('no database in tests')),
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => null }));

import { reorderDedupeKey, scanInventoryReorder } from '../inventory.service';

describe('reorderDedupeKey', () => {
  it('is stable for the same item + reorder point', () => {
    expect(reorderDedupeKey(42, 10)).toBe('item:42:below:10');
    expect(reorderDedupeKey(42, 10)).toBe(reorderDedupeKey(42, 10));
  });

  it('differs per item', () => {
    expect(reorderDedupeKey(1, 10)).not.toBe(reorderDedupeKey(2, 10));
  });

  it('re-arms when the reorder point changes', () => {
    // Raising (or lowering) the point produces a NEW key, so the next scan
    // below the new point alerts again even though the item already alerted.
    expect(reorderDedupeKey(1, 10)).not.toBe(reorderDedupeKey(1, 15));
  });

  it('keeps fractional reorder points distinct', () => {
    expect(reorderDedupeKey(1, 2.5)).toBe('item:1:below:2.5');
    expect(reorderDedupeKey(1, 2.5)).not.toBe(reorderDedupeKey(1, 2));
  });
});

describe('scanInventoryReorder', () => {
  it('never throws — returns an empty result when the DB is unavailable', async () => {
    const result = await scanInventoryReorder('book-guid', { userId: 1 });
    expect(result).toEqual({ detected: 0, created: 0 });
  });
});
