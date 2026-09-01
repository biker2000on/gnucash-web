/**
 * Unit tests for the two READ-ONLY beez route handlers and the role boundary
 * they sit on.
 *
 * The boundary is the whole point of these endpoints existing separately from
 * the write verbs. A beez-trackz install verifying a restored set of id
 * mappings should be able to do so with a token that CANNOT overwrite the
 * ledger it is checking — so `GET .../transactions/{externalId}` and
 * `POST .../transactions/verify` must accept `readonly`, and `POST`, `PUT`, and
 * `DELETE` must keep demanding `edit`. Both halves are asserted here, in one
 * file, because the failure worth catching is someone relaxing the second half
 * while adding to the first.
 *
 * The service and `@/lib/auth` are mocked: what the routes owe is
 * authenticate → validate → delegate → translate. The data the service returns
 * is covered by src/lib/services/__tests__/beez-verify.test.ts and, against a
 * real server, by beez-sync.integration.test.ts.
 */
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOOK = 'b'.repeat(32);
const TX = 'a'.repeat(32);

const requireRole = vi.fn();

const service = vi.hoisted(() => ({
    getBeezBookContext: vi.fn(),
    verifyBeezExternalIds: vi.fn(),
    getBeezTransactionByExternalId: vi.fn(),
    createBeezTransaction: vi.fn(),
    replaceBeezTransaction: vi.fn(),
    deleteBeezTransaction: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    requireRole: (...args: unknown[]) => requireRole(...args),
}));

vi.mock('@/lib/services/beez-sync.service', async () => {
    // The error class is real: the shell branches on `instanceof`, and a stub
    // would make that branch pass for the wrong reason.
    const actual = await vi.importActual<typeof import('@/lib/services/beez-sync.service')>(
        '@/lib/services/beez-sync.service',
    );
    return { BeezSyncError: actual.BeezSyncError, ...service };
});

const { GET, PUT, DELETE } = await import('@/app/api/integrations/beez/transactions/[externalId]/route');
const { POST: VERIFY } = await import('@/app/api/integrations/beez/transactions/verify/route');
const { POST: CREATE } = await import('@/app/api/integrations/beez/transactions/route');
const { BeezSyncError } = await import('@/lib/services/beez-sync.service');

const CONTEXT = {
    bookGuid: BOOK,
    bookName: 'Apiary',
    rootAccountGuid: 'r'.repeat(32),
    rootCommodityGuid: 'c'.repeat(32),
    rootCurrency: 'USD',
};

const LINKED_ITEM = {
    externalId: 'beez-1',
    state: 'linked' as const,
    transactionGuid: TX,
    enterDate: '2026-08-25T09:14:02.123456Z',
    postDate: '2026-08-25',
    description: 'Frames and foundation',
    num: 'BZ-1',
    reconciledOrFrozen: false,
    inClosedPeriod: false,
    splits: [{ accountGuid: '1'.repeat(32), amountCents: 100, memo: '' }],
};

/** Authenticate every call as a token holding exactly `role`. */
function tokenWithRole(role: 'readonly' | 'edit'): void {
    requireRole.mockImplementation(async (minimumRole: string) => {
        if (minimumRole === 'edit' && role === 'readonly') {
            return NextResponse.json(
                { error: `Requires edit role, this token grants ${role}` },
                { status: 403 },
            );
        }
        return { user: { id: 7, username: 'apiarist' }, role, bookGuid: BOOK, viaToken: true };
    });
    service.getBeezBookContext.mockResolvedValue(CONTEXT);
}

function params(externalId: string) {
    return { params: Promise.resolve({ externalId }) };
}

function verifyRequest(body: unknown): Request {
    return new Request('https://folio.example/api/integrations/beez/transactions/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function readRequest(): Request {
    return new Request('https://folio.example/api/integrations/beez/transactions/beez-1');
}

/** The write entry points. None may be reached from a read-only handler. */
const WRITE_CALLS = [
    service.createBeezTransaction,
    service.replaceBeezTransaction,
    service.deleteBeezTransaction,
];

function assertNoServiceWrite(): void {
    for (const spy of WRITE_CALLS) expect(spy).not.toHaveBeenCalled();
}

beforeEach(() => {
    requireRole.mockReset();
    for (const spy of Object.values(service)) spy.mockReset();
});

describe('GET /api/integrations/beez/transactions/{externalId}', () => {
    it('is satisfied by a readonly token and never asks for edit', async () => {
        tokenWithRole('readonly');
        service.getBeezTransactionByExternalId.mockResolvedValue(LINKED_ITEM);

        const response = await GET(readRequest(), params('beez-1'));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(LINKED_ITEM);
        expect(requireRole).toHaveBeenCalledWith('readonly');
        expect(requireRole).not.toHaveBeenCalledWith('edit');
        assertNoServiceWrite();
    });

    it('takes the book from the token, never from the request', async () => {
        tokenWithRole('readonly');
        service.getBeezTransactionByExternalId.mockResolvedValue(LINKED_ITEM);

        await GET(readRequest(), params('beez-1'));

        expect(service.getBeezBookContext).toHaveBeenCalledWith(BOOK);
        expect(service.getBeezTransactionByExternalId).toHaveBeenCalledWith(CONTEXT, 'beez-1');
    });

    it('answers an orphaned link with 200 and the marker, not 404', async () => {
        tokenWithRole('readonly');
        service.getBeezTransactionByExternalId.mockResolvedValue({
            externalId: 'beez-gone', state: 'orphan-link', transactionGuid: TX,
        });

        const response = await GET(readRequest(), params('beez-gone'));

        // 404 here would tell a client to re-POST, and the re-POST would lose
        // to the stale link that is still holding the unique index. The
        // repair for this state is DELETE.
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ state: 'orphan-link' });
    });

    it('answers a missing link with 404 unknown_external_id', async () => {
        tokenWithRole('readonly');
        service.getBeezTransactionByExternalId.mockRejectedValue(
            new BeezSyncError(404, 'unknown_external_id', 'No folio transaction is linked to "beez-nope"'),
        );

        const response = await GET(readRequest(), params('beez-nope'));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: 'unknown_external_id' });
    });

    it('refuses a blank or over-long id before reaching the database', async () => {
        tokenWithRole('readonly');

        for (const raw of ['', '   ', 'x'.repeat(201)]) {
            const response = await GET(readRequest(), params(raw));
            expect(response.status, raw).toBe(422);
            await expect(response.json()).resolves.toMatchObject({ error: 'validation' });
        }
        expect(service.getBeezTransactionByExternalId).not.toHaveBeenCalled();
    });

    it('passes an auth refusal straight through', async () => {
        requireRole.mockResolvedValue(
            NextResponse.json({ error: 'Invalid or expired API token' }, { status: 401 }),
        );

        const response = await GET(readRequest(), params('beez-1'));

        expect(response.status).toBe(401);
        expect(service.getBeezTransactionByExternalId).not.toHaveBeenCalled();
    });
});

describe('POST /api/integrations/beez/transactions/verify', () => {
    it('is satisfied by a readonly token and returns results in request order', async () => {
        tokenWithRole('readonly');
        const results = [
            { externalId: 'beez-2', state: 'no-link' },
            LINKED_ITEM,
        ];
        service.verifyBeezExternalIds.mockResolvedValue(results);

        const response = await VERIFY(verifyRequest({ externalIds: ['beez-2', 'beez-1'] }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ results });
        expect(requireRole).toHaveBeenCalledWith('readonly');
        expect(requireRole).not.toHaveBeenCalledWith('edit');
        expect(service.verifyBeezExternalIds).toHaveBeenCalledWith(CONTEXT, ['beez-2', 'beez-1']);
        assertNoServiceWrite();
    });

    it('hands the service trimmed ids in the order they were sent', async () => {
        tokenWithRole('readonly');
        service.verifyBeezExternalIds.mockResolvedValue([]);

        await VERIFY(verifyRequest({ externalIds: ['  beez-9 ', 'beez-1', 'beez-9'] }));

        expect(service.verifyBeezExternalIds).toHaveBeenCalledWith(
            CONTEXT, ['beez-9', 'beez-1', 'beez-9'],
        );
    });

    it('accepts a full batch of 500 ids', async () => {
        tokenWithRole('readonly');
        service.verifyBeezExternalIds.mockResolvedValue([]);

        const externalIds = Array.from({ length: 500 }, (_, i) => `beez-${i}`);
        const response = await VERIFY(verifyRequest({ externalIds }));

        expect(response.status).toBe(200);
        expect(service.verifyBeezExternalIds).toHaveBeenCalledWith(CONTEXT, externalIds);
    });

    it('refuses 501 ids with a 422 naming the cap, and queries nothing', async () => {
        tokenWithRole('readonly');

        const response = await VERIFY(verifyRequest({
            externalIds: Array.from({ length: 501 }, (_, i) => `beez-${i}`),
        }));

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toEqual({
            error: 'validation',
            detail: 'externalIds: at most 500 ids per request',
        });
        expect(service.verifyBeezExternalIds).not.toHaveBeenCalled();
    });

    it.each([
        [{}, 'externalIds: required, must be an array of strings'],
        [{ externalIds: 'beez-1' }, 'externalIds: required, must be an array of strings'],
        [{ externalIds: [] }, 'externalIds: must name at least 1 external id'],
        [{ externalIds: ['beez-1', 7] }, 'externalIds[1]: must be a string'],
        [{ externalIds: ['beez-1', '   '] }, 'externalIds[1]: must not be empty'],
        [
            { externalIds: ['x'.repeat(201)] },
            'externalIds[0]: must be at most 200 characters',
        ],
    ])('refuses %j with a 422 that names the offending entry', async (body, detail) => {
        tokenWithRole('readonly');

        const response = await VERIFY(verifyRequest(body));

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toEqual({ error: 'validation', detail });
        expect(service.verifyBeezExternalIds).not.toHaveBeenCalled();
    });

    it('answers malformed JSON with a 422 rather than a 500', async () => {
        tokenWithRole('readonly');

        const response = await VERIFY(new Request(
            'https://folio.example/api/integrations/beez/transactions/verify',
            { method: 'POST', body: 'not json' },
        ));

        expect(response.status).toBe(422);
        expect(service.verifyBeezExternalIds).not.toHaveBeenCalled();
    });

    it('never leaks an unexpected service error to the client', async () => {
        tokenWithRole('readonly');
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        service.verifyBeezExternalIds.mockRejectedValue(
            new Error('relation "gnucash_web_external_links" does not exist'),
        );

        const response = await VERIFY(verifyRequest({ externalIds: ['beez-1'] }));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: 'internal_error' });
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });

    it('passes an auth refusal straight through', async () => {
        requireRole.mockResolvedValue(
            NextResponse.json({ error: 'Invalid or expired API token' }, { status: 401 }),
        );

        const response = await VERIFY(verifyRequest({ externalIds: ['beez-1'] }));

        expect(response.status).toBe(401);
        expect(service.verifyBeezExternalIds).not.toHaveBeenCalled();
    });
});

describe('the readonly boundary', () => {
    /**
     * The regression guard, in both directions. Adding read endpoints to this
     * surface is exactly the change that could tempt someone to relax the write
     * verbs onto the same role, so the write verbs are re-asserted here rather
     * than assumed.
     */
    const writeBody = {
        externalId: 'beez-1',
        postDate: '2026-08-25',
        description: 'Frames',
        splits: [
            { accountGuid: '1'.repeat(32), amountCents: 100, memo: '' },
            { accountGuid: '2'.repeat(32), amountCents: -100, memo: '' },
        ],
    };

    function writeRequest(body: unknown = writeBody): Request {
        return new Request('https://folio.example/api/integrations/beez/transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('refuses a readonly token on POST, PUT, and DELETE with 403', async () => {
        tokenWithRole('readonly');

        const responses = [
            await CREATE(writeRequest()),
            await PUT(writeRequest({ ...writeBody, externalId: undefined }), params('beez-1')),
            await DELETE(writeRequest(), params('beez-1')),
        ];

        for (const response of responses) expect(response.status).toBe(403);
        expect(requireRole).toHaveBeenCalledWith('edit');
        assertNoServiceWrite();
    });

    it('still lets an edit token through to the write verbs', async () => {
        tokenWithRole('edit');
        service.createBeezTransaction.mockResolvedValue({
            result: {
                transactionGuid: TX, enterDate: '2026-08-25T09:14:02.123456Z',
                externalId: 'beez-1', alreadyLinked: false,
            },
            status: 200,
        });

        const response = await CREATE(writeRequest());

        expect(response.status).toBe(200);
        expect(service.createBeezTransaction).toHaveBeenCalled();
    });

    it('lets an edit token read too — readonly is a floor, not a ceiling', async () => {
        tokenWithRole('edit');
        service.getBeezTransactionByExternalId.mockResolvedValue(LINKED_ITEM);
        service.verifyBeezExternalIds.mockResolvedValue([LINKED_ITEM]);

        expect((await GET(readRequest(), params('beez-1'))).status).toBe(200);
        expect((await VERIFY(verifyRequest({ externalIds: ['beez-1'] }))).status).toBe(200);
    });
});
