import { describe, it, expect } from 'vitest';
import { transformToInvestmentRow, costBasisCoverageForRow } from '../investment-utils';
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

describe('transformToInvestmentRow — scrub sub-split summation', () => {
    it('sums ALL same-account splits of a scrubbed multi-lot sell', () => {
        // The scrub engine sub-splits a 10-share sell across three lots.
        // The row must show the WHOLE trade (-10 shares / $1,500), not just
        // the first sub-split.
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '-4',
                value_decimal: '-600',
                lot_guid: 'lot1',
            }),
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '-3.5',
                value_decimal: '-525',
                lot_guid: 'lot2',
            }),
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '-2.5',
                value_decimal: '-375',
                lot_guid: 'lot3',
            }),
            makeSplit({
                account_fullname: 'Assets:Brokerage:Cash',
                quantity_decimal: '1500',
                value_decimal: '1500',
            }),
        ]);

        const row = transformToInvestmentRow(tx, STOCK_GUID);
        expect(row.transactionType).toBe('sell');
        expect(row.shares).toBeCloseTo(-10);
        expect(row.sellAmount).toBeCloseTo(1500);
        // Per-share price from the summed trade, not the first sub-split
        expect(row.price).toBeCloseTo(150);
    });

    it('sums sub-splits of a scrubbed transfer-in across multiple destination lots', () => {
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '6',
                value_decimal: '0',
                lot_guid: 'dest-lot-1',
            }),
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '4',
                value_decimal: '0',
                lot_guid: 'dest-lot-2',
            }),
            makeSplit({
                account_fullname: 'Assets:OldBrokerage:VTSAX',
                quantity_decimal: '-10',
                value_decimal: '0',
            }),
        ]);

        const row = transformToInvestmentRow(tx, STOCK_GUID);
        expect(row.shares).toBeCloseTo(10);
    });
});

describe('classification prefers account_type over fullname prefixes', () => {
    it('detects income/cash counterparties via account_type on renamed roots', () => {
        // Renamed roots ("Einnahmen", "Girokonto") defeat the name walk; the
        // DB-provided account_type must decide.
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Vermoegen:Depot:VTSAX',
                quantity_decimal: '0',
                value_decimal: '0',
                account_type: 'STOCK',
            }),
            makeSplit({
                account_fullname: 'Einnahmen:Dividenden',
                quantity_decimal: '-30',
                value_decimal: '-30',
                account_type: 'INCOME',
            }),
            makeSplit({
                account_fullname: 'Girokonto',
                quantity_decimal: '30',
                value_decimal: '30',
                account_type: 'BANK',
            }),
        ]);

        expect(transformToInvestmentRow(tx, STOCK_GUID).transactionType).toBe('dividend');
    });

    it('treats an account named "Trading Cards" as cash-like when account_type says EXPENSE-free asset', () => {
        // A name-prefix walk would classify "Trading Cards:..." as a TRADING
        // account and mis-type the transaction.
        const tx = makeTx([
            makeSplit({
                account_guid: STOCK_GUID,
                account_fullname: 'Assets:Brokerage:VTSAX',
                quantity_decimal: '10',
                value_decimal: '1000',
                account_type: 'STOCK',
            }),
            makeSplit({
                account_fullname: 'Trading:Broker Sweep',
                quantity_decimal: '-1000',
                value_decimal: '-1000',
                account_type: 'BANK',
            }),
        ]);

        expect(transformToInvestmentRow(tx, STOCK_GUID).transactionType).toBe('buy');
    });
});

/**
 * The ledger's Cost Basis column carries the SAME tri-state coverage the
 * holdings surfaces do. It used to read only `cost_basis`, so a basis covering
 * 150 of 200 shares printed identically to one covering all 200, and an
 * unknown coverage (an oversell) printed as a plain, confident number.
 */
describe('transformToInvestmentRow — cost-basis coverage', () => {
    const stockSplit = () => makeSplit({
        account_guid: STOCK_GUID,
        account_fullname: 'Assets:Brokerage:AAPL',
        quantity_decimal: '100',
        value_decimal: '1000',
        account_type: 'STOCK',
    });
    const cashSplit = () => makeSplit({
        account_fullname: 'Assets:Cash',
        value_decimal: '-1000',
        account_type: 'BANK',
    });

    function rowWith(uncovered: string | null | undefined, shareBalance = '200') {
        const tx = makeTx([stockSplit(), cashSplit()]);
        tx.share_balance = shareBalance;
        tx.cost_basis = '3500';
        if (uncovered !== undefined) {
            (tx as { cost_basis_uncovered_shares?: string | null }).cost_basis_uncovered_shares = uncovered;
        }
        return transformToInvestmentRow(tx, STOCK_GUID);
    }

    it("reads '0' uncovered shares as complete coverage of the whole balance", () => {
        expect(rowWith('0').costBasisCoverage).toEqual({ status: 'complete', coveredShares: 200 });
    });

    it('reads a positive uncovered count as partial, with the covered remainder', () => {
        expect(rowWith('50').costBasisCoverage).toEqual({
            status: 'partial', coveredShares: 150, uncoveredShares: 50, warnings: [],
        });
    });

    /**
     * The coercion this tri-state exists to prevent: `Number(null) === 0`
     * would turn "coverage could not be determined" into "fully covered".
     */
    it('reads null as unknown, NOT as zero uncovered shares', () => {
        const coverage = rowWith(null).costBasisCoverage;
        expect(coverage.status).toBe('unknown');
        expect(coverage).not.toHaveProperty('uncoveredShares');
    });

    it('treats an absent field (non-investment payload) as unknown', () => {
        expect(rowWith(undefined).costBasisCoverage.status).toBe('unknown');
    });

    it('treats unparseable text as unknown rather than as a share count', () => {
        expect(rowWith('not-a-number').costBasisCoverage.status).toBe('unknown');
    });

    it('never reports a negative covered count when uncovered exceeds the balance', () => {
        const coverage = rowWith('250').costBasisCoverage;
        expect(coverage.status).toBe('partial');
        if (coverage.status !== 'partial') throw new Error('expected partial coverage');
        expect(coverage.coveredShares).toBe(0);
        expect(coverage.uncoveredShares).toBe(250);
    });

    it('leaves the basis figure itself untouched', () => {
        expect(rowWith('50').costBasis).toBe(3500);
    });
});

describe('costBasisCoverageForRow', () => {
    it('is exported for surfaces that hold a row shape of their own', () => {
        expect(costBasisCoverageForRow(200, '0')).toEqual({ status: 'complete', coveredShares: 200 });
        expect(costBasisCoverageForRow(200, null).status).toBe('unknown');
    });
});
