/**
 * Exact rational balance validation shared by the two server-side write paths.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertBalanced, validateTransaction } from '@/lib/validation';

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

describe('assertBalanced', () => {
    it('accepts non-decimal denominators without floating-point conversion', () => {
        // 1/3 + 1/3 + 1/3 - 1 is exactly zero in rationals.
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

    it('rejects the sub-cent imbalance the former 0.001 float tolerance accepted', () => {
        // 1/2000 = $0.0005: Math.abs(0.0005) <= 0.001 used to pass.
        expect(() => assertBalanced([
            { value_num: 1, value_denom: 2000 },
            { value_num: 0, value_denom: 1 },
        ])).toThrow('1/2000');
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

    it('rejects the former float-tolerance case', () => {
        const result = validateTransaction({
            currency_guid: CURRENCY,
            post_date: '2026-07-15',
            description: 'Sub-cent imbalance',
            splits: [
                { account_guid: ACCOUNT_A, value_num: 1, value_denom: 2000 },
                { account_guid: ACCOUNT_B, value_num: 0, value_denom: 1 },
            ],
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.message.includes('1/2000'))).toBe(true);
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

    it('rejects the former float-tolerance case', async () => {
        const { TransactionService } = await import('@/lib/services/transaction.service');
        await expect(TransactionService.create({
            currency_guid: CURRENCY,
            post_date: new Date('2026-07-15'),
            description: 'Sub-cent imbalance',
            num: '',
            splits: [
                { account_guid: ACCOUNT_A, value_num: 1, value_denom: 2000, memo: '', action: '', reconcile_state: 'n' },
                { account_guid: ACCOUNT_B, value_num: 0, value_denom: 1, memo: '', action: '', reconcile_state: 'n' },
            ],
        })).rejects.toThrow('1/2000');
    });
});

describe('single source of truth', () => {
    it('both server paths call the shared exact helper', () => {
        const validation = readFileSync(join(SRC, 'lib/validation.ts'), 'utf8');
        const service = readFileSync(join(SRC, 'lib/services/transaction.service.ts'), 'utf8');

        expect(validation).toContain('assertBalanced(tx.splits)');
        expect(service).toMatch(/import \{ assertBalanced \} from '@\/lib\/validation'/);
        expect(service).toContain('assertBalanced(data.splits)');
        expect(validation).not.toContain('BALANCE_TOLERANCE');
        expect(service).not.toContain('BALANCE_TOLERANCE');
    });
});
