import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    formatValidationIssue,
    summarizeValidationIssues,
    validationErrorResponse,
} from '@/lib/api-validation';
import { extractErrorMessage } from '@/lib/api-error';

const Schema = z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    nested: z.object({ code: z.string() }).optional(),
});

function failure(input: unknown) {
    const result = Schema.safeParse(input);
    if (result.success) throw new Error('expected the fixture to fail validation');
    return result;
}

describe('formatValidationIssue', () => {
    it('prefixes the message with the dotted field path', () => {
        expect(formatValidationIssue({ path: ['splits', 0, 'value'], message: 'Required' })).toBe(
            'splits.0.value: Required',
        );
    });

    it('falls back to the bare message when the issue has no path', () => {
        expect(formatValidationIssue({ path: [], message: 'Body must be an object' })).toBe(
            'Body must be an object',
        );
    });

    it('never produces an empty string for a message-less issue', () => {
        expect(formatValidationIssue({ path: ['email'] })).toBe('email: Invalid value');
    });
});

describe('summarizeValidationIssues', () => {
    it('names every offending field, joined the way the client reader joins them', () => {
        const summary = summarizeValidationIssues(failure({ username: '', password: 'short' }));
        expect(summary).toBe('username: Username is required; password: Password must be at least 8 characters');
    });

    it('accepts a bare ZodError and a bare issue array', () => {
        const parsed = failure({ username: '', password: 'short' });
        expect(summarizeValidationIssues(parsed.error)).toBe(summarizeValidationIssues(parsed));
        expect(summarizeValidationIssues(parsed.error.issues)).toBe(summarizeValidationIssues(parsed));
    });

    it('falls back to a generic summary when there are no issues', () => {
        expect(summarizeValidationIssues([])).toBe('Validation failed');
    });
});

describe('validationErrorResponse', () => {
    it('sends a field-naming summary in `error` and keeps `errors` for field-level UI', async () => {
        const response = validationErrorResponse(failure({ username: 'ok', password: 'short' }));

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe('password: Password must be at least 8 characters');
        expect(Array.isArray(body.errors)).toBe(true);
        expect(body.errors[0].path).toEqual(['password']);
    });

    it('is what the shared client reader surfaces (no more generic "Validation failed")', async () => {
        const response = validationErrorResponse(failure({ username: '', password: 'short' }));
        const body = await response.json();

        expect(extractErrorMessage(body, 'Failed to save')).toBe(
            'username: Username is required; password: Password must be at least 8 characters',
        );
    });

    it('honours an explicit status override', () => {
        expect(validationErrorResponse(failure({}), 422).status).toBe(422);
    });
});
