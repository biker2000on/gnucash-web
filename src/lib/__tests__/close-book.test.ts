import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: { $queryRaw: vi.fn(), $executeRaw: vi.fn(), $transaction: vi.fn() },
}));

import { buildClosingTransactions, type CloseBookAccountRow } from '../close-book';

const acct = (over: Partial<CloseBookAccountRow>): CloseBookAccountRow => ({
    guid: 'g'.repeat(32),
    name: 'x',
    fullname: 'Income:x',
    account_type: 'INCOME',
    commodity_guid: 'usd',
    balance: 0,
    ...over,
});

describe('buildClosingTransactions', () => {
    it('negates income balances and offsets equity so the transaction balances', () => {
        const accounts = [
            acct({ guid: 'a'.repeat(32), balance: -5000 }),   // income earned (negative)
            acct({ guid: 'b'.repeat(32), balance: -1500.25 }),
        ];
        const [spec] = buildClosingTransactions(accounts, 'INCOME', 'Closing');
        expect(spec.splits).toEqual([
            { accountGuid: 'a'.repeat(32), amount: 5000 },
            { accountGuid: 'b'.repeat(32), amount: 1500.25 },
        ]);
        expect(spec.equityAmount).toBeCloseTo(-6500.25);
        const total = spec.splits.reduce((s, x) => s + x.amount, 0) + spec.equityAmount;
        expect(total).toBeCloseTo(0);
    });

    it('negates expense balances (positive) into negative splits', () => {
        const accounts = [
            acct({ guid: 'c'.repeat(32), account_type: 'EXPENSE', fullname: 'Expenses:Food', balance: 1200.4 }),
        ];
        const [spec] = buildClosingTransactions(accounts, 'EXPENSE', 'Closing');
        expect(spec.splits[0].amount).toBeCloseTo(-1200.4);
        expect(spec.equityAmount).toBeCloseTo(1200.4);
    });

    it('skips zero balances and the other account type', () => {
        const accounts = [
            acct({ guid: 'a'.repeat(32), balance: 0.004 }),
            acct({ guid: 'b'.repeat(32), account_type: 'EXPENSE', balance: 10 }),
        ];
        expect(buildClosingTransactions(accounts, 'INCOME', 'x')).toEqual([]);
    });

    it('groups by currency into separate transactions', () => {
        const accounts = [
            acct({ guid: 'a'.repeat(32), balance: -100, commodity_guid: 'usd' }),
            acct({ guid: 'b'.repeat(32), balance: -200, commodity_guid: 'eur' }),
        ];
        const specs = buildClosingTransactions(accounts, 'INCOME', 'x');
        expect(specs).toHaveLength(2);
        expect(new Set(specs.map(s => s.currencyGuid))).toEqual(new Set(['usd', 'eur']));
    });

    it('rounds to cents so fractions never unbalance', () => {
        const accounts = [
            acct({ guid: 'a'.repeat(32), balance: -33.333333 }),
            acct({ guid: 'b'.repeat(32), balance: -66.666667 }),
        ];
        const [spec] = buildClosingTransactions(accounts, 'INCOME', 'x');
        const total = spec.splits.reduce((s, x) => s + Math.round(x.amount * 100), 0) + Math.round(spec.equityAmount * 100);
        expect(total).toBe(0);
    });
});
