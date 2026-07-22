/**
 * Job-progress bus — pure helpers + no-Redis no-op behavior.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(() => null),
}));

import {
  buildJobProgressEvent,
  jobProgressChannels,
  jobProgressEmitter,
  publishJobProgress,
} from '../job-progress';
import { getRedis } from '@/lib/redis';

describe('jobProgressChannels', () => {
  it('scopes to user and book, mirroring the notification channel scheme', () => {
    expect(jobProgressChannels(7, 'b'.repeat(32))).toEqual([
      `job-progress:user:7`,
      `job-progress:book:${'b'.repeat(32)}`,
    ]);
  });
});

describe('buildJobProgressEvent', () => {
  it('stamps ts when missing and preserves an explicit one', () => {
    const stamped = buildJobProgressEvent({
      jobId: '1',
      kind: 'sync-simplefin',
      bookGuid: 'b'.repeat(32),
      source: 'manual',
      status: 'running',
      label: 'SimpleFin sync',
    });
    expect(stamped.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const explicit = buildJobProgressEvent({
      jobId: '1',
      kind: 'sync-simplefin',
      bookGuid: 'b'.repeat(32),
      source: 'manual',
      status: 'running',
      label: 'SimpleFin sync',
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(explicit.ts).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('publishJobProgress', () => {
  it('is a silent no-op without Redis', async () => {
    const ok = await publishJobProgress({
      jobId: '1',
      kind: 'refresh-prices',
      bookGuid: 'b'.repeat(32),
      source: 'manual',
      status: 'completed',
      label: 'Price refresh',
    });
    expect(ok).toBe(false);
  });

  it('publishes to the book channel, and the user channel when userId is set', async () => {
    const publish = vi.fn<(channel: string, payload: string) => Promise<number>>().mockResolvedValue(1);
    vi.mocked(getRedis).mockReturnValueOnce({ publish } as never);
    const ok = await publishJobProgress({
      jobId: '9',
      kind: 'sync-simplefin',
      bookGuid: 'b'.repeat(32),
      userId: 3,
      source: 'manual',
      status: 'progress',
      label: 'SimpleFin sync',
      percent: 40,
    });
    expect(ok).toBe(true);
    const channels = publish.mock.calls.map((c: unknown[]) => c[0]);
    expect(channels).toEqual([`job-progress:book:${'b'.repeat(32)}`, 'job-progress:user:3']);
    const payload = JSON.parse(publish.mock.calls[0][1] as string);
    expect(payload).toMatchObject({ jobId: '9', status: 'progress', percent: 40 });
  });

  it('never throws when publish fails', async () => {
    const publish = vi.fn(async () => {
      throw new Error('boom');
    });
    vi.mocked(getRedis).mockReturnValueOnce({ publish } as never);
    await expect(
      publishJobProgress({
        jobId: '1',
        kind: 'x',
        bookGuid: 'b'.repeat(32),
        source: 'scheduled',
        status: 'failed',
        label: 'X',
        error: 'y',
      }),
    ).resolves.toBe(false);
  });
});

describe('jobProgressEmitter', () => {
  it('binds identity fields across all event types', async () => {
    const publish = vi.fn<(channel: string, payload: string) => Promise<number>>().mockResolvedValue(1);
    vi.mocked(getRedis).mockReturnValue({ publish } as never);
    const emit = jobProgressEmitter({
      jobId: '42',
      kind: 'scrub-all-lots',
      bookGuid: 'b'.repeat(32),
      source: 'manual',
      label: 'Scrub all lots',
    });
    await emit.running('starting');
    await emit.progress({ current: 2, total: 10, percent: 20 });
    await emit.completed({ scrubbed: 10 });
    await emit.failed('nope');
    const statuses = publish.mock.calls
      .filter((c: unknown[]) => (c[0] as string).startsWith('job-progress:book:'))
      .map((c: unknown[]) => JSON.parse(c[1] as string).status);
    expect(statuses).toEqual(['running', 'progress', 'completed', 'failed']);
    vi.mocked(getRedis).mockReset();
    vi.mocked(getRedis).mockReturnValue(null);
  });
});
