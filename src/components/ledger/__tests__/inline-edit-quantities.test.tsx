/**
 * Inline ledger editing must never rewrite a split's share quantity.
 *
 * The PUT handler deletes and recreates splits verbatim from the payload, so a
 * quantity the inline editor recomputes from a dollar amount is written
 * straight over the real position. The transaction still balances in VALUE,
 * so nothing downstream flags it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef, type ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Split } from '@/lib/types';
import EditableSplitRows, {
    hasNonCurrencySplit,
    isNonCurrencySplit,
    type EditableSplitRowsHandle,
} from '../EditableSplitRows';
import { EditableRow, type EditableRowHandle } from '../EditableRow';
import {
    splitFractions,
    inlineTwoSplitPayload,
    DOUBLE_LINE_STORAGE_KEY,
    readDoubleLinePreference,
    writeDoubleLinePreference,
} from '@/components/AccountLedger';
import type { AccountTransaction } from '@/components/AccountLedger';

// EditableRow pulls in preference context and autocomplete cells; stub the
// heavy ones so the double-line tests exercise only the row's own logic.
vi.mock('@/contexts/UserPreferencesContext', () => ({
    useUserPreferences: () => ({
        balanceReversal: 'none',
        dateFormat: 'MM/DD/YYYY',
        defaultTaxRate: 0,
    }),
}));
vi.mock('@/contexts/ToastContext', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../cells/DescriptionCell', () => ({
    DescriptionCell: (props: { value: string; onChange: (v: string) => void }) => (
        <input aria-label="Description" value={props.value} onChange={e => props.onChange(e.target.value)} />
    ),
}));
vi.mock('../cells/AccountCell', () => ({
    AccountCell: (props: { value: string; onChange: (guid: string, name: string) => void }) => (
        <input aria-label="Account" value={props.value} onChange={e => props.onChange(e.target.value, e.target.value)} />
    ),
}));

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

    it('applies a double-line memo edit without resetting either reconcile state', () => {
        const [own, other] = inlineTwoSplitPayload({
            ...base,
            amountChanged: false,
            transferChanged: false,
            ownMemo: 'edited via double-line',
        });

        // The memo edit lands on this account's split only...
        expect(own.memo).toBe('edited via double-line');
        expect(other.memo).toBe('employer deposit');
        // ...and reconcile states survive on BOTH sides: a memo is a user
        // annotation, unrelated to the amounts a statement was reconciled
        // against.
        expect(own.reconcile_state).toBe('y');
        expect(other.reconcile_state).toBe('c');
        expect(own.guid).toBe(OWN.guid);
        expect(other.guid).toBe(OTHER.guid);
        // Stored fractions come back verbatim — a memo edit is not an
        // amount edit.
        expect(own.value_num).toBe(150_000);
        expect(own.quantity_num).toBe(150_000);
    });

    it('clears a memo explicitly when ownMemo is the empty string', () => {
        const [own] = inlineTwoSplitPayload({
            ...base,
            amountChanged: false,
            transferChanged: false,
            ownMemo: '',
        });
        expect(own.memo).toBe('');
        expect(own.reconcile_state).toBe('y');
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

describe('EditableRow double-line view', () => {
    const INCOME_GUID = 'inco0000000000000000000000000001';
    const OWN = makeSplit({
        guid: 'split000000000000000000000000021',
        account_guid: CASH_GUID,
        account_name: 'Checking',
        memo: 'stored own memo',
        reconcile_state: 'y',
        value_num: 150_000, value_denom: 100,
        quantity_num: 150_000, quantity_denom: 100,
    });
    const OTHER = makeSplit({
        guid: 'split000000000000000000000000022',
        account_guid: INCOME_GUID,
        account_name: 'Salary',
        memo: 'other memo',
        reconcile_state: 'c',
        value_num: -150_000, value_denom: 100,
        quantity_num: -150_000, quantity_denom: 100,
    });
    const TX = {
        guid: 'tx00000000000000000000000000002',
        currency_guid: 'usd0000000000000000000000000001',
        num: '1042',
        post_date: new Date('2026-01-15T12:00:00Z'),
        enter_date: new Date('2026-01-15T12:00:00Z'),
        description: 'Paycheck',
        notes: 'stored notes',
        splits: [OWN, OTHER],
        running_balance: '1500.00',
        account_split_value: '1500.00',
        commodity_mnemonic: 'USD',
        account_split_guid: OWN.guid,
        account_split_reconcile_state: 'y',
    } as AccountTransaction;

    function renderRow(overrides: Partial<ComponentProps<typeof EditableRow>> = {}) {
        const ref = createRef<EditableRowHandle>();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
            <table><tbody>
                <EditableRow
                    ref={ref}
                    transaction={TX}
                    accountGuid={CASH_GUID}
                    accountType="BANK"
                    isActive={true}
                    showCheckbox={false}
                    isChecked={false}
                    onToggleCheck={() => {}}
                    onSave={onSave}
                    onEditModal={() => {}}
                    columnCount={7}
                    doubleLine={true}
                    {...overrides}
                />
            </tbody></table>,
        );
        return { ref, onSave };
    }

    it('shows notes and the account split memo on the second line', () => {
        renderRow();
        expect(screen.getByLabelText('Transaction notes')).toHaveValue('stored notes');
        expect(screen.getByLabelText('Split memo')).toHaveValue('stored own memo');
    });

    it('renders no second line when the toggle is off', () => {
        renderRow({ doubleLine: false });
        expect(screen.queryByLabelText('Transaction notes')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Split memo')).not.toBeInTheDocument();
    });

    it('saves edited memo and notes without touching amount fields', async () => {
        const { ref, onSave } = renderRow();

        fireEvent.change(screen.getByLabelText('Transaction notes'), { target: { value: 'new notes' } });
        fireEvent.change(screen.getByLabelText('Split memo'), { target: { value: 'new memo' } });

        expect(ref.current!.isDirty()).toBe(true);
        await ref.current!.save();

        expect(onSave).toHaveBeenCalledTimes(1);
        const [, data] = onSave.mock.calls[0];
        expect(data).toMatchObject({
            memo: 'new memo',
            notes: 'new notes',
            // Amount is untouched, so handleInlineSave computes
            // amountChanged=false and reconcile states survive.
            amount: '1500.00',
            description: 'Paycheck',
        });
    });

    it('omits memo and notes from the payload when untouched', async () => {
        const { ref, onSave } = renderRow();

        fireEvent.change(screen.getByLabelText('Transaction notes'), { target: { value: 'only notes changed' } });
        await ref.current!.save();

        const [, data] = onSave.mock.calls[0];
        expect(data.notes).toBe('only notes changed');
        expect(data).not.toHaveProperty('memo');
    });

    it('is not dirty until a double-line field actually changes', () => {
        const { ref } = renderRow();
        expect(ref.current!.isDirty()).toBe(false);
    });

    it('carries edited notes through getTransactionData for journal saves', () => {
        const { ref } = renderRow({ ledgerViewStyle: 'journal' });
        fireEvent.change(screen.getByLabelText('Transaction notes'), { target: { value: 'journal notes' } });
        expect(ref.current!.isDirty()).toBe(true);
        expect(ref.current!.getTransactionData()).toMatchObject({
            description: 'Paycheck',
            notes: 'journal notes',
        });
    });
});

describe('double-line view preference persistence', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('defaults to single-line', () => {
        expect(readDoubleLinePreference()).toBe(false);
    });

    it('round-trips through localStorage like other ledger view state', () => {
        writeDoubleLinePreference(true);
        expect(localStorage.getItem(DOUBLE_LINE_STORAGE_KEY)).toBe('true');
        expect(readDoubleLinePreference()).toBe(true);

        writeDoubleLinePreference(false);
        expect(readDoubleLinePreference()).toBe(false);
    });

    it('treats junk stored values as off', () => {
        localStorage.setItem(DOUBLE_LINE_STORAGE_KEY, 'banana');
        expect(readDoubleLinePreference()).toBe(false);
    });
});
