import { describe, it, expect } from 'vitest';
import { transformToInvestmentRow } from '../investment-utils';
import type { Split } from '@/lib/types';
import type { AccountTransaction } from '../../AccountLedger';

const STOCK_GUID = 'stock-acct';

function makeSplit(over: Partial<Split>): Split {
    return {
        guid: 's-' + Math.random().toString(36).slice(2),
        tx_guid: 'tx1',
        account_guid: 'other-acct',
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: 0,
        value_denom: 100,
        quantity_num: 0,
        quantity_denom: 100,
        lot_guid: null,
        ...over,
    };
}

function makeTx(splits: Split[]): AccountTransaction & { share_balance?: string; cost_basis?: string } {
    return {
        guid: 'tx1',
        currency_guid: 'usd',
        num: '',
        post_date: '2026-01-15',
        description: 'test',
        splits,
        share_balance: '100',
        cost_basis: '1000',
    } as unknown as AccountTransaction & { share_balance?: string; cost_basis?: string };
}

describe('transformToInvestmentRow — realized gain/loss', () => {
    it('classifies a lot-close gains transaction as realized_gain with the gain amount', () => {
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Investments:Brokerage:FZROX',
                quantity_decimal: '0',
                value_decimal: '139.49',
                lot_guid: 'lot1',
            }),
            makeSplit({
                account_fullname: 'Income:Capital Gains:Short Term',
                quantity_decimal: '0',
                value_decimal: '-139.49',
                commodity_mnemonic: 'USD',
            }),
        ]);

        const row = transformToInvestmentRow(tx, STOCK_GUID);
        expect(row.transactionType).toBe('realized_gain');
        expect(row.gainAmount).toBeCloseTo(139.49);
        expect(row.shares).toBeNull();
        expect(row.buyAmount).toBeNull();
        expect(row.sellAmount).toBeNull();
    });

    it('classifies a realized loss (negative value) as realized_gain with negative gainAmount', () => {
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Investments:Brokerage:VTSAX',
                quantity_decimal: '0',
                value_decimal: '-52.10',
                lot_guid: 'lot2',
            }),
            makeSplit({
                account_fullname: 'Income:Capital Gains:Long Term',
                quantity_decimal: '0',
                value_decimal: '52.10',
                commodity_mnemonic: 'USD',
            }),
        ]);

        const row = transformToInvestmentRow(tx, STOCK_GUID);
        expect(row.transactionType).toBe('realized_gain');
        expect(row.gainAmount).toBeCloseTo(-52.10);
    });

    it('recognizes income accounts behind a book-name placeholder segment', () => {
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'My Finances:Assets:Brokerage:FZROX',
                quantity_decimal: '0',
                value_decimal: '10',
                lot_guid: 'lot3',
            }),
            makeSplit({
                account_fullname: 'My Finances:Income:Capital Gains:Short Term',
                quantity_decimal: '0',
                value_decimal: '-10',
            }),
        ]);

        expect(transformToInvestmentRow(tx, STOCK_GUID).transactionType).toBe('realized_gain');
    });

    it('still classifies return of capital (cash in, no income offset)', () => {
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '0',
                value_decimal: '-25',
            }),
            makeSplit({
                account_fullname: 'Assets:Brokerage:Cash',
                quantity_decimal: '25',
                value_decimal: '25',
            }),
        ]);

        expect(transformToInvestmentRow(tx, STOCK_GUID).transactionType).toBe('return_of_capital');
    });

    it('still classifies dividends (income + cash, zero shares)', () => {
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '0',
                value_decimal: '0',
            }),
            makeSplit({
                account_fullname: 'Income:Dividends:VTSAX',
                quantity_decimal: '-30',
                value_decimal: '-30',
            }),
            makeSplit({
                account_fullname: 'Assets:Brokerage:Cash',
                quantity_decimal: '30',
                value_decimal: '30',
            }),
        ]);

        expect(transformToInvestmentRow(tx, STOCK_GUID).transactionType).toBe('dividend');
    });

    it('still classifies buys and sells with gainAmount null', () => {
        const buy = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '10',
                value_decimal: '1000',
            }),
            makeSplit({
                account_fullname: 'Assets:Brokerage:Cash',
                quantity_decimal: '-1000',
                value_decimal: '-1000',
            }),
        ]);
        const buyRow = transformToInvestmentRow(buy, STOCK_GUID);
        expect(buyRow.transactionType).toBe('buy');
        expect(buyRow.gainAmount).toBeNull();
        expect(buyRow.buyAmount).toBeCloseTo(1000);

        const sell = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '-10',
                value_decimal: '-1100',
            }),
            makeSplit({
                account_fullname: 'Assets:Brokerage:Cash',
                quantity_decimal: '1100',
                value_decimal: '1100',
            }),
        ]);
        const sellRow = transformToInvestmentRow(sell, STOCK_GUID);
        expect(sellRow.transactionType).toBe('sell');
        expect(sellRow.sellAmount).toBeCloseTo(1100);
    });
});
