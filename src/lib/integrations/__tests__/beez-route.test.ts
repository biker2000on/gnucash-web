/**
 * Unit tests for the HTTP shell shared by /api/integrations/beez/*.
 *
 * The shell's job is translation, and the failure mode worth guarding is a leak
 * in the wrong direction: an unexpected database error must not reach an
 * integration client as a message naming columns and constraints, and a book
 * must never be taken from anything but the token.
 *
 * `@/lib/auth` and the service are mocked so this stays in the unit tier —
 * every path that actually touches Postgres is covered by
 * src/lib/services/__tests__/beez-sync.integration.test.ts instead.
 */
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireRole = vi.fn();
const getBeezBookContext = vi.fn();

vi.mock('@/lib/auth', () => ({
    requireRole: (...args: unknown[]) => requireRole(...args),
}));

vi.mock('@/lib/services/beez-sync.service', async () => {
    // The error class is real — the shell branches on `instanceof`, and a stub
    // class would make that branch pass for the wrong reason.
    const actual = await vi.importActual<typeof import('@/lib/services/beez-sync.service')>(
        '@/lib/services/beez-sync.service',
    );
    return { BeezSyncError: actual.BeezSyncError, getBeezBookContext };
});

const {
    authorizeBeezRequest,
    beezErrorResponse,
    parseExternalIdParam,
    readBeezIdempotencyKey,
    readJsonBody,
} = await import('../beez-route');
const { BeezSyncError } = await import('@/lib/services/beez-sync.service');
const { PeriodLockedError } = await import('@/lib/services/period-lock.service');

const CONTEXT = {
    bookGuid: 'b'.repeat(32),
    bookName: 'Apiary',
    rootAccountGuid: 'r'.repeat(32),
    rootCommodityGuid: 'c'.repeat(32),
    rootCurrency: 'USD',
};

function request(init: RequestInit = {}): Request {
    return new Request('https://folio.example/api/integrations/beez/transactions', {
        method: 'POST',
        ...init,
    });
}

describe('authorizeBeezRequest', () => {
    beforeEach(() => {
        requireRole.mockReset();
        getBeezBookContext.mockReset();
    });

    it('takes the book from the token, never from the request', async () => {
        requireRole.mockResolvedValue({ user: { id: 7, username: 'apiarist' }, role: 'edit', bookGuid: CONTEXT.bookGuid });
        getBeezBookContext.mockResolvedValue(CONTEXT);

        const result = await authorizeBeezRequest('edit');
        expect(result).not.toBeInstanceOf(NextResponse);
        if (result instanceof NextResponse) return;
        expect(getBeezBookContext).toHaveBeenCalledWith(CONTEXT.bookGuid);
        expect(result.context).toEqual(CONTEXT);
        expect(result.actor).toEqual({ userId: 7 });
    });

    it('passes an auth refusal straight through', async () => {
        const refusal = NextResponse.json({ error: 'Invalid or expired API token' }, { status: 401 });
        requireRole.mockResolvedValue(refusal);

        const result = await authorizeBeezRequest('readonly');
        expect(result).toBe(refusal);
        expect(getBeezBookContext).not.toHaveBeenCalled();
    });

    it('turns a book-resolution failure into its own wire response', async () => {
        requireRole.mockResolvedValue({ user: { id: 7, username: 'a' }, role: 'edit', bookGuid: CONTEXT.bookGuid });
        getBeezBookContext.mockRejectedValue(
            new BeezSyncError(422, 'no_book_currency', 'The book root account has no commodity'),
        );

        const result = await authorizeBeezRequest('edit');
        expect(result).toBeInstanceOf(NextResponse);
        if (!(result instanceof NextResponse)) return;
        expect(result.status).toBe(422);
        await expect(result.json()).resolves.toEqual({
            error: 'no_book_currency',
            detail: 'The book root account has no commodity',
        });
    });
});

describe('beezErrorResponse', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders a BeezSyncError as its code, status, and detail', async () => {
        const response = beezErrorResponse(new BeezSyncError(409, 'reconciled', 'Has reconciled splits'));
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            error: 'reconciled',
            detail: 'Has reconciled splits',
        });
    });

    it('omits detail when there is none', async () => {
        const response = beezErrorResponse(new BeezSyncError(404, 'unknown_external_id'));
        await expect(response.json()).resolves.toEqual({ error: 'unknown_external_id' });
    });

    it('uses the app-wide period-locked payload rather than inventing a second one', async () => {
        const response = beezErrorResponse(new PeriodLockedError('2026-06-30'));
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: 'PERIOD_LOCKED' });
    });

    it('never leaks an unexpected error to the client', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const response = beezErrorResponse(
            new Error('duplicate key value violates unique constraint "uq_external_links_external_id"'),
        );

        expect(response.status).toBe(500);
        // The constraint name is a schema detail an integration client has no
        // business reading; it goes to the server log instead.
        await expect(response.json()).resolves.toEqual({ error: 'internal_error' });
        expect(logged).toHaveBeenCalled();
    });
});

describe('readBeezIdempotencyKey', () => {
    it('returns null when the caller opts out', () => {
        expect(readBeezIdempotencyKey(request())).toEqual({ ok: true, key: null });
    });

    it('reads and trims the header', () => {
        const result = readBeezIdempotencyKey(request({ headers: { 'Idempotency-Key': '  beez-1  ' } }));
        expect(result).toEqual({ ok: true, key: 'beez-1' });
    });

    it('rejects a blank or over-long key as a 422, naming the header', async () => {
        for (const value of ['   ', 'x'.repeat(201)]) {
            const result = readBeezIdempotencyKey(request({ headers: { 'Idempotency-Key': value } }));
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.response.status).toBe(422);
            const body = await result.response.json();
            expect(body.detail).toContain('Idempotency-Key');
            expect(body.detail).not.toContain('idempotencyKey');
        }
    });
});

describe('readJsonBody', () => {
    it('parses a JSON body', async () => {
        const result = await readJsonBody(request({ body: '{"a":1}', headers: { 'Content-Type': 'application/json' } }));
        expect(result).toEqual({ ok: true, body: { a: 1 } });
    });

    it('answers malformed JSON with a 422 instead of a 500', async () => {
        const result = await readJsonBody(request({ body: 'not json' }));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.response.status).toBe(422);
        await expect(result.response.json()).resolves.toEqual({
            error: 'validation',
            detail: 'body: must be valid JSON',
        });
    });
});

describe('parseExternalIdParam', () => {
    it('accepts and trims an id within the column width', () => {
        expect(parseExternalIdParam('  beez-8412 ')).toEqual({ ok: true, externalId: 'beez-8412' });
        expect(parseExternalIdParam('x'.repeat(200))).toEqual({ ok: true, externalId: 'x'.repeat(200) });
    });

    it('rejects an empty or over-long id rather than truncating the lookup', async () => {
        // The details are the SHARED `normalizeExternalId` messages, not a
        // second spelling of the same bound: the path segment, the POST body,
        // and each verify-batch entry must agree on which ids exist, or a
        // client can create a record it cannot read back.
        for (const [raw, detail] of [
            ['', 'externalId: must not be empty'],
            ['   ', 'externalId: must not be empty'],
            ['x'.repeat(201), 'externalId: must be at most 200 characters'],
        ] as const) {
            const result = parseExternalIdParam(raw);
            expect(result.ok, raw).toBe(false);
            if (result.ok) continue;
            expect(result.response.status).toBe(422);
            await expect(result.response.json()).resolves.toEqual({ error: 'validation', detail });
        }
    });
});
