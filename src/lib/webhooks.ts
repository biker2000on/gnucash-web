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
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import prisma from '@/lib/prisma';

export interface WebhookRecord {
    id: number;
    userId: number;
    bookGuid: string | null;
    url: string;
    secret: string;
    events: 'all' | string[];
    enabled: boolean;
    /**
     * Was this webhook deliberately pointed at a private/internal host? Stored
     * on the row (not re-derived from the URL) because plenty of LAN targets
     * have public-looking names — `http://truenas:8080`, `ntfy.lan`,
     * `*.home.arpa`, Tailscale MagicDNS — that no literal-hostname test can
     * recognise. Send-time DNS pinning reads this flag.
     */
    allowInternal: boolean;
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
 * so a public name pointing at a private IP is not caught here. That check is
 * enforced at send time instead - see {@link isPrivateAddress} and the pinned
 * lookup in the delivery section below.
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
                    last_delivered_at TIMESTAMP,
                    allow_internal BOOLEAN NOT NULL DEFAULT FALSE
                  );

                  -- Added after the table shipped. Rows that predate the column
                  -- were created before send-time DNS pinning existed and were
                  -- already delivering to whatever they pointed at (typically a
                  -- LAN service), so they are backfilled to TRUE: turning the
                  -- pin on must not silently break an existing delivery. New
                  -- rows default FALSE and must opt in explicitly.
                  IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'gnucash_web_webhooks'
                      AND column_name = 'allow_internal'
                  ) THEN
                    ALTER TABLE gnucash_web_webhooks
                      ADD COLUMN allow_internal BOOLEAN NOT NULL DEFAULT FALSE;
                    UPDATE gnucash_web_webhooks SET allow_internal = TRUE;
                  END IF;

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
    allow_internal: boolean | null;
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
        allowInternal: row.allow_internal === true,
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
                   created_at, last_status, last_delivered_at, allow_internal
            FROM gnucash_web_webhooks
            WHERE user_id = ${userId} AND (book_guid IS NULL OR book_guid = ${bookGuid})
            ORDER BY created_at DESC`
        : await prisma.$queryRaw<WebhookRow[]>`
            SELECT id, user_id, book_guid, url, secret, events, enabled,
                   created_at, last_status, last_delivered_at, allow_internal
            FROM gnucash_web_webhooks
            WHERE user_id = ${userId}
            ORDER BY created_at DESC`;
    return rows.map(rowToRecord);
}

export async function getWebhook(userId: number, id: number): Promise<WebhookRecord | null> {
    await ensureWebhooksTable();
    const rows = await prisma.$queryRaw<WebhookRow[]>`
        SELECT id, user_id, book_guid, url, secret, events, enabled,
               created_at, last_status, last_delivered_at, allow_internal
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
    allowInternal?: boolean;
}

export async function createWebhook(userId: number, input: CreateWebhookInput): Promise<WebhookRecord> {
    await ensureWebhooksTable();
    const secret = input.secret?.trim() || generateWebhookSecret();
    const events = serializeEvents(input.events ?? 'all');
    const enabled = input.enabled !== false;
    const allowInternal = input.allowInternal === true;

    const rows = await prisma.$queryRaw<WebhookRow[]>`
        INSERT INTO gnucash_web_webhooks (user_id, book_guid, url, secret, events, enabled, allow_internal)
        VALUES (${userId}, ${input.bookGuid || null}, ${input.url}, ${secret}, ${events}, ${enabled}, ${allowInternal})
        RETURNING id, user_id, book_guid, url, secret, events, enabled,
                  created_at, last_status, last_delivered_at, allow_internal`;
    return rowToRecord(rows[0]);
}

export interface UpdateWebhookInput {
    url?: string;
    secret?: string;
    events?: 'all' | string[];
    enabled?: boolean;
    allowInternal?: boolean;
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
    const allowInternal = input.allowInternal ?? existing.allowInternal;

    const rows = await prisma.$queryRaw<WebhookRow[]>`
        UPDATE gnucash_web_webhooks
        SET url = ${url}, secret = ${secret}, events = ${events}, enabled = ${enabled},
            allow_internal = ${allowInternal}
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING id, user_id, book_guid, url, secret, events, enabled,
                  created_at, last_status, last_delivered_at, allow_internal`;
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

/**
 * Extra deny patterns that only matter once a hostname has been resolved to a
 * literal address: PRIVATE_HOST_PATTERNS above is written for what a user types
 * into the URL field, while these cover ranges a resolver can hand back.
 */
const PRIVATE_ADDRESS_PATTERNS: RegExp[] = [
    /^0\./, // "this network" 0.0.0.0/8
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
    /^::$/, // unspecified
];

/**
 * Is a resolved IP address one we refuse to deliver to?
 *
 * Reuses the create-time deny list (loopback, RFC1918, link-local/metadata,
 * IPv6 ULA and link-local) so there is exactly one definition of "internal",
 * and unwraps IPv4-mapped IPv6 (`::ffff:127.0.0.1`) first - otherwise the
 * IPv4 patterns would never see it.
 */
export function isPrivateAddress(address: string): boolean {
    const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
    const candidate = mapped ? mapped[1] : bare;
    return (
        PRIVATE_HOST_PATTERNS.some(p => p.test(candidate)) ||
        PRIVATE_ADDRESS_PATTERNS.some(p => p.test(candidate))
    );
}

/**
 * Does the URL's literal hostname already say "internal"?
 *
 * This is only a *supplement* to the persisted `allow_internal` flag, never a
 * substitute for it: a webhook saved as `http://192.168.4.5/hook` could only
 * have been accepted with the box ticked, so honouring it costs nothing. The
 * flag is what carries the LAN targets this test cannot see — `truenas`,
 * `ntfy.lan`, `*.home.arpa`, Tailscale MagicDNS names — all of which look
 * perfectly public here and would otherwise be refused at send time.
 */
export function targetIsExplicitlyInternal(parsed: URL): boolean {
    return PRIVATE_HOST_PATTERNS.some(p => p.test(parsed.hostname));
}

/**
 * DNS pinning for outbound delivery (SSRF hardening).
 *
 * validateWebhookUrl() only inspects the literal hostname at create time, and
 * the request itself re-resolves the name later - so `hook.attacker.test` can
 * answer with a public address while the webhook is being saved and with
 * 127.0.0.1 (or 169.254.169.254) when it is delivered. Re-validating just
 * before the request does not close that: the resolution the socket performs is
 * a *second*, unvalidated one.
 *
 * The fix is to make the socket use our resolution. Node's http/https request
 * options take a `lookup` override, which is the address the connection is
 * actually made to - there is no second resolution to race. This is why
 * delivery no longer goes through `fetch`: WHATWG fetch has no equivalent hook
 * (undici's `Agent({ connect: { lookup } })` would work, but undici is not a
 * dependency here and `node:http` already ships the primitive). `http.request`
 * also does not follow redirects, which preserves the old `redirect: 'error'`
 * behaviour, and keeps SNI/certificate validation bound to the real hostname -
 * something rewriting the URL to an IP literal would have broken.
 */
export function createPinnedLookup(allowInternal: boolean): LookupFunction {
    return ((hostname: string, options: unknown, callback: (...args: never[]) => void) => {
        const opts = (typeof options === 'object' && options !== null ? options : {}) as {
            all?: boolean;
            family?: number;
        };
        dnsLookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
            const cb = callback as unknown as (
                err: NodeJS.ErrnoException | null,
                address?: string | LookupAddress[],
                family?: number,
            ) => void;
            if (err) {
                cb(err);
                return;
            }
            const resolved = addresses as LookupAddress[];
            if (!resolved.length) {
                cb(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }));
                return;
            }
            if (!allowInternal) {
                const blocked = resolved.find(entry => isPrivateAddress(entry.address));
                if (blocked) {
                    cb(
                        Object.assign(
                            new Error(
                                `refusing to deliver: ${hostname} resolves to private address ${blocked.address}`,
                            ),
                            { code: 'EWEBHOOKPRIVATE' },
                        ),
                    );
                    return;
                }
            }
            if (opts.all) {
                cb(null, resolved);
            } else {
                cb(null, resolved[0].address, resolved[0].family);
            }
        });
    }) as unknown as LookupFunction;
}

function postOnce(
    url: string,
    body: string,
    headers: Record<string, string>,
    allowInternal: boolean,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            reject(new Error('invalid URL'));
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            reject(new Error('URL must use http or https'));
            return;
        }

        const transport = parsed.protocol === 'https:' ? https : http;
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            fn();
        };

        const req = transport.request(
            parsed,
            {
                method: 'POST',
                headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
                lookup: createPinnedLookup(allowInternal || targetIsExplicitlyInternal(parsed)),
            },
            res => {
                const status = res.statusCode ?? 0;
                // Drain so the socket can be reused/closed cleanly.
                res.resume();
                if (status >= 300 && status < 400) {
                    // Matches the old `redirect: 'error'`: a redirect is an
                    // obvious SSRF pivot, so it is never followed.
                    req.destroy();
                    finish(() => reject(new Error('redirect not allowed')));
                    return;
                }
                finish(() => resolve(String(status)));
            },
        );

        const deadline = setTimeout(() => {
            req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        }, DELIVERY_TIMEOUT_MS);

        req.on('error', err => finish(() => reject(err)));
        req.end(body);
    });
}

/**
 * Deliver one webhook: POST the signed body, one retry on failure, record the
 * last status. Never throws.
 */
export async function deliverToWebhook(
    webhook: Pick<WebhookRecord, 'id' | 'url' | 'secret'> & { allowInternal?: boolean },
    notification: WebhookNotification
): Promise<string> {
    const allowInternal = webhook.allowInternal === true;
    const body = buildWebhookBody(notification);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'GnuCash-Web-Webhook/1.0',
        'X-GnucashWeb-Event': notification.type,
        'X-GnucashWeb-Signature': signPayload(webhook.secret, body),
    };

    let status: string;
    try {
        status = await postOnce(webhook.url, body, headers, allowInternal);
        if (Number(status) >= 400) {
            // One retry on HTTP error responses too.
            status = await postOnce(webhook.url, body, headers, allowInternal).catch(
                (e: unknown) => `error: ${e instanceof Error ? e.message : 'request failed'}`
            );
        }
    } catch {
        // Network error / timeout — one retry.
        try {
            status = await postOnce(webhook.url, body, headers, allowInternal);
        } catch (e) {
            status = `error: ${e instanceof Error ? (e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : e.message) : 'request failed'}`;
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
                   created_at, last_status, last_delivered_at, allow_internal
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
