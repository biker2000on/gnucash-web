/**
 * `Promise.race` cannot cancel the losing `queue.add`. A slow-but-successful
 * enqueue therefore used to have BOTH the worker and the request run the job:
 * two `runStatementExtraction` calls, two `replaceLines`, and the PDF sent to
 * the paid AI provider twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
  getBullMQConnection: vi.fn(),
  QueueCtor: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.add;
    getJob = mocks.getJob;
    constructor(...args: unknown[]) {
      mocks.QueueCtor(...args);
    }
  },
}));
vi.mock('../../redis', () => ({ getBullMQConnection: mocks.getBullMQConnection }));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.useFakeTimers();
  mocks.getBullMQConnection.mockReturnValue({ host: 'localhost', port: 6379 });
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadQueues() {
  return import('../queues');
}

describe('enqueueJob', () => {
  it('applies retries with backoff so a transient error cannot lose the job', async () => {
    mocks.add.mockResolvedValue({ id: 'job-1' });
    const { enqueueJob } = await loadQueues();

    await expect(enqueueJob('refresh-prices', { bookGuid: 'b' })).resolves.toBe('job-1');

    const options = mocks.add.mock.calls[0][2];
    expect(options.attempts).toBeGreaterThan(1);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 5_000 });
  });

  it('opts jobs that own their failure handling out of the generic retries', async () => {
    mocks.add.mockResolvedValue({ id: 'job-2' });
    const { enqueueExtractStatement, enqueueJob } = await loadQueues();

    // Statement extraction has its own durable recovery ledger and a retry
    // costs a paid AI call.
    await enqueueExtractStatement({ batchId: 7 });
    expect(mocks.add.mock.calls[0][2].attempts).toBe(1);

    // SimpleFin sync persists its own status + user notification on failure;
    // retrying would raise that notification once per attempt.
    await enqueueJob('sync-simplefin', { connectionId: 1 });
    expect(mocks.add.mock.calls[1][2].attempts).toBe(1);
  });

  it('lets an explicit caller option win over the per-job override', async () => {
    mocks.add.mockResolvedValue({ id: 'job-3' });
    const { enqueueExtractStatement } = await loadQueues();

    await enqueueExtractStatement({ batchId: 7 }, { attempts: 2 });

    expect(mocks.add.mock.calls[0][2].attempts).toBe(2);
  });

  it('does NOT report failure when a timed-out enqueue actually landed', async () => {
    // add never settles within the timeout window, but the job exists.
    mocks.add.mockReturnValue(new Promise(() => {}));
    mocks.getJob.mockResolvedValue({ id: 'extract-statement:9' });

    const { enqueueJob } = await loadQueues();
    const pending = enqueueJob('extract-statement', { batchId: 9 }, {
      jobId: 'extract-statement:9',
    });
    await vi.advanceTimersByTimeAsync(6_000);

    // A job id means "the worker has it" — the caller must NOT run it inline.
    await expect(pending).resolves.toBe('extract-statement:9');
    expect(mocks.getJob).toHaveBeenCalledWith('extract-statement:9');
  });

  it('falls back to inline (undefined) when the job genuinely is not queued', async () => {
    mocks.add.mockReturnValue(new Promise(() => {}));
    mocks.getJob.mockResolvedValue(null);

    const { enqueueJob } = await loadQueues();
    const pending = enqueueJob('extract-statement', { batchId: 9 }, {
      jobId: 'extract-statement:9',
    });
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(pending).resolves.toBeUndefined();
  });

  it('falls back to inline when Redis is unreachable for the lookup too', async () => {
    mocks.add.mockReturnValue(new Promise(() => {}));
    mocks.getJob.mockReturnValue(new Promise(() => {}));

    const { enqueueJob } = await loadQueues();
    const pending = enqueueJob('extract-statement', { batchId: 9 }, {
      jobId: 'extract-statement:9',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBeUndefined();
  });

  it('returns undefined without touching the queue when Redis is not configured', async () => {
    mocks.getBullMQConnection.mockReturnValue(null);
    const { enqueueJob } = await loadQueues();
    await expect(enqueueJob('refresh-prices')).resolves.toBeUndefined();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
