import { beforeEach, describe, expect, it, vi } from 'vitest';

const { meetings, items, photos, cleanup } = vi.hoisted(() => ({
  meetings: { findUnique: vi.fn(), delete: vi.fn() },
  items: { findUnique: vi.fn(), delete: vi.fn(), update: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
  photos: { findMany: vi.fn(), delete: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
  cleanup: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_meetings: meetings,
    gnucash_web_home_items: items,
    gnucash_web_home_item_photos: photos,
  },
}));
vi.mock('@/lib/services/document-link-targets.service', () => ({
  unlinkDocumentLinksForTarget: cleanup,
}));

import { deleteMeeting } from '../membership.service';
import { deleteItem } from '../home.service';

const BOOK = 'book-1';

beforeEach(() => {
  vi.clearAllMocks();
  cleanup.mockResolvedValue(1);
});

describe('canonical document link cleanup', () => {
  it('deletes the authoritative meeting before removing its target links', async () => {
    meetings.findUnique.mockResolvedValue({ book_guid: BOOK });
    meetings.delete.mockResolvedValue({ id: 7 });

    await expect(deleteMeeting(BOOK, 7)).resolves.toEqual({ deleted: true });
    expect(cleanup).toHaveBeenCalledWith(BOOK, 'membership_meeting', '7');
    expect(meetings.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(meetings.delete.mock.invocationCallOrder[0])
      .toBeLessThan(cleanup.mock.invocationCallOrder[0]);
  });

  it('leaves meeting links intact when the authoritative delete fails', async () => {
    meetings.findUnique.mockResolvedValue({ book_guid: BOOK });
    meetings.delete.mockRejectedValue(new Error('meeting delete failed'));

    await expect(deleteMeeting(BOOK, 7)).rejects.toThrow('meeting delete failed');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('reports successful meeting deletion when recoverable link cleanup fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    meetings.findUnique.mockResolvedValue({ book_guid: BOOK });
    meetings.delete.mockResolvedValue({ id: 7 });
    cleanup.mockRejectedValue(new Error('temporary cleanup failure'));

    await expect(deleteMeeting(BOOK, 7)).resolves.toEqual({ deleted: true });
    expect(warning).toHaveBeenCalledWith(
      'Failed to clean document links for deleted meeting 7:',
      expect.any(Error),
    );
    warning.mockRestore();
  });

  it('removes home-item target links while retaining the linked documents themselves', async () => {
    items.findUnique.mockResolvedValue({ id: 8, book_guid: BOOK, photos: [] });
    photos.findMany.mockResolvedValue([]);
    items.delete.mockResolvedValue({ id: 8 });

    await expect(deleteItem(BOOK, 8)).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledWith(BOOK, 'home_item', '8');
    expect(items.delete).toHaveBeenCalledWith({ where: { id: 8 } });
  });
});
