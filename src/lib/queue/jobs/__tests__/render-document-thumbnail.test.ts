import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRow: vi.fn(),
  setState: vi.fn(),
  listPending: vi.fn(),
  storageGet: vi.fn(),
  storagePut: vi.fn(),
  render: vi.fn(),
  enqueue: vi.fn(),
  tryLock: vi.fn(),
}));

vi.mock('@/lib/documents/thumbnail-store', () => ({
  getDocumentThumbnail: mocks.getRow,
  setDocumentThumbnailState: mocks.setState,
  listDocumentsNeedingThumbnails: mocks.listPending,
}));
vi.mock('@/lib/storage/storage-backend', () => ({
  getStorageBackend: vi.fn(async () => ({
    get: mocks.storageGet,
    put: mocks.storagePut,
  })),
}));
vi.mock('@/lib/documents/thumbnail', () => ({
  renderDocumentThumbnail: mocks.render,
  documentThumbnailKeyFrom: (key: string) => `${key}_thumb.webp`,
}));
vi.mock('@/lib/queue/queues', () => ({ enqueueJob: mocks.enqueue }));
vi.mock('@/lib/db', () => ({
  tryWithDatabaseAdvisoryLock: mocks.tryLock,
}));

import {
  enqueueDocumentThumbnail,
  enqueueMissingDocumentThumbnails,
  handleRenderDocumentThumbnail,
  renderEntityDocumentThumbnail,
} from '../render-document-thumbnail';

const BOOK = 'b'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRow.mockResolvedValue({
    id: 9,
    bookGuid: BOOK,
    fileKey: 'entity-documents/a.pdf',
    mimeType: 'application/pdf',
    thumbnailStatus: null,
    thumbnailKey: null,
  });
  mocks.storageGet.mockResolvedValue(Buffer.from('%PDF'));
  mocks.render.mockResolvedValue(Buffer.from('WEBP'));
  mocks.setState.mockResolvedValue(undefined);
  mocks.tryLock.mockImplementation(async (_name: string, op: () => Promise<unknown>) => ({
    acquired: true,
    result: await op(),
  }));
});

describe('renderEntityDocumentThumbnail', () => {
  it('stores a webp beside the source and marks complete', async () => {
    const status = await renderEntityDocumentThumbnail(9, BOOK);
    expect(status).toBe('complete');
    expect(mocks.storagePut).toHaveBeenCalledWith(
      'entity-documents/a.pdf_thumb.webp',
      expect.any(Buffer),
      'image/webp',
    );
    expect(mocks.setState).toHaveBeenLastCalledWith(
      BOOK, 9, 'complete', 'entity-documents/a.pdf_thumb.webp',
    );
  });

  it('marks failed when rasterization returns null, without throwing', async () => {
    mocks.render.mockResolvedValue(null);
    await expect(renderEntityDocumentThumbnail(9, BOOK)).resolves.toBe('failed');
    expect(mocks.setState).toHaveBeenLastCalledWith(BOOK, 9, 'failed', null);
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it('marks failed for a malformed storage read, without throwing', async () => {
    mocks.storageGet.mockRejectedValue(new Error('truncated pdf'));
    await expect(renderEntityDocumentThumbnail(9, BOOK)).resolves.toBe('failed');
    expect(mocks.setState).toHaveBeenLastCalledWith(BOOK, 9, 'failed', null);
  });

  it('skips a document that already has a complete thumbnail', async () => {
    mocks.getRow.mockResolvedValue({
      id: 9,
      bookGuid: BOOK,
      fileKey: 'entity-documents/a.pdf',
      mimeType: 'application/pdf',
      thumbnailStatus: 'complete',
      thumbnailKey: 'entity-documents/a_thumb.webp',
    });
    await expect(renderEntityDocumentThumbnail(9, BOOK)).resolves.toBe('skipped');
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it('skips a missing book-scoped row', async () => {
    mocks.getRow.mockResolvedValue(null);
    await expect(renderEntityDocumentThumbnail(9, BOOK)).resolves.toBe('skipped');
  });
});

describe('handleRenderDocumentThumbnail', () => {
  it('never throws on a malformed payload', async () => {
    await expect(handleRenderDocumentThumbnail({
      data: { documentId: 'nope', bookGuid: BOOK },
    } as never)).resolves.toBeUndefined();
  });
});

describe('enqueueDocumentThumbnail', () => {
  it('enqueues without rendering when the queue is up', async () => {
    mocks.enqueue.mockResolvedValue('job-1');
    await enqueueDocumentThumbnail(9, BOOK);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it('leaves the row pending instead of rendering inline on a request path', async () => {
    // M7: a Redis outage must not turn an upload request into a PDF raster.
    mocks.enqueue.mockResolvedValue(null);
    await enqueueDocumentThumbnail(9, BOOK);
    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.storagePut).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
  });

  it('still renders inline for a caller that is already the worker', async () => {
    mocks.enqueue.mockResolvedValue(null);
    await enqueueDocumentThumbnail(9, BOOK, { allowInline: true });
    expect(mocks.storagePut).toHaveBeenCalled();
    expect(mocks.setState).toHaveBeenLastCalledWith(
      BOOK, 9, 'complete', 'entity-documents/a.pdf_thumb.webp',
    );
  });
});

describe('enqueueMissingDocumentThumbnails', () => {
  it('enqueues one job per pending document under the advisory lock', async () => {
    mocks.listPending.mockResolvedValue({
      documents: [
        { id: 1, bookGuid: BOOK },
        { id: 2, bookGuid: BOOK },
      ],
      remaining: 0,
    });
    mocks.enqueue.mockResolvedValue('job-1');
    await expect(enqueueMissingDocumentThumbnails()).resolves.toBe(2);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'render-document-thumbnail',
      { documentId: 1, bookGuid: BOOK },
      { jobId: 'render-document-thumbnail:1' },
    );
  });

  it('only enqueues the bounded batch and logs the remainder for the next pass', async () => {
    // CODEX-7: the backfill must not materialize/flood the whole vault.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.listPending.mockResolvedValue({
      documents: [{ id: 1, bookGuid: BOOK }, { id: 2, bookGuid: BOOK }],
      remaining: 4_800,
    });
    mocks.enqueue.mockResolvedValue('job-1');
    await expect(enqueueMissingDocumentThumbnails()).resolves.toBe(2);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('4800'));
    log.mockRestore();
  });

  it('is a no-op when another process holds the lock', async () => {
    mocks.tryLock.mockResolvedValue({ acquired: false });
    await expect(enqueueMissingDocumentThumbnails()).resolves.toBe(0);
    expect(mocks.listPending).not.toHaveBeenCalled();
  });
});
