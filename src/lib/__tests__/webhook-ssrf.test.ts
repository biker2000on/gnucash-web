/**
 * SSRF hardening for outbound webhook delivery (ASI-3-007).
 *
 * `validateWebhookUrl` inspects the literal hostname when the webhook is saved.
 * The request itself resolves that hostname again, later, so a rebinding host
 * can answer with a public address at create time and 127.0.0.1 (or
 * 169.254.169.254) at delivery time. These tests pin that behaviour down by
 * mocking the resolver and asserting the request never reaches a local server.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { db, rebindMap } = vi.hoisted(() => ({
    db: {
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(),
    },
    rebindMap: new Map<string, string[]>(),
}));

vi.mock('@/lib/prisma', () => ({ default: db }));

// Resolver stub: only hostnames registered in `rebindMap` are intercepted, so
// literal 127.0.0.1 targets still resolve through the real implementation.
vi.mock('node:dns', async importOriginal => {
    const actual = await importOriginal<typeof import('node:dns')>();
    const lookup = (hostname: string, options: unknown, callback?: unknown) => {
        const cb = (typeof options === 'function' ? options : callback) as (
            err: Error | null,
            address?: unknown,
            family?: number,
        ) => void;
        const opts = (typeof options === 'object' && options !== null ? options : {}) as {
            all?: boolean;
        };
        const pinned = rebindMap.get(hostname);
        if (!pinned) {
            return (actual.lookup as unknown as (...args: unknown[]) => void)(
                hostname,
                options,
                callback,
            );
        }
        const addresses = pinned.map(address => ({
            address,
            family: address.includes(':') ? 6 : 4,
        }));
        process.nextTick(() => {
            if (opts.all) cb(null, addresses);
            else cb(null, addresses[0].address, addresses[0].family);
        });
    };
    return { ...actual, default: { ...actual, lookup }, lookup };
});

import {
    deliverToWebhook,
    validateWebhookUrl,
    isPrivateAddress,
    ensureWebhooksTable,
    createPinnedLookup,
} from '../webhooks';

const HMAC_KEY = 'whsec_test123';
const NOTIFICATION = {
    id: 42,
    userId: 7,
    bookGuid: 'book1234book1234book1234book1234',
    type: 'budget_alert',
    severity: 'warning',
    title: 'Budget overspend: Dining',
    message: null,
    href: null,
    createdAt: new Date('2026-07-12T00:00:00Z'),
};

interface Recorded {
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

const servers: http.Server[] = [];

async function startServer(status = 200): Promise<{ port: number; requests: Recorded[] }> {
    const requests: Recorded[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });
        req.on('end', () => {
            requests.push({ url: req.url ?? '', headers: req.headers, body });
            res.writeHead(status);
            res.end();
        });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, requests };
}

afterAll(async () => {
    await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve()))));
});

beforeEach(() => {
    rebindMap.clear();
    db.$executeRaw.mockReset();
    db.$executeRaw.mockResolvedValue(1);
});

describe('isPrivateAddress', () => {
    it('rejects loopback, RFC1918, CGNAT, link-local and IPv6 internals', () => {
        for (const ip of [
            '127.0.0.1',
            '127.5.5.5',
            '10.0.0.7',
            '192.168.1.1',
            '172.16.0.1',
            '172.31.255.255',
            '169.254.169.254',
            '0.0.0.0',
            '0.1.2.3',
            '100.64.0.1',
            '100.127.255.255',
            '::1',
            'fd00::1',
            'fe80::1',
            '::ffff:127.0.0.1',
        ]) {
            expect(isPrivateAddress(ip), ip).toBe(true);
        }
    });

    it('accepts public addresses', () => {
        for (const ip of ['1.2.3.4', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2606:4700::1111']) {
            expect(isPrivateAddress(ip), ip).toBe(false);
        }
    });
});

describe('DNS rebinding at send time', () => {
    it('refuses a hostname that resolves to 127.0.0.1, even though it passed the create-time check', async () => {
        const { port, requests } = await startServer();
        const host = 'rebind.example.test';
        // Create-time validation sees only the literal hostname and allows it.
        expect(validateWebhookUrl(`http://${host}/hook`).ok).toBe(true);

        // At delivery time the resolver answers with loopback.
        rebindMap.set(host, ['127.0.0.1']);

        const status = await deliverToWebhook(
            { id: 5, url: `http://${host}:${port}/hook`, secret: HMAC_KEY },
            NOTIFICATION,
        );

        expect(status).toMatch(/private address 127\.0\.0\.1/);
        // The decisive assertion: no socket ever reached the internal service.
        expect(requests).toHaveLength(0);
    });

    it('refuses a hostname that resolves to the cloud metadata endpoint', async () => {
        const host = 'metadata.example.test';
        rebindMap.set(host, ['169.254.169.254']);

        const status = await deliverToWebhook(
            { id: 6, url: `http://${host}/latest/meta-data`, secret: HMAC_KEY },
            NOTIFICATION,
        );

        expect(status).toMatch(/private address 169\.254\.169\.254/);
    });

    it('refuses when any address in a multi-answer response is internal', async () => {
        const host = 'mixed.example.test';
        rebindMap.set(host, ['93.184.216.34', '10.0.0.5']);

        const status = await deliverToWebhook(
            { id: 7, url: `http://${host}/hook`, secret: HMAC_KEY },
            NOTIFICATION,
        );

        expect(status).toMatch(/private address 10\.0\.0\.5/);
    });

    it('still delivers to a webhook whose literal host is internal (allowInternal at create time)', async () => {
        const { port, requests } = await startServer(200);

        const status = await deliverToWebhook(
            { id: 8, url: `http://127.0.0.1:${port}/hook`, secret: HMAC_KEY },
            NOTIFICATION,
        );

        expect(status).toBe('200');
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('/hook');
        expect(requests[0].headers['x-gnucashweb-event']).toBe('budget_alert');
    });

    /**
     * The regression this guards: `allowInternal` used to be re-derived from
     * the literal hostname at send time, which silently broke every LAN webhook
     * whose target is *named* rather than dotted-quad — `http://truenas:8080`,
     * `ntfy.lan`, `*.home.arpa`, Tailscale MagicDNS. Those names look public to
     * any hostname test, so the pin refused them. The flag now lives on the row.
     */
    describe('persisted allow_internal flag', () => {
        it('lets a bare LAN name resolve into 192.168/16 when internal is allowed', async () => {
            rebindMap.set('truenas', ['192.168.4.132']);

            const resolve = (allowInternal: boolean) =>
                new Promise<{ err: Error | null; address?: string }>(done => {
                    createPinnedLookup(allowInternal)(
                        'truenas',
                        {} as never,
                        ((err: Error | null, address?: string) =>
                            done({ err, address })) as never,
                    );
                });

            const allowed = await resolve(true);
            expect(allowed.err).toBeNull();
            expect(allowed.address).toBe('192.168.4.132');

            // Same name, flag off: refused. `truenas` is indistinguishable from a
            // public name by hostname alone, which is exactly why the flag has to
            // be persisted rather than re-derived.
            const refused = await resolve(false);
            expect(refused.err?.message).toMatch(/private address 192\.168\.4\.132/);
        });

        it('actually reaches the endpoint behind a public-looking LAN name when the row allows internal', async () => {
            const { port, requests } = await startServer();
            const host = 'ntfy.lan';
            rebindMap.set(host, ['127.0.0.1']);

            const status = await deliverToWebhook(
                { id: 11, url: `http://${host}:${port}/hook`, secret: HMAC_KEY, allowInternal: true },
                NOTIFICATION,
            );

            expect(status).toBe('200');
            expect(requests).toHaveLength(1);
        });

        it('still refuses the same name when the row does not allow internal', async () => {
            const { port, requests } = await startServer();
            const host = 'ntfy.lan';
            rebindMap.set(host, ['127.0.0.1']);

            const status = await deliverToWebhook(
                { id: 12, url: `http://${host}:${port}/hook`, secret: HMAC_KEY, allowInternal: false },
                NOTIFICATION,
            );

            expect(status).toMatch(/private address 127\.0\.0\.1/);
            expect(requests).toHaveLength(0);
        });

        it('defaults to refusing when the caller supplies no flag at all', async () => {
            const host = 'unflagged.example.test';
            rebindMap.set(host, ['10.0.0.9']);

            const status = await deliverToWebhook(
                { id: 13, url: `http://${host}/hook`, secret: HMAC_KEY },
                NOTIFICATION,
            );

            expect(status).toMatch(/private address 10\.0\.0\.9/);
        });
    });

    it('does not follow redirects', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
            res.end();
        });
        servers.push(server);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;

        const status = await deliverToWebhook(
            { id: 9, url: `http://127.0.0.1:${port}/hook`, secret: HMAC_KEY },
            NOTIFICATION,
        );

        expect(status).toBe('error: redirect not allowed');
    });
});

describe('allow_internal migration', () => {
    it('adds the column idempotently and backfills pre-existing rows to TRUE', async () => {
        db.$executeRawUnsafe.mockReset();
        db.$executeRawUnsafe.mockResolvedValue(0);
        await ensureWebhooksTable();

        const sql = String(db.$executeRawUnsafe.mock.calls[0][0]);
        expect(sql).toMatch(/ADD COLUMN allow_internal BOOLEAN NOT NULL DEFAULT FALSE/);
        // Guarded by a catalogue lookup so re-running is a no-op...
        expect(sql).toMatch(/column_name = 'allow_internal'/);
        // ...and rows that predate the column keep delivering.
        expect(sql).toMatch(/UPDATE gnucash_web_webhooks SET allow_internal = TRUE/);
    });
});
