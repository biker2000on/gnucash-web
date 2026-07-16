import { describe, it, expect, vi } from 'vitest';

// The service imports prisma / book-scope / period-lock at module level;
// mock them so the pure helpers can be imported without a DB.
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn() }));
vi.mock('@/lib/services/period-lock.service', () => ({
    getCachedLockDate: vi.fn(),
    findLockedDate: vi.fn(),
    toIsoDateString: (d: Date | string) =>
        typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10),
}));

import {
    descriptionMatches,
    ruleMatchesDeposit,
    fundingDedupeKey,
    parseFundingDedupeKey,
    parseAllocations,
    allocationsTotal,
    FundingRuleError,
} from '../funding-rules.service';

const GUID_A = 'a'.repeat(32);
const GUID_B = 'b'.repeat(32);

describe('descriptionMatches', () => {
    it('matches case-insensitive substrings', () => {
        expect(descriptionMatches('acme payroll', 'ACME PAYROLL 2026-07 DIRECT DEP')).toBe(true);
        expect(descriptionMatches('ACME', 'Deposit from acme corp')).toBe(true);
    });

    it('rejects non-matching descriptions', () => {
        expect(descriptionMatches('acme', 'Gumroad payout')).toBe(false);
    });

    it('empty or null pattern matches any description', () => {
        expect(descriptionMatches('', 'anything')).toBe(true);
        expect(descriptionMatches(null, 'anything')).toBe(true);
        expect(descriptionMatches('   ', 'anything')).toBe(true);
        expect(descriptionMatches(undefined, '')).toBe(true);
    });

    it('null description only matches the empty pattern', () => {
        expect(descriptionMatches('acme', null)).toBe(false);
        expect(descriptionMatches('', null)).toBe(true);
    });
});

describe('ruleMatchesDeposit', () => {
    const base = { active: true, triggerDescriptionMatch: 'payroll', minAmount: 1000 };

    it('fires on an active rule with matching description and amount at the minimum', () => {
        expect(ruleMatchesDeposit(base, { description: 'ACME Payroll', amount: 1000 })).toBe(true);
    });

    it('fires above the minimum', () => {
        expect(ruleMatchesDeposit(base, { description: 'ACME Payroll', amount: 2500.55 })).toBe(true);
    });

    it('does not fire below the minimum', () => {
        expect(ruleMatchesDeposit(base, { description: 'ACME Payroll', amount: 999.99 })).toBe(false);
    });

    it('does not fire when inactive', () => {
        expect(ruleMatchesDeposit({ ...base, active: false }, { description: 'ACME Payroll', amount: 5000 })).toBe(false);
    });

    it('does not fire on a description mismatch', () => {
        expect(ruleMatchesDeposit(base, { description: 'Refund', amount: 5000 })).toBe(false);
    });

    it('null min amount means any deposit size', () => {
        expect(ruleMatchesDeposit({ ...base, minAmount: null }, { description: 'payroll', amount: 0.01 })).toBe(true);
    });

    it('empty match means any description', () => {
        expect(ruleMatchesDeposit({ ...base, triggerDescriptionMatch: null }, { description: 'whatever', amount: 1500 })).toBe(true);
    });

    it('never fires on zero or negative amounts (withdrawals)', () => {
        expect(ruleMatchesDeposit({ ...base, minAmount: null }, { description: 'payroll', amount: 0 })).toBe(false);
        expect(ruleMatchesDeposit({ ...base, minAmount: null }, { description: 'payroll', amount: -50 })).toBe(false);
    });
});

describe('funding dedupe key', () => {
    it('round-trips through parse', () => {
        const key = fundingDedupeKey(42, GUID_A);
        expect(key).toBe(`autofund:42:${GUID_A}`);
        expect(parseFundingDedupeKey(key)).toEqual({ ruleId: 42, triggerTxnGuid: GUID_A });
    });

    it('is unique per (rule, deposit) pair', () => {
        expect(fundingDedupeKey(1, GUID_A)).not.toBe(fundingDedupeKey(2, GUID_A));
        expect(fundingDedupeKey(1, GUID_A)).not.toBe(fundingDedupeKey(1, GUID_B));
    });

    it('parse rejects non-autofund nums', () => {
        expect(parseFundingDedupeKey('')).toBeNull();
        expect(parseFundingDedupeKey(null)).toBeNull();
        expect(parseFundingDedupeKey('CHK 1001')).toBeNull();
        expect(parseFundingDedupeKey('autofund:')).toBeNull();
        expect(parseFundingDedupeKey('autofund:xyz:abc')).toBeNull();
        expect(parseFundingDedupeKey('autofund:0:abc')).toBeNull();
        expect(parseFundingDedupeKey('autofund:5:')).toBeNull();
    });
});

describe('parseAllocations', () => {
    it('accepts valid allocations and rounds to cents', () => {
        const result = parseAllocations([
            { accountGuid: GUID_A, amount: 100.005 },
            { accountGuid: GUID_B, amount: 50 },
        ]);
        expect(result).toEqual([
            { accountGuid: GUID_A, amount: 100.01 },
            { accountGuid: GUID_B, amount: 50 },
        ]);
    });

    it('rejects empty lists', () => {
        expect(() => parseAllocations([])).toThrow(FundingRuleError);
        expect(() => parseAllocations(undefined)).toThrow(FundingRuleError);
    });

    it('rejects non-positive amounts', () => {
        expect(() => parseAllocations([{ accountGuid: GUID_A, amount: 0 }])).toThrow(/greater than zero/);
        expect(() => parseAllocations([{ accountGuid: GUID_A, amount: -5 }])).toThrow(/greater than zero/);
    });

    it('rejects invalid account guids', () => {
        expect(() => parseAllocations([{ accountGuid: 'nope', amount: 10 }])).toThrow(/invalid account/);
    });

    it('rejects duplicate envelope accounts', () => {
        expect(() => parseAllocations([
            { accountGuid: GUID_A, amount: 10 },
            { accountGuid: GUID_A, amount: 20 },
        ])).toThrow(/duplicate/);
    });
});

describe('allocationsTotal', () => {
    it('sums to cents without float drift', () => {
        expect(allocationsTotal([
            { accountGuid: GUID_A, amount: 0.1 },
            { accountGuid: GUID_B, amount: 0.2 },
        ])).toBe(0.3);
    });
});
