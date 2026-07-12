/**
 * Outbound Webhooks
 *
 * User-configured HTTP endpoints that receive a signed JSON POST whenever a
 * matching in-app notification is created. Payloads are signed with
 * HMAC-SHA256 (header `X-GnucashWeb-Signature: sha256=<hex>`) using the
 * per-webhook secret so receivers can verify authenticity.
 *
 * Wire-up: call `deliverWebhooks(notification)` from the notification
 * creation path (fire-and-forget). This module never throws from delivery.
 */

import { createHmac, randomBytes } from 'node:crypto';
import prisma from '@/lib/prisma';

export interface WebhookRecord {
    id: number;
    userId: number;
    bookGuid: string | null;
    url: string;
    secret: string;
    events: 'all' | string[];
    enabled: boolean;
    createdAt: Date;
    lastStatus: string | null;
    lastDeliveredAt: Date | null;
}

/** Shape of the notification payload delivered to webhook endpoints. */
export interface WebhookNotification {
    id: number;
    userId: number;
    bookGuid: string | null;
    type: string;
    severity: string;
    title: string;
    message: string | null;
    href: string | null;
    createdAt: Date | string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Generate a webhook signing secret (shown in the UI, stored server-side). */
export function generateWebhookSecret(): string {
    return 'whsec_' + randomBytes(24).toString('hex');
}

/** HMAC-SHA256 signature of a raw body, formatted `sha256=<hex>`. */
export function signPayload(secret: string, rawBody: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Does a webhook's event filter match a notification type? */
export function eventMatches(events: 'all' | string[], type: string): boolean {
    if (events === 'all') return true;
    return events.includes(type);
}

/** Parse the `events` column ('all' or a JSON array of type strings). */
export function parseEvents(raw: string | null): 'all' | string[] {
    if (!raw || raw === 'all') return 'all';
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.filter((e): e is string => typeof e === 'string');
        }
    } catch {
        // fall through
    }
    return 'all';
}

/** Serialize an events filter for storage. */
export function serializeEvents(events: 'all' | string[]): string {
    return events === 'all' ? 'all' : JSON.stringify(events);
}

const PRIVATE_HOST_PATTERNS: RegExp[] = [
    /^localhost$/i,
    /\.localhost$/i,
    /\.local$/i,
    /\.internal$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./, // link-local (incl. cloud metadata endpoints)
    /^\[?::1\]?$/,
    /^\[?f[cd][0-9a-f]{2}:/i, // IPv6 ULA fc00::/7
    /^\[?fe80:/i, // IPv6 link-local
];

/**
 * Validate a webhook target URL. Only http/https; private, loopback, and
 * link-local hosts are rejected unless `allowInternal` is set (self-hosted
 * users often target LAN services intentionally).
 *
 * Note: this checks the URL's literal hostname only; it does not resolve DNS,
 * so a public name pointing at a private IP is not caught here.
 */
export function validateWebhookUrl(
    url: string,
    options: { allowInternal?: boolean } = {}
): { ok: true } | { ok: false; error: string } {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: 'Invalid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'URL must use http or https' };
    }
    if (!parsed.hostname) {
        return { ok: false, error: 'URL must include a host' };
    }
    if (!options.allowInternal) {
        const host = parsed.hostname;
        if (PRIVATE_HOST_PATTERNS.some(p => p.test(host))) {
            return {
                ok: false,
                error: 'URL points at a private/internal host. Enable "allow internal" to permit this.',
            };
        }
    }
    return { ok: true };
}

/** Build the exact JSON body delivered for a notification. */
export function buildWebhookBody(notification: WebhookNotification): string {
    return JSON.stringify({
        id: notification.id,
        type: notification.type,
        severity: notification.severity,
        title: notification.title,
        message: notification.message,
        href: notification.href,
        bookGuid: notification.bookGuid,
        createdAt:
            notification.createdAt instanceof Date
                ? notification.createdAt.toISOString()
                : notification.createdAt,
    });
}

// ---------------------------------------------------------------------------
// Lazy table creation (advisory-lock pattern, same as notifications.ts)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureWebhooksTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_webhooks_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_webhooks (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
                    book_guid VARCHAR(32),
                    url TEXT NOT NULL,
                    secret VARCHAR(128) NOT NULL,
                    events TEXT NOT NULL DEFAULT 'all',
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    last_status VARCHAR(255),
                    last_delivered_at TIMESTAMP
                  );

                  CREATE INDEX IF NOT EXISTS idx_webhooks_user
                    ON gnucash_web_webhooks(user_id, created_at DESC);
                END $$;
            `);
        })();
        ensurePromise.catch(() => { ensurePromise = null; });
    }
    return ensurePromise;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

interface WebhookRow {
    id: number;
    user_id: number;
    book_guid: string | null;
    url: string;
    secret: string;
    events: string | null;
    enabled: boolean;
    created_at: Date;
    last_status: string | null;
    last_delivered_at: Date | null;
}

function rowToRecord(row: WebhookRow): WebhookRecord {
    return {
        id: row.id,
        userId: row.user_id,
        bookGuid: row.book_guid,
        url: row.url,
        secret: row.secret,
        events: parseEvents(row.events),
        enabled: row.enabled,
        createdAt: row.created_at,
        lastStatus: row.last_status,
        lastDeliveredAt: row.last_delivered_at,
    };
}

export async function listWebhooks(userId: number, bookGuid?: string | null): Promise<WebhookRecord[]> {
    await ensureWebhooksTable();
    const rows = bookGuid
        ? await prisma.$queryRaw<WebhookRow[]>`
            SELECT id, user_id, book_guid, url, secret, events, enabled,
                   created_at, last_status, last_delivered_at
            FROM gnucash_web_webhooks
            WHERE user_id = ${userId} AND (book_guid IS NULL OR book_guid = ${bookGuid})
            ORDER BY created_at DESC`
        : await prisma.$queryRaw<WebhookRow[]>`
            SELECT id, user_id, book_guid, url, secret, events, enabled,
                   created_at, last_status, last_delivered_at
            FROM gnucash_web_webhooks
            WHERE user_id = ${userId}
            ORDER BY created_at DESC`;
    return rows.map(rowToRecord);
}

export async function getWebhook(userId: number, id: number): Promise<WebhookRecord | null> {
    await ensureWebhooksTable();
    const rows = await prisma.$queryRaw<WebhookRow[]>`
        SELECT id, user_id, book_guid, url, secret, events, enabled,
               created_at, last_status, last_delivered_at
        FROM gnucash_web_webhooks
        WHERE id = ${id} AND user_id = ${userId}
        LIMIT 1`;
    return rows[0] ? rowToRecord(rows[0]) : null;
}

export interface CreateWebhookInput {
    bookGuid?: string | null;
    url: string;
    secret?: string;
    events?: 'all' | string[];
    enabled?: boolean;
}

export async function createWebhook(userId: number, input: CreateWebhookInput): Promise<WebhookRecord> {
    await ensureWebhooksTable();
    const secret = input.secret?.trim() || generateWebhookSecret();
    const events = serializeEvents(input.events ?? 'all');
    const enabled = input.enabled !== false;

    const rows = await prisma.$queryRaw<WebhookRow[]>`
        INSERT INTO gnucash_web_webhooks (user_id, book_guid, url, secret, events, enabled)
        VALUES (${userId}, ${input.bookGuid || null}, ${input.url}, ${secret}, ${events}, ${enabled})
        RETURNING id, user_id, book_guid, url, secret, events, enabled,
                  created_at, last_status, last_delivered_at`;
    return rowToRecord(rows[0]);
}

export interface UpdateWebhookInput {
    url?: string;
    secret?: string;
    events?: 'all' | string[];
    enabled?: boolean;
}

export async function updateWebhook(
    userId: number,
    id: number,
    input: UpdateWebhookInput
): Promise<WebhookRecord | null> {
    const existing = await getWebhook(userId, id);
    if (!existing) return null;

    const url = input.url ?? existing.url;
    const secret = input.secret?.trim() || existing.secret;
    const events = serializeEvents(input.events ?? existing.events);
    const enabled = input.enabled ?? existing.enabled;

    const rows = await prisma.$queryRaw<WebhookRow[]>`
        UPDATE gnucash_web_webhooks
        SET url = ${url}, secret = ${secret}, events = ${events}, enabled = ${enabled}
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING id, user_id, book_guid, url, secret, events, enabled,
                  created_at, last_status, last_delivered_at`;
    return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function deleteWebhook(userId: number, id: number): Promise<boolean> {
    await ensureWebhooksTable();
    const count = await prisma.$executeRaw`
        DELETE FROM gnucash_web_webhooks
        WHERE id = ${id} AND user_id = ${userId}`;
    return count > 0;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const DELIVERY_TIMEOUT_MS = 5000;

async function postOnce(url: string, body: string, headers: Record<string, string>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
            redirect: 'error',
        });
        return String(res.status);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Deliver one webhook: POST the signed body, one retry on failure, record the
 * last status. Never throws.
 */
export async function deliverToWebhook(
    webhook: Pick<WebhookRecord, 'id' | 'url' | 'secret'>,
    notification: WebhookNotification
): Promise<string> {
    const body = buildWebhookBody(notification);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'GnuCash-Web-Webhook/1.0',
        'X-GnucashWeb-Event': notification.type,
        'X-GnucashWeb-Signature': signPayload(webhook.secret, body),
    };

    let status: string;
    try {
        status = await postOnce(webhook.url, body, headers);
        if (Number(status) >= 400) {
            // One retry on HTTP error responses too.
            status = await postOnce(webhook.url, body, headers).catch(
                (e: unknown) => `error: ${e instanceof Error ? e.message : 'request failed'}`
            );
        }
    } catch {
        // Network error / timeout — one retry.
        try {
            status = await postOnce(webhook.url, body, headers);
        } catch (e) {
            status = `error: ${e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : 'request failed'}`;
        }
    }

    try {
        await prisma.$executeRaw`
            UPDATE gnucash_web_webhooks
            SET last_status = ${status.slice(0, 255)}, last_delivered_at = NOW()
            WHERE id = ${webhook.id}`;
    } catch {
        // best-effort bookkeeping
    }
    return status;
}

/**
 * Deliver a notification to every matching enabled webhook for its user.
 * Matching: webhook is enabled, book scopes are compatible (either side null
 * = wildcard), and the event filter includes the notification type.
 *
 * Intended wiring (in notifications.ts createNotification, after publish):
 *   void deliverWebhooks(notification);
 */
export async function deliverWebhooks(notification: WebhookNotification): Promise<void> {
    try {
        await ensureWebhooksTable();
        const rows = await prisma.$queryRaw<WebhookRow[]>`
            SELECT id, user_id, book_guid, url, secret, events, enabled,
                   created_at, last_status, last_delivered_at
            FROM gnucash_web_webhooks
            WHERE user_id = ${notification.userId} AND enabled = TRUE`;

        const matching = rows.map(rowToRecord).filter(hook => {
            const bookOk =
                !hook.bookGuid || !notification.bookGuid || hook.bookGuid === notification.bookGuid;
            return bookOk && eventMatches(hook.events, notification.type);
        });

        await Promise.all(matching.map(hook => deliverToWebhook(hook, notification)));
    } catch (error) {
        console.warn('Webhook delivery failed:', error);
    }
}
