/**
 * BALANCE_TOLERANCE — the single double-entry balance tolerance shared by the
 * two server-side create paths.
 *
 * `validation.ts` previously carried a comment claiming "1 cent / 100 = 0.01"
 * next to a `> 0.001` test, and `transaction.service.ts` repeated the same bare
 * literal. These tests pin the value, its rationale, and the fact that both
 * paths now agree.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BALANCE_TOLERANCE, validateTransaction } from '@/lib/validation';

vi.mock('@/lib/prisma', () => ({
    default: { $transaction: vi.fn(), transactions: {}, splits: {} },
}));
vi.mock('@/lib/services/period-lock.service', () => ({ assertAccountNotLocked: vi.fn() }));
vi.mock('@/lib/services/implied-price.service', () => ({ recordImpliedPrices: vi.fn() }));
vi.mock('@/lib/services/reconciled-split.service', () => ({
    assertNoReconciledSplits: vi.fn(),
    assertSplitsNotProtected: vi.fn(),
}));

const ACCOUNT_A = 'a'.repeat(32);
const ACCOUNT_B = 'b'.repeat(32);
const CURRENCY = 'd'.repeat(32);
const SRC = join(process.cwd(), 'src');

function txWithImbalance(cents: number) {
    return {
        currency_guid: CURRENCY,
        post_date: '2026-07-15',
        description: 'Test',
        splits: [
            { account_guid: ACCOUNT_A, value_num: 100000, value_denom: 100 },
            { account_guid: ACCOUNT_B, value_num: -100000 + cents, value_denom: 100 },
        ],
    };
}

describe('BALANCE_TOLERANCE', () => {
    it('is a tenth of a cent — tight enough to catch a one-cent error', () => {
        expect(BALANCE_TOLERANCE).toBe(0.001);
        expect(BALANCE_TOLERANCE).toBeLessThan(0.01);
    });

    it('absorbs the floating-point residue of an exactly-balanced split set', () => {
        // 1/3 + 1/3 + 1/3 - 1 is exactly zero in rationals but not in doubles.
        const thirds = validateTransaction({
            currency_guid: CURRENCY,
            post_date: '2026-07-15',
            description: 'Thirds',
            splits: [
                { account_guid: ACCOUNT_A, value_num: 1, value_denom: 3 },
                { account_guid: ACCOUNT_A, value_num: 1, value_denom: 3 },
                { account_guid: ACCOUNT_A, value_num: 1, value_denom: 3 },
                { account_guid: ACCOUNT_B, value_num: -1, value_denom: 1 },
            ],
        });
        expect(thirds.errors.filter(e => e.message.includes('sum to zero'))).toHaveLength(0);
    });
});

describe('validateTransaction (API route path)', () => {
    it('accepts an exactly balanced transaction', () => {
        expect(validateTransaction(txWithImbalance(0)).valid).toBe(true);
    });

    it('rejects a one-cent imbalance', () => {
        const result = validateTransaction(txWithImbalance(1));
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.message.includes('Splits must sum to zero'))).toBe(true);
    });
});

describe('TransactionService.create (service path)', () => {
    it('rejects the same one-cent imbalance the route rejects', async () => {
        const { TransactionService } = await import('@/lib/services/transaction.service');
        await expect(TransactionService.create({
            currency_guid: CURRENCY,
            post_date: new Date('2026-07-15'),
            description: 'Test',
            num: '',
            splits: [
                { account_guid: ACCOUNT_A, value_num: 100000, value_denom: 100, memo: '', action: '', reconcile_state: 'n' },
                { account_guid: ACCOUNT_B, value_num: -99999, value_denom: 100, memo: '', action: '', reconcile_state: 'n' },
            ],
        })).rejects.toThrow('must sum to zero');
    });
});

describe('single source of truth', () => {
    it('both server paths reference the constant instead of a bare literal', () => {
        const validation = readFileSync(join(SRC, 'lib/validation.ts'), 'utf8');
        const service = readFileSync(join(SRC, 'lib/services/transaction.service.ts'), 'utf8');

        expect(validation).toMatch(/Math\.abs\(sum\) > BALANCE_TOLERANCE/);
        expect(service).toMatch(/Math\.abs\(total\) > BALANCE_TOLERANCE/);
        expect(service).toMatch(/import \{ BALANCE_TOLERANCE \} from '@\/lib\/validation'/);

        // The old misleading "1 cent / 100 = 0.01" comment is gone, and neither
        // file re-declares the threshold as a literal.
        expect(validation).not.toContain('1 cent / 100');
        expect(service).not.toContain('> 0.001');
    });
});
