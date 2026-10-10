/**
 * Unit tests for the beez handshake and change-feed route shells, for the
 * deletion stream they expose.
 *
 *  - `GET status` advertises `transaction-deletions` exactly when the service
 *    says the deletion-log trigger is installed. A client decides between the
 *    deletion stream and a full rescan on that one field, so it must never be
 *    hard-coded true.
 *  - `GET changes` forwards `include=deletions` to the service as
 *    `includeDeletions`, defaults it off (an older client's payload is
 *    unchanged), and refuses an unknown stream name with 422 instead of
 *    silently answering without it.
 *
 * The service and `@/lib/auth` are mocked; what the feed returns is covered
 * against a real server by beez-sync.integration.test.ts.
 */
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOOK = 'b'.repeat(32);

const requireRole = vi.fn();

const service = vi.hoisted(() => ({
    getBeezBookContext: vi.fn(),
    getBeezCapabilities: vi.fn(),
    getBeezChanges: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    requireRole: (...args: unknown[]) => requireRole(...args),
}));

vi.mock('@/lib/services/beez-sync.service', async () => {
    const actual = await vi.importActual<typeof import('@/lib/services/beez-sync.service')>(
        '@/lib/services/beez-sync.service',
    );
    return { BeezSyncError: actual.BeezSyncError, ...service };
});

const { GET: STATUS } = await import('@/app/api/integrations/beez/status/route');
const { GET: CHANGES } = await import('@/app/api/integrations/beez/changes/route');

const CONTEXT = {
    bookGuid: BOOK,
    bookName: 'Apiary',
    rootAccountGuid: 'r'.repeat(32),
    rootCommodityGuid: 'c'.repeat(32),
    rootCurrency: 'USD',
};

beforeEach(() => {
    requireRole.mockReset();
    for (const spy of Object.values(service)) spy.mockReset();
    requireRole.mockResolvedValue({
        user: { id: 7, username: 'apiarist' }, role: 'readonly', bookGuid: BOOK, viaToken: true,
    });
    service.getBeezBookContext.mockResolvedValue(CONTEXT);
    service.getBeezChanges.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
});

describe('GET /api/integrations/beez/status', () => {
    it('advertises the deletion stream when the trigger is installed', async () => {
        service.getBeezCapabilities.mockResolvedValue(['transaction-deletions']);

        const response = await STATUS();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            ok: true, bookGuid: BOOK, bookName: 'Apiary', rootCurrency: 'USD',
            capabilities: ['transaction-deletions'],
        });
    });

    it('lists no capability when the trigger is missing, so the client rescans', async () => {
        service.getBeezCapabilities.mockResolvedValue([]);

        const body = await (await STATUS()).json();

        expect(body.capabilities).toEqual([]);
    });

    it('still refuses an unauthenticated caller before asking anything', async () => {
        requireRole.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));

        const response = await STATUS();

        expect(response.status).toBe(401);
        expect(service.getBeezCapabilities).not.toHaveBeenCalled();
    });
});

describe('GET /api/integrations/beez/changes', () => {
    const feed = (query: string) =>
        CHANGES(new Request(`https://folio.example/api/integrations/beez/changes${query}`));

    it('leaves the deletion stream off unless asked', async () => {
        await feed('?limit=10');

        expect(service.getBeezChanges).toHaveBeenCalledWith(CONTEXT, {
            since: null, limit: 10, includeDeletions: false,
        });
    });

    it('forwards include=deletions', async () => {
        await feed('?limit=10&include=deletions');

        expect(service.getBeezChanges).toHaveBeenCalledWith(CONTEXT, {
            since: null, limit: 10, includeDeletions: true,
        });
    });

    it('refuses an unknown stream with 422 and never reads the feed', async () => {
        const response = await feed('?include=everything');

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({ error: 'validation' });
        expect(service.getBeezChanges).not.toHaveBeenCalled();
    });
});
