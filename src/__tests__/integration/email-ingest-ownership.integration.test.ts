/**
 * Real-PostgreSQL cover for the email-ingest OWNERSHIP SNAPSHOT.
 *
 * The unit suite (src/lib/__tests__/email-ingest.test.ts) proves the module's
 * control flow against a fake store that MIRRORS the SQL, and pins the emitted
 * statement text. Neither can prove that Postgres actually behaves the way the
 * statement intends — and the two properties this feature rests on are pure SQL
 * semantics:
 *
 *   1. `ON CONFLICT ... DO UPDATE SET owner_user_id = COALESCE(existing, new)`
 *      really does keep the FIRST claim's attribution, so a manual retry after
 *      the sender allowlist was re-pointed cannot re-file somebody's mail into
 *      another user's book;
 *   2. the lazy DDL's backfill really does attribute only rows whose routing
 *      sender is PROVEN (single match, allowlist entry older than the message)
 *      and leaves everything else NULL.
 *
 * Both are exercised here against the tier's real database.
 *
 * TEST DATA: every row written is tagged with a per-run id and deleted in
 * afterAll, per the convention in vitest.integration.config.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool } from './db';

const RUN = randomUUID().slice(0, 8);
const key = (name: string) => `${RUN}-${name}@integration.test`;
const senderEmail = (name: string) => `${name}.${RUN}@integration.test`;

let ownerId = 0;
let strangerId = 0;

/** The module under test, imported after DATABASE_URL is pointed at the tier. */
type IngestModule = typeof import('@/lib/email-ingest');
let ingest: IngestModule;

async function insertUser(username: string): Promise<number> {
    const res = await getTestPool().query(
        `INSERT INTO gnucash_web_users (username, password_hash)
         VALUES ($1, 'x') RETURNING id`,
        [username],
    );
    return res.rows[0].id as number;
}

async function messageRow(messageKey: string) {
    const res = await getTestPool().query(
        `SELECT outcome, attempts, manual_retries, owner_user_id, owner_book_guid,
                owner_sender_id, owner_sender_email
         FROM gnucash_web_ingest_messages WHERE message_key = $1`,
        [messageKey],
    );
    return res.rows[0];
}

describe('email-ingest ownership snapshot (real Postgres)', () => {
    beforeAll(async () => {
        ingest = await import('@/lib/email-ingest');
        await ingest.ensureEmailIngestTables();
        ownerId = await insertUser(`ingest-owner-${RUN}`);
        strangerId = await insertUser(`ingest-stranger-${RUN}`);
    });

    afterAll(async () => {
        const pool = getTestPool();
        await pool.query('DELETE FROM gnucash_web_ingest_messages WHERE message_key LIKE $1', [`${RUN}-%`]);
        await pool.query('DELETE FROM gnucash_web_ingest_senders WHERE email LIKE $1', [`%.${RUN}@integration.test`]);
        await pool.query('DELETE FROM gnucash_web_users WHERE id = ANY($1::int[])', [[ownerId, strangerId]]);
    });

    it('creates the owner columns with ON DELETE SET NULL', async () => {
        const res = await getTestPool().query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'gnucash_web_ingest_messages'
               AND column_name IN ('owner_user_id','owner_book_guid','owner_sender_id',
                                   'owner_sender_email','manual_retries')`,
        );
        expect(res.rows.map(r => r.column_name).sort()).toEqual([
            'manual_retries', 'owner_book_guid', 'owner_sender_email',
            'owner_sender_id', 'owner_user_id',
        ]);
    });

    it('keeps the FIRST claim owner when a later claim arrives with a different one', async () => {
        const k = key('coalesce');
        const first = await ingest.claimIngestMessage({
            messageKey: k,
            fromEmail: senderEmail('alice'),
            subject: 'First',
            owner: { userId: ownerId, bookGuid: 'book-1', senderId: null, senderEmail: senderEmail('alice') },
        });
        expect(first?.owner).toMatchObject({ userId: ownerId, bookGuid: 'book-1' });

        // Re-arm it, then claim again with a DIFFERENT allowlist answer — the
        // exact sequence a manual retry after an allowlist edit produces.
        await getTestPool().query(
            `UPDATE gnucash_web_ingest_messages
             SET outcome = 'retry_requested' WHERE message_key = $1`,
            [k],
        );
        const second = await ingest.claimIngestMessage({
            messageKey: k,
            fromEmail: senderEmail('alice'),
            subject: 'Second',
            owner: { userId: strangerId, bookGuid: 'book-2', senderId: null, senderEmail: senderEmail('alice') },
        });

        // Postgres kept the original attribution, and the caller is handed it.
        expect(second?.owner).toMatchObject({ userId: ownerId, bookGuid: 'book-1' });
        expect(second?.manual).toBe(true);
        expect(await messageRow(k)).toMatchObject({
            owner_user_id: ownerId, owner_book_guid: 'book-1', attempts: 2,
        });
    });

    it('backfills only rows whose routing sender is proven', async () => {
        const pool = getTestPool();
        const processedAt = new Date('2026-01-15T12:00:00Z');

        // One allowlist entry, created BEFORE the message: proven.
        const provenSender = await pool.query(
            `INSERT INTO gnucash_web_ingest_senders (email, user_id, book_guid, created_at)
             VALUES ($1, $2, 'book-1', $3) RETURNING id`,
            [senderEmail('proven'), ownerId, new Date('2026-01-01T00:00:00Z')],
        );
        // One created AFTER the message: it cannot be the rule that routed it.
        await pool.query(
            `INSERT INTO gnucash_web_ingest_senders (email, user_id, book_guid, created_at)
             VALUES ($1, $2, 'book-9', $3)`,
            [senderEmail('late'), strangerId, new Date('2026-02-01T00:00:00Z')],
        );
        // Two entries that NORMALIZE to the same address (plus-tagging): the
        // match is ambiguous, so nothing may be inferred from it.
        await pool.query(
            `INSERT INTO gnucash_web_ingest_senders (email, user_id, book_guid, created_at)
             VALUES ($1, $2, 'book-1', $4), ($3, $2, 'book-2', $4)`,
            [
                senderEmail('ambiguous'),
                ownerId,
                senderEmail('ambiguous').replace('@', '+tag@'),
                new Date('2026-01-01T00:00:00Z'),
            ],
        );

        for (const [name, from] of [
            ['proven', senderEmail('proven')],
            ['late', senderEmail('late')],
            ['ambiguous', senderEmail('ambiguous')],
            ['unknown', senderEmail('nobody')],
        ] as const) {
            await pool.query(
                `INSERT INTO gnucash_web_ingest_messages
                   (message_key, from_email, subject, outcome, detail, ingested_count,
                    attempts, processed_at)
                 VALUES ($1, $2, 'Legacy', 'failed_permanent', 'legacy', 0, 1, $3)`,
                [key(`bf-${name}`), from, processedAt],
            );
        }

        // Force the lazy DDL (and its backfill) to run again on a fresh module
        // instance — the promise is memoized per module.
        vi.resetModules();
        const fresh = await import('@/lib/email-ingest');
        await fresh.ensureEmailIngestTables();

        expect(await messageRow(key('bf-proven'))).toMatchObject({
            owner_user_id: ownerId,
            owner_book_guid: 'book-1',
            owner_sender_id: provenSender.rows[0].id,
        });
        for (const name of ['late', 'ambiguous', 'unknown']) {
            expect(
                (await messageRow(key(`bf-${name}`))).owner_user_id,
                `${name} must stay unattributed`,
            ).toBeNull();
        }
    });

    it('refuses to re-arm a row with no owner snapshot, and honours the cap', async () => {
        const pool = getTestPool();
        const stale = new Date(Date.now() - 60 * 60_000);

        const unowned = await pool.query(
            `INSERT INTO gnucash_web_ingest_messages
               (message_key, from_email, subject, outcome, detail, ingested_count,
                attempts, processed_at)
             VALUES ($1, $2, 'Unowned', 'failed_permanent', 'boom', 0, 1, $3)
             RETURNING id`,
            [key('unowned'), senderEmail('nobody'), stale],
        );
        const owned = await pool.query(
            `INSERT INTO gnucash_web_ingest_messages
               (message_key, from_email, subject, outcome, detail, ingested_count,
                attempts, processed_at, owner_user_id, owner_book_guid, manual_retries)
             VALUES ($1, $2, 'Owned', 'failed_permanent', 'boom', 0, 1, $3, $4, 'book-1', $5)
             RETURNING id`,
            [key('spent'), senderEmail('alice'), stale, ownerId, ingest.INGEST_MAX_MANUAL_RETRIES],
        );

        await expect(ingest.requestIngestRetry(unowned.rows[0].id, ownerId))
            .resolves.toEqual({ ok: false, reason: 'not_found' });
        await expect(ingest.requestIngestRetry(owned.rows[0].id, ownerId))
            .resolves.toMatchObject({ ok: false, reason: 'not_retriable' });

        // Nothing was re-armed, so nothing will be re-fetched.
        expect(await ingest.listRetryRequestedKeys()).not.toContain(key('unowned'));
        expect(await ingest.listRetryRequestedKeys()).not.toContain(key('spent'));
    });
});
