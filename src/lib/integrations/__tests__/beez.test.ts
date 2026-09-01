/**
 * Unit tests for the pure half of the beez-trackz sync contract.
 *
 * These are the rules a caller can violate, so they are asserted exhaustively
 * and without a database. Two of them are worth naming because getting them
 * wrong is silent rather than loud:
 *
 *   - a malformed input must be REJECTED, never defaulted. A dropped filter or
 *     a coerced amount produces a wrong ledger entry that nobody notices.
 *   - a stored fraction that is not exactly a whole number of cents must come
 *     back as null. Rounding it invents money.
 */
import { describe, expect, it } from 'vitest';
import {
    allSplitsRepresentable,
    DEFAULT_CHANGES_LIMIT,
    MAX_CHANGES_LIMIT,
    MAX_EXTERNAL_ID_LENGTH,
    MAX_SPLITS,
    MAX_VERIFY_IDS,
    decodeChangesCursor,
    encodeChangesCursor,
    isCalendarDate,
    isEnterDateStamp,
    normalizeExternalId,
    parseBeezTransactionInput,
    parseBeezVerifyInput,
    parseChangesLimit,
    postDateToTimestamp,
    splitValueToCents,
    timestampToPostDate,
} from '../beez';

const ACCOUNT_A = 'a'.repeat(32);
const ACCOUNT_B = 'b'.repeat(32);

function validBody(overrides: Record<string, unknown> = {}) {
    return {
        externalId: 'beez-1',
        postDate: '2026-08-25',
        description: 'Hive inspection supplies',
        splits: [
            { accountGuid: ACCOUNT_A, amountCents: 1250 },
            { accountGuid: ACCOUNT_B, amountCents: -1250 },
        ],
        ...overrides,
    };
}

describe('isCalendarDate', () => {
    it('accepts a real day', () => {
        expect(isCalendarDate('2026-08-25')).toBe(true);
        expect(isCalendarDate('2024-02-29')).toBe(true);
    });

    it('rejects a day that only looks real', () => {
        // Date parses this and hands back March 2nd; accepting it would post
        // the transaction to a date the caller never asked for.
        expect(isCalendarDate('2026-02-30')).toBe(false);
        expect(isCalendarDate('2025-02-29')).toBe(false);
        expect(isCalendarDate('2026-13-01')).toBe(false);
    });

    it('rejects anything that is not exactly YYYY-MM-DD', () => {
        for (const value of ['2026-8-25', '25/08/2026', '2026-08-25T00:00:00Z', '', 'today']) {
            expect(isCalendarDate(value), value).toBe(false);
        }
    });
});

describe('post date timestamps', () => {
    it('stores midday UTC so no offset can move the day', () => {
        expect(postDateToTimestamp('2026-08-25').toISOString()).toBe('2026-08-25T12:00:00.000Z');
    });

    it('round-trips back to the same calendar day', () => {
        expect(timestampToPostDate(postDateToTimestamp('2026-01-01'))).toBe('2026-01-01');
        expect(timestampToPostDate(postDateToTimestamp('2026-12-31'))).toBe('2026-12-31');
    });

    it('returns null for a missing or invalid timestamp', () => {
        expect(timestampToPostDate(null)).toBeNull();
        expect(timestampToPostDate(new Date('nope'))).toBeNull();
    });
});

describe('parseBeezTransactionInput', () => {
    it('accepts a well-formed create body', () => {
        const parsed = parseBeezTransactionInput(validBody(), { requireExternalId: true });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.data.externalId).toBe('beez-1');
        expect(parsed.data.postDate).toBe('2026-08-25');
        expect(parsed.data.num).toBe('');
        expect(parsed.data.splits).toEqual([
            { accountGuid: ACCOUNT_A, amountCents: 1250, memo: '' },
            { accountGuid: ACCOUNT_B, amountCents: -1250, memo: '' },
        ]);
    });

    it('normalizes account guids to lowercase so lookups and inserts agree', () => {
        const parsed = parseBeezTransactionInput(
            validBody({
                splits: [
                    { accountGuid: 'A'.repeat(32), amountCents: 100 },
                    { accountGuid: ACCOUNT_B, amountCents: -100 },
                ],
            }),
            { requireExternalId: true },
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.data.splits[0].accountGuid).toBe('a'.repeat(32));
    });

    it('rejects a non-object body', () => {
        for (const body of [null, undefined, 'x', 42, []]) {
            expect(parseBeezTransactionInput(body, { requireExternalId: true }).ok).toBe(false);
        }
    });

    describe('externalId', () => {
        it('is required on create', () => {
            const parsed = parseBeezTransactionInput(
                validBody({ externalId: undefined }), { requireExternalId: true },
            );
            expect(parsed).toMatchObject({ ok: false, error: 'validation' });
        });

        it('is trimmed and must not be blank', () => {
            expect(parseBeezTransactionInput(validBody({ externalId: '   ' }), { requireExternalId: true }).ok)
                .toBe(false);
            const parsed = parseBeezTransactionInput(
                validBody({ externalId: '  beez-9  ' }), { requireExternalId: true },
            );
            expect(parsed.ok).toBe(true);
            if (parsed.ok) expect(parsed.data.externalId).toBe('beez-9');
        });

        it('is capped at the column width', () => {
            const at = 'x'.repeat(MAX_EXTERNAL_ID_LENGTH);
            expect(parseBeezTransactionInput(validBody({ externalId: at }), { requireExternalId: true }).ok)
                .toBe(true);
            expect(parseBeezTransactionInput(validBody({ externalId: at + 'x' }), { requireExternalId: true }).ok)
                .toBe(false);
        });

        it('is refused rather than ignored on replace, where the path names the record', () => {
            const parsed = parseBeezTransactionInput(validBody(), { requireExternalId: false });
            expect(parsed).toMatchObject({ ok: false, error: 'validation' });
        });

        it('is absent from a well-formed replace body', () => {
            const parsed = parseBeezTransactionInput(
                validBody({ externalId: undefined }), { requireExternalId: false },
            );
            expect(parsed.ok).toBe(true);
            if (parsed.ok) expect(parsed.data.externalId).toBeNull();
        });
    });

    it('requires a calendar postDate', () => {
        for (const postDate of [undefined, '', '2026-02-30', 20260825]) {
            expect(parseBeezTransactionInput(validBody({ postDate }), { requireExternalId: true }).ok).toBe(false);
        }
    });

    it('requires a string description but allows an empty one', () => {
        expect(parseBeezTransactionInput(validBody({ description: undefined }), { requireExternalId: true }).ok)
            .toBe(false);
        expect(parseBeezTransactionInput(validBody({ description: 7 }), { requireExternalId: true }).ok)
            .toBe(false);
        expect(parseBeezTransactionInput(validBody({ description: '' }), { requireExternalId: true }).ok)
            .toBe(true);
    });

    it('caps description and num at the column width', () => {
        expect(parseBeezTransactionInput(
            validBody({ description: 'd'.repeat(2049) }), { requireExternalId: true },
        ).ok).toBe(false);
        expect(parseBeezTransactionInput(
            validBody({ num: 'n'.repeat(2049) }), { requireExternalId: true },
        ).ok).toBe(false);
    });

    it('treats a missing num and memo as empty strings', () => {
        const parsed = parseBeezTransactionInput(validBody({ num: null }), { requireExternalId: true });
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
            expect(parsed.data.num).toBe('');
            expect(parsed.data.splits[0].memo).toBe('');
        }
    });

    describe('splits', () => {
        it('needs at least two', () => {
            const parsed = parseBeezTransactionInput(
                validBody({ splits: [{ accountGuid: ACCOUNT_A, amountCents: 0 }] }),
                { requireExternalId: true },
            );
            expect(parsed).toMatchObject({ ok: false, error: 'validation' });
        });

        it('is bounded so one request cannot queue unbounded work', () => {
            const many = Array.from({ length: MAX_SPLITS + 1 }, () => ({
                accountGuid: ACCOUNT_A, amountCents: 0,
            }));
            expect(parseBeezTransactionInput(validBody({ splits: many }), { requireExternalId: true }).ok)
                .toBe(false);
        });

        it('must sum to exactly zero, and says so with its own code', () => {
            const parsed = parseBeezTransactionInput(
                validBody({
                    splits: [
                        { accountGuid: ACCOUNT_A, amountCents: 1250 },
                        { accountGuid: ACCOUNT_B, amountCents: -1249 },
                    ],
                }),
                { requireExternalId: true },
            );
            expect(parsed).toMatchObject({ ok: false, error: 'unbalanced' });
            if (!parsed.ok) expect(parsed.detail).toContain('1');
        });

        it('catches an unbalanced set whose float sum rounds to exactly zero', () => {
            // Each term is a safe integer, so each one passes the per-split
            // check — but the RUNNING TOTAL is not bounded by that. Summed as
            // JavaScript numbers these four reduce to 0; the exact sum is 1.
            // Accepting them would persist a transaction that is off by a cent
            // while every reader believes it balances.
            const adversarial = [
                9007199254740991,
                9007199254740990,
                -9007199254740991,
                -9007199254740989,
            ];
            expect(adversarial.reduce((sum, cents) => sum + cents, 0)).toBe(0);
            expect(adversarial.reduce((sum, cents) => sum + BigInt(cents), 0n)).toBe(1n);

            const parsed = parseBeezTransactionInput(
                validBody({
                    splits: adversarial.map((amountCents, index) => ({
                        accountGuid: index % 2 === 0 ? ACCOUNT_A : ACCOUNT_B,
                        amountCents,
                    })),
                }),
                { requireExternalId: true },
            );
            expect(parsed).toMatchObject({ ok: false, error: 'unbalanced' });
            // The reported total is the exact one, not the rounded one.
            if (!parsed.ok) expect(parsed.detail).toContain('got 1');
        });

        it('still accepts a genuinely balanced set of near-limit amounts', () => {
            // The BigInt sum must not become its own false negative: these do
            // balance exactly, and their float sum happens to as well.
            const parsed = parseBeezTransactionInput(
                validBody({
                    splits: [
                        { accountGuid: ACCOUNT_A, amountCents: 9007199254740991 },
                        { accountGuid: ACCOUNT_B, amountCents: -9007199254740991 },
                    ],
                }),
                { requireExternalId: true },
            );
            expect(parsed.ok).toBe(true);
        });

        it('rejects a non-integer, non-finite, or unsafe amount', () => {
            for (const amountCents of [12.5, '1250', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
                const parsed = parseBeezTransactionInput(
                    validBody({
                        splits: [
                            { accountGuid: ACCOUNT_A, amountCents },
                            { accountGuid: ACCOUNT_B, amountCents: 0 },
                        ],
                    }),
                    { requireExternalId: true },
                );
                expect(parsed.ok, String(amountCents)).toBe(false);
            }
        });

        it('rejects a malformed account guid', () => {
            for (const accountGuid of ['not-a-guid', 'a'.repeat(31), 'g'.repeat(32), 42]) {
                const parsed = parseBeezTransactionInput(
                    validBody({
                        splits: [
                            { accountGuid, amountCents: 100 },
                            { accountGuid: ACCOUNT_B, amountCents: -100 },
                        ],
                    }),
                    { requireExternalId: true },
                );
                expect(parsed.ok, String(accountGuid)).toBe(false);
            }
        });

        it('rejects a non-object split entry', () => {
            const parsed = parseBeezTransactionInput(
                validBody({ splits: ['a', 'b'] }), { requireExternalId: true },
            );
            expect(parsed.ok).toBe(false);
        });

        it('names the offending index so a client can point at it', () => {
            const parsed = parseBeezTransactionInput(
                validBody({
                    splits: [
                        { accountGuid: ACCOUNT_A, amountCents: 100 },
                        { accountGuid: ACCOUNT_B, amountCents: -100 },
                        { accountGuid: 'bad', amountCents: 0 },
                    ],
                }),
                { requireExternalId: true },
            );
            expect(parsed.ok).toBe(false);
            if (!parsed.ok) expect(parsed.detail).toContain('splits[2]');
        });

        it('accepts a many-sided balanced transaction', () => {
            const parsed = parseBeezTransactionInput(
                validBody({
                    splits: [
                        { accountGuid: ACCOUNT_A, amountCents: -5000, memo: 'jar sales' },
                        { accountGuid: ACCOUNT_B, amountCents: 4500 },
                        { accountGuid: ACCOUNT_A, amountCents: 500, memo: 'processor fee' },
                    ],
                }),
                { requireExternalId: true },
            );
            expect(parsed.ok).toBe(true);
            if (parsed.ok) expect(parsed.data.splits[0].memo).toBe('jar sales');
        });
    });
});

describe('splitValueToCents', () => {
    it('converts the denominators that divide 100 exactly', () => {
        expect(splitValueToCents(1250n, 100n)).toBe(1250);
        expect(splitValueToCents(-1250n, 100n)).toBe(-1250);
        expect(splitValueToCents(5n, 1n)).toBe(500);
        expect(splitValueToCents(3n, 2n)).toBe(150);
        expect(splitValueToCents(1n, 4n)).toBe(25);
        expect(splitValueToCents(7n, 20n)).toBe(35);
        expect(splitValueToCents(0n, 100n)).toBe(0);
    });

    it('refuses a denominator finer than cents, even for a value that happens to be round', () => {
        // 1000/1000 IS one dollar, but 1234/1000 is not a whole number of cents.
        // One fixed rule per denominator keeps an account from flipping between
        // syncable and conflict from one transaction to the next.
        expect(splitValueToCents(1234n, 1000n)).toBeNull();
        expect(splitValueToCents(1000n, 1000n)).toBeNull();
        expect(splitValueToCents(1n, 3n)).toBeNull();
        expect(splitValueToCents(100000000n, 100000000n)).toBeNull();
    });

    it('refuses an undefined denominator instead of dividing by it', () => {
        expect(splitValueToCents(1n, 0n)).toBeNull();
        expect(splitValueToCents(1n, -100n)).toBeNull();
    });

    it('refuses a value that would not survive the trip through a JSON number', () => {
        expect(splitValueToCents(9007199254740992n, 1n)).toBeNull();
        expect(splitValueToCents(-9007199254740992n, 1n)).toBeNull();
        expect(splitValueToCents(9007199254740991n, 100n)).toBe(9007199254740991);
    });
});

describe('allSplitsRepresentable', () => {
    it('is true only when every split converts exactly', () => {
        expect(allSplitsRepresentable([
            { value_num: 100n, value_denom: 100n },
            { value_num: -100n, value_denom: 100n },
        ])).toBe(true);
        expect(allSplitsRepresentable([
            { value_num: 100n, value_denom: 100n },
            { value_num: -1n, value_denom: 3n },
        ])).toBe(false);
    });

    it('is vacuously true for a transaction with no splits', () => {
        expect(allSplitsRepresentable([])).toBe(true);
    });
});

describe('change cursor', () => {
    const GUID = 'c'.repeat(32);
    const NULL_GUID = 'd'.repeat(32);
    const SWEEP_GUID = 'e'.repeat(32);
    const STAMP = '2026-08-25T10:11:12.345678';
    const SWEEP_STAMP = '2026-08-25T09:00:00.000000';

    /** A drained-sweep cursor: a high watermark and nothing else. */
    const at = (enterDate: string, guid: string) => ({
        enterDate, guid, nullGuid: null,
        sweepEnterDate: null, sweepGuid: null, sweepBase: null,
    });

    it('round-trips a microsecond position byte for byte', () => {
        const encoded = encodeChangesCursor(at(STAMP, GUID));
        expect(decodeChangesCursor(encoded)).toEqual(at(STAMP, GUID));
    });

    it('keeps the microseconds a JS Date would have thrown away', () => {
        // This is the whole defect the format exists to prevent: a Date holds
        // milliseconds, so `…12.345678` would come back as `…12.345`, still
        // compare greater than the row it names, and re-emit that row on every
        // single poll for the life of the client.
        const decoded = decodeChangesCursor(encodeChangesCursor(at(STAMP, GUID)));
        expect(decoded?.enterDate).toBe(STAMP);
        expect(decoded?.enterDate).not.toBe(new Date(`${STAMP}Z`).toISOString());
        expect(isEnterDateStamp(decoded?.enterDate ?? '')).toBe(true);
    });

    it('is base64url, so it survives a query string untouched', () => {
        const encoded = encodeChangesCursor(at('2026-08-25T00:00:00.000000', GUID));
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(encodeURIComponent(encoded)).toBe(encoded);
    });

    it('normalizes the guid so a shouted cursor still matches stored rows', () => {
        const encoded = encodeChangesCursor({
            ...at(STAMP, 'C'.repeat(32)), nullGuid: 'D'.repeat(32),
        });
        expect(decodeChangesCursor(encoded)?.guid).toBe(GUID);
        expect(decodeChangesCursor(encoded)?.nullGuid).toBe(NULL_GUID);
    });

    it('carries the NULL-set watermark alongside the time watermark', () => {
        const encoded = encodeChangesCursor({ ...at(STAMP, GUID), nullGuid: NULL_GUID });
        expect(decodeChangesCursor(encoded)).toEqual({ ...at(STAMP, GUID), nullGuid: NULL_GUID });
    });

    it('accepts a position that is only in the NULL set, for a book with no timed rows', () => {
        // A book whose transactions ALL have a NULL enter_date still has to page
        // its way through them, and there is no time watermark to pair with.
        const encoded = encodeChangesCursor({
            enterDate: null, guid: null, nullGuid: NULL_GUID,
            sweepEnterDate: null, sweepGuid: null, sweepBase: null,
        });
        expect(decodeChangesCursor(encoded)).toEqual({
            enterDate: null, guid: null, nullGuid: NULL_GUID,
            sweepEnterDate: null, sweepGuid: null, sweepBase: null,
        });
    });

    it('carries a sweep base on a position that is only in the NULL set', () => {
        // A brand new client whose ordered stream is still empty pins the
        // database clock as its base, so its first drained generation has a
        // floor to hand on. Refusing that pairing would strand the cursor.
        const encoded = encodeChangesCursor({
            enterDate: null, guid: null, nullGuid: NULL_GUID,
            sweepEnterDate: null, sweepGuid: null, sweepBase: SWEEP_STAMP,
        });
        expect(decodeChangesCursor(encoded)?.sweepBase).toBe(SWEEP_STAMP);
    });

    it('carries the sweep base, which is what the next generation floors down from', () => {
        // The base is fixed when a generation STARTS. Deriving the next floor
        // from the watermark a generation ENDED on ages out any write that
        // landed behind the sweep position while it ran.
        const encoded = encodeChangesCursor({
            ...at(STAMP, GUID), sweepBase: SWEEP_STAMP,
        });
        expect(decodeChangesCursor(encoded)).toEqual({
            ...at(STAMP, GUID), sweepBase: SWEEP_STAMP,
        });
    });

    it('refuses a sweep base that is not a real instant', () => {
        // Same gate as every other stamp on this path: the value goes straight
        // into a `::timestamp` cast, where a rollover spelling is a 500.
        const forged = Buffer.from(JSON.stringify({
            e: STAMP, g: GUID, n: null, se: null, sg: null, sb: '2026-99-99T99:99:99.999999',
        }), 'utf8').toString('base64url');
        expect(decodeChangesCursor(forged)).toBeNull();
    });

    it('re-encodes an unchanged position byte for byte, so a client can compare cursors', () => {
        const cursor = at(STAMP, GUID);
        expect(encodeChangesCursor(cursor)).toBe(encodeChangesCursor({ ...cursor }));
    });

    it('carries the sweep position alongside the high watermark', () => {
        // Two positions, not one: the high watermark is the greatest row ever
        // sent, the sweep position is how far the current pass has read. A
        // single field cannot express both, and re-deriving the sweep floor
        // from the watermark alone deadlocks the moment the overlap band holds
        // more rows than `limit`.
        const encoded = encodeChangesCursor({
            enterDate: STAMP, guid: GUID, nullGuid: null,
            sweepEnterDate: SWEEP_STAMP, sweepGuid: SWEEP_GUID, sweepBase: null,
        });
        expect(decodeChangesCursor(encoded)).toEqual({
            enterDate: STAMP, guid: GUID, nullGuid: null,
            sweepEnterDate: SWEEP_STAMP, sweepGuid: SWEEP_GUID, sweepBase: null,
        });
    });

    it('reads a pre-overlap cursor as a drained sweep rather than refusing it', () => {
        // Cursors minted before the sweep position existed carry only `e`, `g`
        // and `n`. Treating one as "no sweep in progress" costs a client one
        // re-read of the overlap band on upgrade; refusing it would strand
        // every deployed client on a 422.
        const legacy = Buffer.from(
            JSON.stringify({ e: STAMP, g: GUID, n: null }), 'utf8',
        ).toString('base64url');
        expect(decodeChangesCursor(legacy)).toEqual(at(STAMP, GUID));
    });

    it('rejects anything it did not mint, rather than restarting the feed', () => {
        for (const raw of [
            'not-base64!!',
            Buffer.from('not json', 'utf8').toString('base64url'),
            Buffer.from('[]', 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: STAMP }), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: STAMP, g: 'short' }), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: 'never', g: GUID }), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: 5, g: GUID }), 'utf8').toString('base64url'),
            // Millisecond precision is not this cursor's spelling — accepting it
            // would reintroduce the truncation the format exists to rule out.
            Buffer.from(JSON.stringify({ e: '2026-08-25T10:11:12.345Z', g: GUID }), 'utf8').toString('base64url'),
            // The retired NULL-tail encoding: a time watermark of "null" paired
            // with a guid. Resuming it would resume a position from which every
            // later normal row is unreachable, so `e` and `g` stand or fall
            // together and this is refused — while `{e: null, g: null, n: guid}`,
            // which means something else entirely, is accepted above.
            Buffer.from(JSON.stringify({ e: null, g: GUID }), 'utf8').toString('base64url'),
            // Names no position in either stream.
            Buffer.from(JSON.stringify({}), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: null, g: null, n: null }), 'utf8').toString('base64url'),
            // The sweep position obeys the same pairing rule as the high
            // watermark: half of it is not a position this endpoint issued.
            Buffer.from(JSON.stringify({ e: STAMP, g: GUID, se: SWEEP_STAMP }), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: STAMP, g: GUID, sg: SWEEP_GUID }), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: STAMP, g: GUID, se: 'never', sg: SWEEP_GUID }), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: STAMP, g: GUID, se: SWEEP_STAMP, sg: 'short' }), 'utf8').toString('base64url'),
            // A sweep with no high watermark to rewind below names nothing.
            Buffer.from(
                JSON.stringify({ e: null, g: null, n: NULL_GUID, se: SWEEP_STAMP, sg: SWEEP_GUID }),
                'utf8',
            ).toString('base64url'),
            // A NULL-set watermark that is not a guid.
            Buffer.from(JSON.stringify({ e: STAMP, g: GUID, n: 'short' }), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: STAMP, g: GUID, n: 7 }), 'utf8').toString('base64url'),
            // Shape-valid but not a real instant. Before the calendar check
            // these reached the feed's `::timestamp` cast and answered 500.
            Buffer.from(JSON.stringify({ e: '2026-99-99T99:99:99.999999', g: GUID }), 'utf8').toString('base64url'),
            Buffer.from(JSON.stringify({ e: '2026-02-30T00:00:00.000000', g: GUID }), 'utf8').toString('base64url'),
        ]) {
            expect(decodeChangesCursor(raw), raw).toBeNull();
        }
    });
});

describe('isEnterDateStamp', () => {
    it('accepts exactly the format the feed reads enter_date with', () => {
        expect(isEnterDateStamp('2026-08-25T10:11:12.345678')).toBe(true);
        expect(isEnterDateStamp('2026-08-25T10:11:12.000000')).toBe(true);
    });

    it('rejects every lossier spelling of the same instant', () => {
        for (const raw of [
            '2026-08-25T10:11:12.345',
            '2026-08-25T10:11:12.345678Z',
            '2026-08-25 10:11:12.345678',
            '2026-08-25T10:11:12',
            '',
        ]) {
            expect(isEnterDateStamp(raw), raw).toBe(false);
        }
    });

    it('rejects a digit layout that is not a real instant', () => {
        // Shape alone let these through to the feed's `::timestamp` cast, where
        // PostgreSQL raised "date/time field value out of range" and the client
        // got a 500 for a plainly malformed cursor.
        for (const raw of [
            '2026-99-99T99:99:99.999999',
            '2026-00-15T00:00:00.000000',
            '2026-13-01T00:00:00.000000',
            '2026-01-00T00:00:00.000000',
            '2026-01-32T00:00:00.000000',
            '2026-04-31T00:00:00.000000',
            '2026-02-29T00:00:00.000000',
            '1900-02-29T00:00:00.000000',
            '0000-01-01T00:00:00.000000',
            '2026-01-01T24:00:00.000000',
            '2026-01-01T00:60:00.000000',
            // No leap seconds: PostgreSQL refuses :60 in a timestamp literal.
            '2026-01-01T00:00:60.000000',
        ]) {
            expect(isEnterDateStamp(raw), raw).toBe(false);
        }
    });

    it('accepts the calendar edges a naive check would trip over', () => {
        for (const raw of [
            '2024-02-29T23:59:59.999999',
            '2000-02-29T00:00:00.000000',
            '2026-12-31T23:59:59.999999',
            '0001-01-01T00:00:00.000000',
        ]) {
            expect(isEnterDateStamp(raw), raw).toBe(true);
        }
    });
});

describe('parseChangesLimit', () => {
    it('defaults when the parameter is absent or exactly empty', () => {
        expect(parseChangesLimit(null)).toEqual({ ok: true, limit: DEFAULT_CHANGES_LIMIT });
        expect(parseChangesLimit('')).toEqual({ ok: true, limit: DEFAULT_CHANGES_LIMIT });
    });

    it('accepts the documented range', () => {
        expect(parseChangesLimit('1')).toEqual({ ok: true, limit: 1 });
        expect(parseChangesLimit(' 250 ')).toEqual({ ok: true, limit: 250 });
        expect(parseChangesLimit(String(MAX_CHANGES_LIMIT))).toEqual({ ok: true, limit: MAX_CHANGES_LIMIT });
    });

    it('rejects a present-but-malformed value instead of silently defaulting', () => {
        // A client that asked for 1000 rows must learn it cannot have them,
        // rather than get 100 and conclude it is caught up.
        for (const raw of ['0', '-1', 'abc', '10.5', String(MAX_CHANGES_LIMIT + 1), '   ']) {
            expect(parseChangesLimit(raw).ok, raw).toBe(false);
        }
    });
});

describe('normalizeExternalId', () => {
    it('trims and accepts an id within the column width', () => {
        expect(normalizeExternalId('  beez-8412 ')).toEqual({ ok: true, externalId: 'beez-8412' });
        expect(normalizeExternalId('x'.repeat(MAX_EXTERNAL_ID_LENGTH)))
            .toEqual({ ok: true, externalId: 'x'.repeat(MAX_EXTERNAL_ID_LENGTH) });
    });

    it('refuses a blank id rather than looking up the empty string', () => {
        for (const raw of ['', '   ', '\t\n']) {
            expect(normalizeExternalId(raw)).toEqual({
                ok: false, detail: 'externalId: must not be empty',
            });
        }
    });

    it('refuses an over-long id rather than truncating the lookup', () => {
        expect(normalizeExternalId('x'.repeat(MAX_EXTERNAL_ID_LENGTH + 1))).toEqual({
            ok: false, detail: `externalId: must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`,
        });
    });

    it('names the field it was given, so a batch entry reports its index', () => {
        expect(normalizeExternalId('  ', 'externalIds[3]')).toEqual({
            ok: false, detail: 'externalIds[3]: must not be empty',
        });
    });

    it('is the SAME rule the POST body applies', () => {
        // One spelling, or a client can create a record through POST that GET
        // and verify then refuse to look up.
        const padded = `  ${'x'.repeat(MAX_EXTERNAL_ID_LENGTH)}  `;
        const viaBody = parseBeezTransactionInput(
            validBody({ externalId: padded }),
            { requireExternalId: true },
        );
        expect(viaBody.ok).toBe(true);
        if (!viaBody.ok) return;
        const viaHelper = normalizeExternalId(padded);
        expect(viaHelper.ok).toBe(true);
        if (!viaHelper.ok) return;
        expect(viaBody.data.externalId).toBe(viaHelper.externalId);
    });
});

describe('parseBeezVerifyInput', () => {
    it('accepts a list of ids and trims each one', () => {
        expect(parseBeezVerifyInput({ externalIds: [' beez-1', 'beez-2 '] })).toEqual({
            ok: true, externalIds: ['beez-1', 'beez-2'],
        });
    });

    it('keeps request order and duplicates', () => {
        // The response is one result per requested entry, zipped by index, so
        // collapsing or sorting here would silently misalign every caller.
        expect(parseBeezVerifyInput({ externalIds: ['b', 'a', 'b'] })).toEqual({
            ok: true, externalIds: ['b', 'a', 'b'],
        });
    });

    it('accepts exactly the cap and refuses one more', () => {
        const atCap = Array.from({ length: MAX_VERIFY_IDS }, (_, i) => `beez-${i}`);
        expect(parseBeezVerifyInput({ externalIds: atCap })).toEqual({
            ok: true, externalIds: atCap,
        });
        expect(parseBeezVerifyInput({ externalIds: [...atCap, 'beez-over'] })).toEqual({
            ok: false, detail: `externalIds: at most ${MAX_VERIFY_IDS} ids per request`,
        });
    });

    it('reports the cap before it reports a malformed entry inside an over-large batch', () => {
        const overCap = Array.from({ length: MAX_VERIFY_IDS + 1 }, () => '');
        expect(parseBeezVerifyInput({ externalIds: overCap })).toEqual({
            ok: false, detail: `externalIds: at most ${MAX_VERIFY_IDS} ids per request`,
        });
    });

    it('refuses an empty list rather than proving nothing successfully', () => {
        expect(parseBeezVerifyInput({ externalIds: [] })).toEqual({
            ok: false, detail: 'externalIds: must name at least 1 external id',
        });
    });

    it.each([
        [undefined],
        [null],
        ['not-an-object'],
        [42],
        [['beez-1']],
    ])('refuses %j as a body', (body) => {
        const result = parseBeezVerifyInput(body);
        expect(result.ok).toBe(false);
    });

    it.each([
        [{}, 'externalIds: required, must be an array of strings'],
        [{ externalIds: 'beez-1' }, 'externalIds: required, must be an array of strings'],
        [{ externalIds: { 0: 'beez-1' } }, 'externalIds: required, must be an array of strings'],
        [{ externalIds: ['beez-1', 7] }, 'externalIds[1]: must be a string'],
        [{ externalIds: [null] }, 'externalIds[0]: must be a string'],
        [{ externalIds: ['beez-1', '  '] }, 'externalIds[1]: must not be empty'],
        [
            { externalIds: ['x'.repeat(MAX_EXTERNAL_ID_LENGTH + 1)] },
            `externalIds[0]: must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`,
        ],
    ])('refuses %j with a detail naming the offending entry', (body, detail) => {
        expect(parseBeezVerifyInput(body)).toEqual({ ok: false, detail });
    });
});
