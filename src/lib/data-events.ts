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
import { cacheInvalidateAllForBook, cacheInvalidateFrom } from '@/lib/cache';

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
/**
 * One-call freshness for any path that writes ledger data: invalidates the
 * book's Redis metric/report caches (which live up to 24h on event-driven
 * eviction) and publishes a data-change event per entity so open UIs refetch.
 *
 * Call it after a successful commit from ANY process — web routes, webhooks,
 * and worker crons alike. Fire-and-forget by design: it never throws and the
 * caller must not await it on the request's critical path.
 *
 * Pass `fromDate` (earliest affected post date) to keep cached history before
 * that date warm; omit it to drop everything for the book.
 */
export function afterLedgerWrite(
  bookGuid: string,
  entities: DataChangeEntity | DataChangeEntity[],
  opts?: { guid?: string; action?: DataChangeEvent['action']; fromDate?: Date },
): void {
  if (!bookGuid) return;
  const list = Array.isArray(entities) ? entities : [entities];
  void (opts?.fromDate
    ? cacheInvalidateFrom(bookGuid, opts.fromDate)
    : cacheInvalidateAllForBook(bookGuid)
  ).catch(() => {});
  for (const entity of list) {
    void publishDataChange(bookGuid, entity, opts);
  }
}

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
