/**
 * Data-change bus — Redis pub/sub events for cross-user freshness.
 *
 * Mutating API routes call publishDataChange after a successful commit; the
 * SSE relay at /api/data-events/stream forwards each event to every browser
 * viewing the same book, where DataEventsProvider invalidates React Query
 * caches and re-dispatches a `gnucash:data-change` window CustomEvent for
 * non-React-Query pages.
 *
 * Channel scheme mirrors job-progress (src/lib/job-progress.ts):
 *   data-change:book:{bookGuid}
 *
 * Publishing is strictly fire-and-forget: without Redis every publish is a
 * silent no-op, and failures are swallowed with a warn — a freshness hint
 * must never fail the write it describes.
 */

import { getRedis } from '@/lib/redis';

export type DataChangeEntity =
  | 'transactions'
  | 'accounts'
  | 'budgets'
  | 'schedules'
  | 'reconciliation'
  | 'prices'
  | 'business'
  | 'book';

export interface DataChangeEvent {
  entity: DataChangeEntity;
  bookGuid: string;
  /** GUID of the changed row when cheap to include (tx guid, account guid, …). */
  guid?: string;
  /** What happened, when cheap to include. */
  action?: 'create' | 'update' | 'delete' | 'bulk';
  /** ISO timestamp. */
  ts: string;
}

export function dataChangeChannel(bookGuid: string): string {
  return `data-change:book:${bookGuid}`;
}

/**
 * Publish a data-change event for a book. Never throws, never rejects;
 * resolves false when Redis is unavailable or the publish failed.
 */
export async function publishDataChange(
  bookGuid: string,
  entity: DataChangeEntity,
  opts?: { guid?: string; action?: DataChangeEvent['action'] },
): Promise<boolean> {
  try {
    const redis = getRedis();
    if (!redis || !bookGuid) return false;
    const event: DataChangeEvent = {
      entity,
      bookGuid,
      guid: opts?.guid,
      action: opts?.action,
      ts: new Date().toISOString(),
    };
    await redis.publish(dataChangeChannel(bookGuid), JSON.stringify(event));
    return true;
  } catch (error) {
    console.warn(
      'data-change publish failed:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
