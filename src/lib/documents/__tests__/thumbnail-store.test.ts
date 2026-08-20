import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: mocks.query } }));

import {
  THUMBNAIL_BACKFILL_BATCH_SIZE,
  getDocumentThumbnailStatuses,
  listDocumentsNeedingThumbnails,
} from '../thumbnail-store';

const BOOK = 'b'.repeat(32);

function sqlOf(call: unknown[]): string {
  const first = call[0];
  if (Array.isArray(first)) return first.join('?');
  const strings = (first as { strings?: unknown })?.strings;
  return Array.isArray(strings) ? strings.join('?') : String(first);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
});

describe('getDocumentThumbnailStatuses (L8)', () => {
  it('chunks an oversized id list at the parameter ceiling', async () => {
    await getDocumentThumbnailStatuses(BOOK, Array.from({ length: 2_001 }, (_, i) => i + 1));
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it('maps only recognised statuses and issues one statement for a normal page', async () => {
    mocks.query.mockResolvedValueOnce([
      { id: 1, thumbnail_status: 'complete' },
      { id: 2, thumbnail_status: 'weird' },
    ]);
    const map = await getDocumentThumbnailStatuses(BOOK, [1, 2]);
    expect(map.get(1)).toBe('complete');
    expect(map.get(2)).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('does no work for an empty list', async () => {
    await expect(getDocumentThumbnailStatuses(BOOK, [])).resolves.toEqual(new Map());
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe('listDocumentsNeedingThumbnails (CODEX-7)', () => {
  it('LIMITs the listing rather than materializing every eligible document', async () => {
    mocks.query.mockResolvedValueOnce(
      Array.from({ length: THUMBNAIL_BACKFILL_BATCH_SIZE }, (_, i) => ({ id: i + 1, book_guid: BOOK })),
    ).mockResolvedValueOnce([{ n: 4_800n }]);

    const batch = await listDocumentsNeedingThumbnails();
    expect(batch.documents).toHaveLength(THUMBNAIL_BACKFILL_BATCH_SIZE);
    expect(batch.remaining).toBe(4_800);
    expect(sqlOf(mocks.query.mock.calls[0])).toContain('LIMIT');
  });

  it('reports nothing remaining when the page is not full (no extra count query)', async () => {
    mocks.query.mockResolvedValueOnce([{ id: 1, book_guid: BOOK }]);
    const batch = await listDocumentsNeedingThumbnails();
    expect(batch).toEqual({ documents: [{ id: 1, bookGuid: BOOK }], remaining: 0 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
