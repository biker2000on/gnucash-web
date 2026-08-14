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
 *          -> { terminal }                  retry budget is exhausted (409)
 *   complete(result)  stores the response so later replays can return it
 *   release()         records a retryable/terminal failure without erasing its
 *                     attempt budget
 */

import prisma from '@/lib/prisma';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * The two inbound endpoints do only local validation and one database write,
 * so five minutes is deliberately much longer than a healthy request. It
 * still lets a crash/redeploy recover on a provider retry without wedging the
 * event forever.
 */
export const WEBHOOK_CLAIM_STALE_MINUTES = 5;

/** Three total executions bound both stale-claim recovery and write failures. */
export const WEBHOOK_MAX_ATTEMPTS = 3;

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
            state VARCHAR(32) NOT NULL DEFAULT 'processing',
            attempts INTEGER NOT NULL DEFAULT 1,
            claim_started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            detail TEXT,
            completed_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          ALTER TABLE gnucash_web_webhook_idempotency
            ADD COLUMN IF NOT EXISTS state VARCHAR(32) NOT NULL DEFAULT 'processing';
          ALTER TABLE gnucash_web_webhook_idempotency
            ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE gnucash_web_webhook_idempotency
            ADD COLUMN IF NOT EXISTS claim_started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
          ALTER TABLE gnucash_web_webhook_idempotency
            ADD COLUMN IF NOT EXISTS detail TEXT;

          -- Existing completed rows remain completed; old in-flight rows get
          -- a conservative first-attempt timestamp from their original claim.
          UPDATE gnucash_web_webhook_idempotency
          SET state = CASE WHEN result IS NOT NULL OR completed_at IS NOT NULL
                           THEN 'completed' ELSE 'processing' END,
              attempts = GREATEST(COALESCE(attempts, 1), 1),
              claim_started_at = COALESCE(claim_started_at, created_at)
          WHERE state IS NULL OR attempts IS NULL OR claim_started_at IS NULL
             OR (state = 'processing' AND (result IS NOT NULL OR completed_at IS NOT NULL));

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
  | { status: 'claimed'; attempt: number }
  /** A previous request already used this key. `result` is null while it is still in flight. */
  | { status: 'replay'; result: unknown }
  | { status: 'terminal'; state: 'failed_permanent' | 'stalled'; attempts: number; detail: string | null };

/**
 * Take the claim for (book, endpoint, key). The UNIQUE index decides the
 * winner. A stale `processing` claim or retryable `failed` claim is reclaimed
 * only while its bounded attempt budget remains. An exhausted stale claim is
 * deliberately not rewritten: an overdue timeout is not proof the prior
 * worker died, and the read-only `stalled` state is operator-visible via
 * `listWebhookIdempotencyAttention`.
 */
export async function claimWebhookIdempotency(
  bookGuid: string,
  endpoint: WebhookEndpoint,
  key: string,
): Promise<WebhookClaim> {
  await ensureWebhookIdempotencyTable();

  const claimed = await prisma.$queryRaw<Array<{ attempts: number }>>`
    INSERT INTO gnucash_web_webhook_idempotency
      (book_guid, endpoint, idempotency_key, state, attempts, claim_started_at)
    VALUES (${bookGuid}, ${endpoint}, ${key}, 'processing', 1, NOW())
    ON CONFLICT (book_guid, endpoint, idempotency_key) DO UPDATE SET
      state = 'processing',
      attempts = gnucash_web_webhook_idempotency.attempts + 1,
      claim_started_at = NOW(),
      detail = 'Reclaimed after a stale claim or retryable write failure'
    WHERE gnucash_web_webhook_idempotency.result IS NULL
      AND gnucash_web_webhook_idempotency.attempts < ${WEBHOOK_MAX_ATTEMPTS}
      AND (
        gnucash_web_webhook_idempotency.state = 'failed'
        OR (
          gnucash_web_webhook_idempotency.state = 'processing'
          AND gnucash_web_webhook_idempotency.claim_started_at
              < (NOW() - ${WEBHOOK_CLAIM_STALE_MINUTES} * INTERVAL '1 minute')::timestamp
        )
      )
    RETURNING attempts
  `;
  if (claimed.length > 0) return { status: 'claimed', attempt: claimed[0].attempts ?? 1 };

  const existing = await prisma.$queryRaw<Array<{
    result: unknown; state: string; attempts: number; claim_started_at: Date; detail: string | null;
  }>>`
    SELECT result, state, attempts, claim_started_at, detail
    FROM gnucash_web_webhook_idempotency
    WHERE book_guid = ${bookGuid} AND endpoint = ${endpoint} AND idempotency_key = ${key}
    LIMIT 1
  `;
  const row = existing[0];
  if (row?.result !== null && row?.result !== undefined) {
    return { status: 'replay', result: row.result };
  }
  const stale = row?.state === 'processing'
    && (row.claim_started_at?.getTime?.() ?? 0)
      < Date.now() - WEBHOOK_CLAIM_STALE_MINUTES * 60_000;
  if (row && (row.state === 'failed_permanent' || (stale && row.attempts >= WEBHOOK_MAX_ATTEMPTS))) {
    return {
      status: 'terminal',
      state: row.state === 'failed_permanent' ? 'failed_permanent' : 'stalled',
      attempts: row.attempts,
      detail: row.detail,
    };
  }
  return { status: 'replay', result: null };
}

/** Store the response so later replays return it instead of re-doing the work. */
export async function completeWebhookIdempotency(
  bookGuid: string,
  endpoint: WebhookEndpoint,
  key: string,
  attempt: number,
  result: unknown,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE gnucash_web_webhook_idempotency
      SET result = ${JSON.stringify(result)}::jsonb, state = 'completed',
          completed_at = NOW(), detail = NULL
      WHERE book_guid = ${bookGuid} AND endpoint = ${endpoint} AND idempotency_key = ${key}
        AND result IS NULL AND state = 'processing' AND attempts = ${attempt}
    `;
  } catch (error) {
    // The write already succeeded; failing to record the response only costs a
    // replay the ability to return it (it still gets a 409, never a duplicate).
    console.error(`Failed to record idempotent result for ${endpoint}/${key}:`, error);
  }
}

/**
 * Record a failed attempt without touching a completed claim or a newer
 * claimant. The final attempt becomes the durable, operator-visible
 * `failed_permanent` state; earlier failures stay reclaimable.
 */
export async function releaseWebhookIdempotency(
  bookGuid: string,
  endpoint: WebhookEndpoint,
  key: string,
  attempt: number,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE gnucash_web_webhook_idempotency
      SET state = CASE WHEN attempts >= ${WEBHOOK_MAX_ATTEMPTS}
                         THEN 'failed_permanent' ELSE 'failed' END,
          detail = CASE WHEN attempts >= ${WEBHOOK_MAX_ATTEMPTS}
                        THEN 'Webhook write failed repeatedly; retry budget exhausted'
                        ELSE 'Webhook write failed; eligible for retry' END,
          completed_at = CASE WHEN attempts >= ${WEBHOOK_MAX_ATTEMPTS}
                              THEN NOW() ELSE completed_at END
      WHERE book_guid = ${bookGuid} AND endpoint = ${endpoint} AND idempotency_key = ${key}
        AND result IS NULL AND state = 'processing' AND attempts = ${attempt}
    `;
  } catch (error) {
    console.error(`Failed to release idempotency claim for ${endpoint}/${key}:`, error);
  }
}

export interface WebhookIdempotencyAttentionEntry {
  endpoint: WebhookEndpoint;
  idempotencyKey: string;
  state: 'failed_permanent' | 'stalled';
  attempts: number;
  detail: string | null;
  claimStartedAt: Date;
}

/**
 * Read-only operator attention list. It deliberately selects only terminal
 * failures and exhausted stale claims; neither can satisfy the claim predicate
 * above, so visibility cannot accidentally re-list work forever.
 */
export async function listWebhookIdempotencyAttention(
  bookGuid: string,
  limit = 50,
): Promise<WebhookIdempotencyAttentionEntry[]> {
  await ensureWebhookIdempotencyTable();
  const rows = await prisma.$queryRaw<Array<{
    endpoint: WebhookEndpoint; idempotency_key: string; state: string; attempts: number;
    detail: string | null; claim_started_at: Date;
  }>>`
    SELECT endpoint, idempotency_key, state, attempts, detail, claim_started_at
    FROM gnucash_web_webhook_idempotency
    WHERE book_guid = ${bookGuid}
      AND (
        state = 'failed_permanent'
        OR (
          state = 'processing' AND attempts >= ${WEBHOOK_MAX_ATTEMPTS}
          AND claim_started_at
              < (NOW() - ${WEBHOOK_CLAIM_STALE_MINUTES} * INTERVAL '1 minute')::timestamp
        )
      )
    ORDER BY claim_started_at DESC
    LIMIT ${Math.max(1, Math.min(Math.floor(limit), 100))}
  `;
  return rows.map(row => ({
    endpoint: row.endpoint,
    idempotencyKey: row.idempotency_key,
    state: row.state === 'failed_permanent' ? 'failed_permanent' : 'stalled',
    attempts: row.attempts,
    detail: row.detail,
    claimStartedAt: row.claim_started_at,
  }));
}
