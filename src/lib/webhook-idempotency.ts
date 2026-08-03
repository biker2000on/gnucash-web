/**
 * Inbound-webhook idempotency.
 *
 * The convenience endpoints under /api/webhooks/inbound/* are called by
 * automation tools (n8n, Home Assistant, shell scripts) that retry on
 * timeout. Each request previously minted a fresh GUID, so a retry after a
 * slow-but-successful call posted a SECOND identical ledger entry or dues
 * payment. The write itself was atomic; nothing made it idempotent.
 *
 * The guarantee here is enforced by the DATABASE, not by an application
 * check: the claim is an `INSERT ... ON CONFLICT DO NOTHING` against a UNIQUE
 * index (created in db-init.ts), exactly like the `uq_transactions_autofund_num`
 * dedupe key used by the funding sweep. Two concurrent replays cannot both win
 * the claim, so the second is rejected by Postgres rather than by a racy SELECT.
 *
 * Lifecycle:
 *   claim  -> 'claimed'                    caller proceeds with the write
 *          -> { replayOf: <stored result> } caller returns the original result
 *          -> { replayOf: null }            original still in flight (409)
 *   complete(result)  stores the response so later replays can return it
 *   release()         drops the claim after a FAILED write, so a genuine retry
 *                     can proceed (a failure must not burn the key)
 */

import prisma from '@/lib/prisma';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/** Endpoints get their own key namespace so unrelated callers cannot collide. */
export type WebhookEndpoint = 'transaction' | 'membership-payment';

let ensurePromise: Promise<void> | null = null;

/**
 * Lazily create the table. db-init.ts also creates it at startup; this makes
 * the routes work on a dev database that has not been through db-init yet.
 * The memo resets on failure so one transient error cannot disable webhook
 * idempotency for the life of the process.
 */
export function ensureWebhookIdempotencyTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_webhook_idempotency_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_webhook_idempotency (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            endpoint VARCHAR(64) NOT NULL,
            idempotency_key VARCHAR(200) NOT NULL,
            result JSONB,
            completed_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_idempotency
            ON gnucash_web_webhook_idempotency (book_guid, endpoint, idempotency_key);
        END $$;
      `);
    })();
    ensurePromise.catch(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

/**
 * Read the caller-supplied idempotency key from the `Idempotency-Key` header
 * or an `idempotencyKey` field in the JSON body (header wins). Returns null
 * when absent; an over-long or non-string value is rejected by the caller via
 * {@link validateIdempotencyKey}.
 */
export function readIdempotencyKey(headerValue: string | null, body: unknown): unknown {
  if (headerValue !== null && headerValue !== undefined) return headerValue;
  if (body && typeof body === 'object' && 'idempotencyKey' in body) {
    const raw = (body as { idempotencyKey?: unknown }).idempotencyKey;
    if (raw === null || raw === undefined) return null;
    return raw;
  }
  return null;
}

export type IdempotencyKeyValidation =
  | { ok: true; key: string | null }
  | { ok: false; error: string };

/** Validate a raw key value. `null`/absent is allowed (idempotency opt-in). */
export function validateIdempotencyKey(raw: unknown): IdempotencyKeyValidation {
  if (raw === null || raw === undefined) return { ok: true, key: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'idempotencyKey: must be a string' };
  }
  const key = raw.trim();
  if (key.length === 0) {
    return { ok: false, error: 'idempotencyKey: must not be empty' };
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      ok: false,
      error: `idempotencyKey: must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, key };
}

export type WebhookClaim =
  | { status: 'claimed' }
  /** A previous request already used this key. `result` is null while it is still in flight. */
  | { status: 'replay'; result: unknown };

/**
 * Take the claim for (book, endpoint, key). The UNIQUE index decides the
 * winner; the loser gets the stored result of the original request.
 */
export async function claimWebhookIdempotency(
  bookGuid: string,
  endpoint: WebhookEndpoint,
  key: string,
): Promise<WebhookClaim> {
  await ensureWebhookIdempotencyTable();

  const inserted = await prisma.$queryRaw<Array<{ id: number }>>`
    INSERT INTO gnucash_web_webhook_idempotency (book_guid, endpoint, idempotency_key)
    VALUES (${bookGuid}, ${endpoint}, ${key})
    ON CONFLICT (book_guid, endpoint, idempotency_key) DO NOTHING
    RETURNING id
  `;
  if (inserted.length > 0) return { status: 'claimed' };

  const existing = await prisma.$queryRaw<Array<{ result: unknown }>>`
    SELECT result FROM gnucash_web_webhook_idempotency
    WHERE book_guid = ${bookGuid} AND endpoint = ${endpoint} AND idempotency_key = ${key}
    LIMIT 1
  `;
  return { status: 'replay', result: existing[0]?.result ?? null };
}

/** Store the response so later replays return it instead of re-doing the work. */
export async function completeWebhookIdempotency(
  bookGuid: string,
  endpoint: WebhookEndpoint,
  key: string,
  result: unknown,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE gnucash_web_webhook_idempotency
      SET result = ${JSON.stringify(result)}::jsonb, completed_at = NOW()
      WHERE book_guid = ${bookGuid} AND endpoint = ${endpoint} AND idempotency_key = ${key}
    `;
  } catch (error) {
    // The write already succeeded; failing to record the response only costs a
    // replay the ability to return it (it still gets a 409, never a duplicate).
    console.error(`Failed to record idempotent result for ${endpoint}/${key}:`, error);
  }
}

/**
 * Drop the claim after a FAILED write so a genuine retry can proceed. Scoped
 * to rows with no stored result, so it can never delete a completed claim.
 */
export async function releaseWebhookIdempotency(
  bookGuid: string,
  endpoint: WebhookEndpoint,
  key: string,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      DELETE FROM gnucash_web_webhook_idempotency
      WHERE book_guid = ${bookGuid} AND endpoint = ${endpoint} AND idempotency_key = ${key}
        AND completed_at IS NULL
    `;
  } catch (error) {
    console.error(`Failed to release idempotency claim for ${endpoint}/${key}:`, error);
  }
}
