/**
 * Inline ledger editing must never rewrite a split's share quantity.
 *
 * The PUT handler deletes and recreates splits verbatim from the payload, so a
 * quantity the inline editor recomputes from a dollar amount is written
 * straight over the real position. The transaction still balances in VALUE,
 * so nothing downstream flags it.
 */

import { describe, it, expect } from 'vitest';
import { createRef } from 'react';
import { render } from '@testing-library/react';
import type { Split } from '@/lib/types';
import EditableSplitRows, {
    hasNonCurrencySplit,
    isNonCurrencySplit,
    type EditableSplitRowsHandle,
} from '../EditableSplitRows';
import { splitFractions, inlineTwoSplitPayload } from '@/components/AccountLedger';
import type { AccountTransaction } from '@/components/AccountLedger';

const CASH_GUID = 'cash0000000000000000000000000001';
const STOCK_GUID = 'stok0000000000000000000000000001';

function makeSplit(overrides: Partial<Split>): Split {
    return {
        guid: 'split000000000000000000000000001',
        tx_guid: 'tx00000000000000000000000000001',
        account_guid: CASH_GUID,
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: 0,
        value_denom: 100,
        quantity_num: 0,
        quantity_denom: 100,
        lot_guid: null,
        ...overrides,
    };
}

/** 10.0000 shares bought for $2,500 — the security split holds 100000/10000. */
const STOCK_SPLIT = makeSplit({
    guid: 'split000000000000000000000000002',
    account_guid: STOCK_GUID,
    account_name: 'VTI',
    account_fullname: 'Assets:Brokerage:VTI',
    value_num: 250_000,
    value_denom: 100,
    quantity_num: 100_000,
    quantity_denom: 10_000,
    value_decimal: '2500.00',
    quantity_decimal: '10.0000',
    commodity_mnemonic: 'VTI',
});

const CASH_SPLIT = makeSplit({
    account_guid: CASH_GUID,
    account_name: 'Checking',
    account_fullname: 'Assets:Checking',
    value_num: -250_000,
    value_denom: 100,
    quantity_num: -250_000,
    quantity_denom: 100,
    value_decimal: '-2500.00',
    quantity_decimal: '-2500.00',
    commodity_mnemonic: 'USD',
});

describe('isNonCurrencySplit', () => {
    it('flags a share split', () => {
        expect(isNonCurrencySplit(STOCK_SPLIT)).toBe(true);
    });

    it('does not flag a plain currency split', () => {
        expect(isNonCurrencySplit(CASH_SPLIT)).toBe(false);
    });

    it('flags a foreign-currency split whose value and quantity differ', () => {
        expect(isNonCurrencySplit(makeSplit({
            value_num: 10_000, value_denom: 100,
            quantity_num: 8_500, quantity_denom: 100,
        }))).toBe(true);
    });

    it('detects the mixed transaction the 2-split inline editor can reach', () => {
        // isMultiSplitTransaction() returns false here, so this IS inline editable.
        expect(hasNonCurrencySplit([CASH_SPLIT, STOCK_SPLIT])).toBe(true);
        expect(hasNonCurrencySplit([CASH_SPLIT, makeSplit({ value_num: 250_000, quantity_num: 250_000 })]))
            .toBe(false);
    });
});

describe('splitFractions', () => {
    it('carries the stored share quantity through an untouched amount', () => {
        // Regression: editing only the description used to rewrite the
        // security split's quantity from 100000/10000 to 250000/100.
        expect(splitFractions(STOCK_SPLIT, 2500, true)).toEqual({
            value_num: 250_000,
            value_denom: 100,
            quantity_num: 100_000,
            quantity_denom: 10_000,
        });
    });

    it('leaves the quantity alone when only the value is edited', () => {
        expect(splitFractions(STOCK_SPLIT, 2600, false)).toEqual({
            value_num: 260_000,
            value_denom: 100,
            quantity_num: 100_000,
            quantity_denom: 10_000,
        });
    });

    it('mirrors value into quantity for a plain currency split', () => {
        expect(splitFractions(CASH_SPLIT, -2600, false)).toEqual({
            value_num: -260_000,
            value_denom: 100,
            quantity_num: -260_000,
            quantity_denom: 100,
        });
    });

    it('preserves a non-100 currency denominator', () => {
        const fineSplit = makeSplit({ value_num: 12_345_678, value_denom: 1_000_000, quantity_num: 12_345_678, quantity_denom: 1_000_000 });
        expect(splitFractions(fineSplit, 20, false)).toEqual({
            value_num: 20_000_000,
            value_denom: 1_000_000,
            quantity_num: 20_000_000,
            quantity_denom: 1_000_000,
        });
    });

    it('falls back to cents for a split that does not exist yet', () => {
        expect(splitFractions(undefined, 12.34, false)).toEqual({
            value_num: 1_234,
            value_denom: 100,
            quantity_num: 1_234,
            quantity_denom: 100,
        });
    });
});

describe('inlineTwoSplitPayload', () => {
    // The PUT handler recreates splits verbatim, so anything the inline row
    // omits is destroyed: memos vanish and the counter-split un-reconciles.
    const OWN = makeSplit({
        guid: 'split000000000000000000000000010',
        account_guid: CASH_GUID,
        account_name: 'Checking',
        memo: 'paycheck stub 42',
        reconcile_state: 'y',
        value_num: 150_000, value_denom: 100,
        quantity_num: 150_000, quantity_denom: 100,
    });
    const OTHER = makeSplit({
        guid: 'split000000000000000000000000011',
        account_guid: 'inco0000000000000000000000000001',
        account_name: 'Salary',
        memo: 'employer deposit',
        reconcile_state: 'c',
        value_num: -150_000, value_denom: 100,
        quantity_num: -150_000, quantity_denom: 100,
    });

    const base = {
        accountGuid: CASH_GUID,
        ownSplit: OWN,
        otherSplit: OTHER,
        transferAccountGuid: OTHER.account_guid,
        signedAmount: 1500,
        ownReconcileState: 'y',
    };

    it('round-trips memos and reconcile states through a description-only save', () => {
        const [own, other] = inlineTwoSplitPayload({
            ...base,
            amountChanged: false,
            transferChanged: false,
        });

        expect(own.memo).toBe('paycheck stub 42');
        expect(own.reconcile_state).toBe('y');
        expect(own.guid).toBe(OWN.guid);

        // The counter-split was not touched at all: it must come back intact.
        expect(other.memo).toBe('employer deposit');
        expect(other.reconcile_state).toBe('c');
        expect(other.guid).toBe(OTHER.guid);

        expect(own.value_num).toBe(150_000);
        expect(other.value_num).toBe(-150_000);
    });

    it('un-reconciles both sides when the amount changes', () => {
        const [own, other] = inlineTwoSplitPayload({
            ...base,
            signedAmount: 1600,
            amountChanged: true,
            transferChanged: false,
        });

        expect(own.reconcile_state).toBe('n');
        expect(other.reconcile_state).toBe('n');
        // Memos are user annotations, unrelated to the amount.
        expect(own.memo).toBe('paycheck stub 42');
        expect(other.memo).toBe('employer deposit');
        expect(own.value_num).toBe(160_000);
        expect(other.value_num).toBe(-160_000);
    });

    it('treats a retargeted transfer as a fresh split', () => {
        const [own, other] = inlineTwoSplitPayload({
            ...base,
            transferAccountGuid: 'othr0000000000000000000000000001',
            amountChanged: false,
            transferChanged: true,
        });

        expect(own.reconcile_state).toBe('y');
        expect(own.memo).toBe('paycheck stub 42');
        expect(other.account_guid).toBe('othr0000000000000000000000000001');
        expect(other.reconcile_state).toBe('n');
        expect(other.memo).toBe('');
        expect(other.guid).toBeUndefined();
    });

    it('defaults cleanly when the transaction has no stored counter-split', () => {
        const [own, other] = inlineTwoSplitPayload({
            accountGuid: CASH_GUID,
            transferAccountGuid: 'othr0000000000000000000000000001',
            signedAmount: 12.34,
            amountChanged: true,
            transferChanged: false,
        });

        expect(own).toMatchObject({ memo: '', reconcile_state: 'n', value_num: 1_234, value_denom: 100 });
        expect(other).toMatchObject({ memo: '', reconcile_state: 'n', value_num: -1_234, value_denom: 100 });
        expect(own.guid).toBeUndefined();
    });
});

describe('EditableSplitRows.getSplitPayload', () => {
    const transaction = {
        guid: 'tx00000000000000000000000000001',
        currency_guid: 'usd0000000000000000000000000001',
        num: '',
        post_date: new Date('2026-01-15T12:00:00Z'),
        enter_date: new Date('2026-01-15T12:00:00Z'),
        description: 'Buy VTI',
        splits: [CASH_SPLIT, STOCK_SPLIT],
        running_balance: '0',
        account_split_value: '-2500.00',
        commodity_mnemonic: 'USD',
        account_split_guid: CASH_SPLIT.guid,
        account_split_reconcile_state: 'n',
    } as AccountTransaction;

    it('returns the stored fractions verbatim when nothing was edited', () => {
        const ref = createRef<EditableSplitRowsHandle>();
        render(
            <table><tbody>
                <EditableSplitRows
                    ref={ref}
                    transaction={transaction}
                    accountGuid={CASH_GUID}
                    columns={6}
                    isActive={false}
                />
            </tbody></table>,
        );

        const payload = ref.current!.getSplitPayload();
        const stock = payload.find(s => s.account_guid === STOCK_GUID)!;

        // Was 250000/100 — 2,500 shares instead of 10.
        expect(stock.quantity_num).toBe(100_000);
        expect(stock.quantity_denom).toBe(10_000);
        expect(stock.value_num).toBe(250_000);
        expect(stock.value_denom).toBe(100);

        expect(payload.reduce((sum, s) => sum + s.value_num / s.value_denom, 0)).toBe(0);
    });

    it('carries memos and reconcile states of untouched splits', () => {
        const reconciled = {
            ...transaction,
            splits: [
                { ...CASH_SPLIT, memo: 'check 1042', reconcile_state: 'y' },
                { ...STOCK_SPLIT, memo: 'lot A', reconcile_state: 'c' },
            ],
        } as AccountTransaction;

        const ref = createRef<EditableSplitRowsHandle>();
        render(
            <table><tbody>
                <EditableSplitRows
                    ref={ref}
                    transaction={reconciled}
                    accountGuid={CASH_GUID}
                    columns={6}
                    isActive={false}
                />
            </tbody></table>,
        );

        const payload = ref.current!.getSplitPayload();
        expect(payload.find(s => s.account_guid === CASH_GUID)).toMatchObject({
            memo: 'check 1042',
            reconcile_state: 'y',
        });
        expect(payload.find(s => s.account_guid === STOCK_GUID)).toMatchObject({
            memo: 'lot A',
            reconcile_state: 'c',
        });
    });
});
