/**
 * Shared API error-body reader.
 *
 * Covers every payload shape the API actually emits (see src/lib/api-error.ts)
 * plus the bodies that are not JSON at all, because the whole point of the
 * helper is that a call site no longer has to know which shape it will get.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractErrorMessage, readErrorBody, throwErrorBody } from '@/lib/api-error';

const FALLBACK = 'Failed to save';

function jsonResponse(body: unknown, status = 400): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('extractErrorMessage — legacy payload shapes', () => {
    it('shape 1: { error }', () => {
        expect(extractErrorMessage({ error: 'Period is locked' }, FALLBACK)).toBe('Period is locked');
    });

    it('shape 2: { errors: [{ field, message }] } with no error string', () => {
        const body = {
            errors: [
                { field: 'splits', message: 'Splits must sum to zero (current sum: 0.05)' },
                { field: 'description', message: 'Description is required' },
            ],
        };
        expect(extractErrorMessage(body, FALLBACK)).toBe(
            'Splits must sum to zero (current sum: 0.05) Description is required'
        );
    });

    it('shape 3: { error, errors } prefers the summary string', () => {
        const body = {
            error: 'Description is required',
            errors: [{ field: 'description', message: 'Description is required' }],
        };
        expect(extractErrorMessage(body, FALLBACK)).toBe('Description is required');
    });

    it('shape 4: { message }', () => {
        expect(extractErrorMessage({ message: 'Job queue unavailable' }, FALLBACK)).toBe('Job queue unavailable');
    });

    it('reads Zod issue arrays, which carry message but no field', () => {
        const body = { errors: [{ code: 'too_small', path: ['splits'], message: 'Transaction must have at least 2 splits' }] };
        expect(extractErrorMessage(body, FALLBACK)).toBe('Transaction must have at least 2 splits');
    });

    it('reads a nested { error: { message } }', () => {
        expect(extractErrorMessage({ error: { message: 'Invalid request body' } }, FALLBACK)).toBe('Invalid request body');
    });

    it('falls back on shapes with nothing readable', () => {
        expect(extractErrorMessage({}, FALLBACK)).toBe(FALLBACK);
        expect(extractErrorMessage({ error: '' }, FALLBACK)).toBe(FALLBACK);
        expect(extractErrorMessage({ error: '   ' }, FALLBACK)).toBe(FALLBACK);
        expect(extractErrorMessage({ errors: [] }, FALLBACK)).toBe(FALLBACK);
        expect(extractErrorMessage({ errors: [{ field: 'splits' }] }, FALLBACK)).toBe(FALLBACK);
        expect(extractErrorMessage(null, FALLBACK)).toBe(FALLBACK);
        expect(extractErrorMessage('boom', FALLBACK)).toBe(FALLBACK);
    });

    it('skips unreadable entries but keeps readable siblings', () => {
        const body = { errors: [null, { message: 'Account is required' }, 'Value is required'] };
        expect(extractErrorMessage(body, FALLBACK)).toBe('Account is required Value is required');
    });
});

describe('readErrorBody', () => {
    it('reads each shape off a real Response', async () => {
        expect(await readErrorBody(jsonResponse({ error: 'Nope' }), FALLBACK)).toBe('Nope');
        expect(await readErrorBody(jsonResponse({ errors: [{ field: 'a', message: 'Nope too' }] }), FALLBACK)).toBe('Nope too');
        expect(await readErrorBody(jsonResponse({ error: 'Summary', errors: [{ message: 'Detail' }] }), FALLBACK)).toBe('Summary');
        expect(await readErrorBody(jsonResponse({ message: 'Legacy' }), FALLBACK)).toBe('Legacy');
    });

    it('falls back on a non-JSON body instead of throwing', async () => {
        const html = new Response('<html><body>502 Bad Gateway</body></html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
        });
        await expect(readErrorBody(html, FALLBACK)).resolves.toBe(FALLBACK);
    });

    it('falls back on an empty body instead of throwing', async () => {
        await expect(readErrorBody(new Response(null, { status: 504 }), FALLBACK)).resolves.toBe(FALLBACK);
    });
});

describe('converted call sites', () => {
    const CONVERTED = [
        'components/AccountLedger.tsx',
        'components/business/time/WeekGrid.tsx',
        'components/reports/ContinuousCloseDashboard.tsx',
    ];

    it.each(CONVERTED)('%s reads error bodies through the shared helper', file => {
        const source = readFileSync(join(process.cwd(), 'src', file), 'utf8');

        expect(source).toMatch(/from '@\/lib\/api-error'/);
        // No hand-rolled reader survives: the `?.error ||` / `errors.map(...)`
        // precedence chains and the body-discarding throw are all gone.
        expect(source).not.toMatch(/json\(\)\.catch\(\(\) => null\)/);
        expect(source).not.toMatch(/errData\?\./);
        expect(source).not.toMatch(/throw new Error\('Failed to save'\)/);
    });
});

describe('throwErrorBody', () => {
    it('throws an Error carrying the server reason', async () => {
        await expect(throwErrorBody(jsonResponse({ errors: [{ message: 'Splits must sum to zero' }] }), FALLBACK))
            .rejects.toThrow('Splits must sum to zero');
    });

    it('throws the fallback when the body is unreadable', async () => {
        await expect(throwErrorBody(new Response('not json', { status: 500 }), FALLBACK)).rejects.toThrow(FALLBACK);
    });
});
