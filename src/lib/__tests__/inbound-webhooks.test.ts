import { describe, it, expect } from 'vitest';
import {
    inboundTransactionSchema,
    inboundMembershipPaymentSchema,
    parseInbound,
    toCents,
} from '../inbound-webhooks';

const GUID_A = 'a'.repeat(32);
const GUID_B = 'b'.repeat(32);

const validTransaction = {
    date: '2026-07-15',
    description: 'Coffee',
    amount: 4.75,
    fromAccountGuid: GUID_A,
    toAccountGuid: GUID_B,
};

const validPayment = {
    memberId: 42,
    amount: 50,
    paidDate: '2026-07-15',
    method: 'zeffy',
    reference: 'ZFY-1234',
};

describe('inboundTransactionSchema', () => {
    it('accepts a valid payload', () => {
        const result = parseInbound(inboundTransactionSchema, validTransaction);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.amount).toBe(4.75);
            expect(result.data.fromAccountGuid).toBe(GUID_A);
        }
    });

    it('accepts uppercase hex GUIDs', () => {
        const result = parseInbound(inboundTransactionSchema, {
            ...validTransaction,
            fromAccountGuid: GUID_A.toUpperCase(),
        });
        expect(result.ok).toBe(true);
    });

    it.each([
        ['missing date', { ...validTransaction, date: undefined }],
        ['non-ISO date', { ...validTransaction, date: '15/07/2026' }],
        ['impossible date', { ...validTransaction, date: '2026-13-99' }],
        ['missing description', { ...validTransaction, description: undefined }],
        ['blank description', { ...validTransaction, description: '   ' }],
        ['missing amount', { ...validTransaction, amount: undefined }],
        ['zero amount', { ...validTransaction, amount: 0 }],
        ['negative amount', { ...validTransaction, amount: -5 }],
        ['NaN amount', { ...validTransaction, amount: NaN }],
        ['Infinity amount', { ...validTransaction, amount: Infinity }],
        ['string amount', { ...validTransaction, amount: '4.75' }],
        ['implausibly large amount', { ...validTransaction, amount: 2_000_000_000 }],
        ['short guid', { ...validTransaction, fromAccountGuid: 'abc123' }],
        ['non-hex guid', { ...validTransaction, toAccountGuid: 'z'.repeat(32) }],
        ['same from and to', { ...validTransaction, toAccountGuid: GUID_A }],
        ['same from and to (case-insensitive)', { ...validTransaction, toAccountGuid: GUID_A.toUpperCase() }],
        ['null body', null],
        ['array body', []],
    ])('rejects %s', (_label, body) => {
        const result = parseInbound(inboundTransactionSchema, body);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.length).toBeGreaterThan(0);
        }
    });

    it('trims the description', () => {
        const result = parseInbound(inboundTransactionSchema, {
            ...validTransaction,
            description: '  Coffee  ',
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data.description).toBe('Coffee');
    });
});

describe('inboundMembershipPaymentSchema', () => {
    it('accepts a valid payload', () => {
        const result = parseInbound(inboundMembershipPaymentSchema, validPayment);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.memberId).toBe(42);
            expect(result.data.method).toBe('zeffy');
        }
    });

    it('defaults method to other and allows omitted amount/reference', () => {
        const result = parseInbound(inboundMembershipPaymentSchema, {
            memberId: 7,
            paidDate: '2026-01-31',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.method).toBe('other');
            expect(result.data.amount ?? null).toBeNull();
            expect(result.data.reference ?? null).toBeNull();
        }
    });

    it.each([
        ['missing memberId', { ...validPayment, memberId: undefined }],
        ['non-integer memberId', { ...validPayment, memberId: 4.5 }],
        ['zero memberId', { ...validPayment, memberId: 0 }],
        ['negative memberId', { ...validPayment, memberId: -3 }],
        ['string memberId', { ...validPayment, memberId: '42' }],
        ['missing paidDate', { ...validPayment, paidDate: undefined }],
        ['bad paidDate', { ...validPayment, paidDate: 'July 15' }],
        ['negative amount', { ...validPayment, amount: -1 }],
        ['unknown method', { ...validPayment, method: 'bitcoin' }],
        ['overlong reference', { ...validPayment, reference: 'x'.repeat(101) }],
        ['null body', null],
    ])('rejects %s', (_label, body) => {
        const result = parseInbound(inboundMembershipPaymentSchema, body);
        expect(result.ok).toBe(false);
    });
});

describe('toCents', () => {
    it('converts float dollars to integer cents without drift', () => {
        expect(toCents(4.75)).toBe(475);
        expect(toCents(0.1 + 0.2)).toBe(30);
        expect(toCents(19.99)).toBe(1999);
        expect(toCents(1_000_000)).toBe(100_000_000);
    });
});
