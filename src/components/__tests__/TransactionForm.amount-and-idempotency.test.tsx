/**
 * Two accounting-integrity regressions in the transaction entry form:
 *
 * 1. The amount field used `parseFloat(amount) || 0`, so a pasted
 *    "$1,234.56" passed validation (NaN <= 0 is false) and then booked
 *    $0.00, and "1,234.56" booked $1.00 — both reported as a success.
 * 2. Ctrl+Enter / Ctrl+Shift+Enter are WINDOW-level listeners, so they
 *    bypassed `disabled={saving}` on the buttons: pressing twice during a
 *    slow POST created two identical ledger entries. Creates now also carry
 *    a stable per-form-open guid so a retry collapses onto one record.
 *
 * These tests use the REAL keyboard hooks (no mock) so the window listeners
 * are exercised end to end.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionForm } from '../TransactionForm';

// Rendered as a plain input so advanced mode (several selectors sharing one
// placeholder) can be addressed by index.
vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: (props: {
        value: string;
        onChange: (guid: string, name: string) => void;
        placeholder?: string;
    }) => (
        <input
            aria-label={`account:${props.placeholder}`}
            value={props.value}
            onChange={e => props.onChange(e.target.value, `Account ${e.target.value.slice(0, 4)}`)}
        />
    ),
}));

vi.mock('@/components/ui/DescriptionAutocomplete', () => ({
    DescriptionAutocomplete: (props: { value: string; onChange: (v: string) => void }) => (
        <input aria-label="Description" value={props.value} onChange={e => props.onChange(e.target.value)} />
    ),
}));

vi.mock('@/lib/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [], isLoading: false }) }));
vi.mock('@/contexts/UserPreferencesContext', () => ({
    useUserPreferences: () => ({ defaultTaxRate: 0, dateFormat: 'MM/DD/YYYY' }),
}));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/hooks/useKeyboardShortcut', () => ({ useKeyboardShortcut: () => {} }));

const USD = 'usd0000000000000000000000000001';
const FROM = 'from0000000000000000000000000001';
const TO = 'to000000000000000000000000000001';

function fillSimpleEntry(amount: string, description = 'Lunch') {
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: description } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: amount } });
    fireEvent.change(screen.getByLabelText('account:Select source account...'), { target: { value: FROM } });
    fireEvent.change(screen.getByLabelText('account:Select destination account...'), { target: { value: TO } });
}

/** Switch to advanced mode and type one debit and one credit split. */
function fillAdvancedEntry(debit: string, credit: string, description = 'Split entry') {
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: description } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Advanced (Multiple Splits)' }));

    const accounts = screen.getAllByLabelText('account:Select account...');
    fireEvent.change(accounts[0], { target: { value: FROM } });
    fireEvent.change(accounts[1], { target: { value: TO } });
    fireEvent.change(screen.getAllByPlaceholderText('Debit')[0], { target: { value: debit } });
    fireEvent.change(screen.getAllByPlaceholderText('Credit')[1], { target: { value: credit } });
}

const ctrlEnter = () => new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true });
const ctrlShiftEnter = () => new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true });

beforeEach(() => {
    vi.clearAllMocks();
});

describe('simple-mode amount parsing', () => {
    it.each([
        ['$1,234.56'],
        ['1,234.56'],
        ['1234.56'],
    ])('books %s as 1234.56', async (typed) => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fillSimpleEntry(typed);
        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const [data] = onSave.mock.calls[0];
        expect(data.splits[0].value_num).toBe(-123456);
        expect(data.splits[1].value_num).toBe(123456);
        expect(data.splits[0].value_denom).toBe(100);
    });

    it.each([
        ['abc', 'is not a valid amount'],
        ['1.2.3', 'is not a valid amount'],
        ['', 'Amount is required'],
    ])('refuses to save %s and shows an inline error', async (typed, message) => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fillSimpleEntry(typed);
        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        within(await screen.findByTestId('form-errors')).getByText(new RegExp(message));
        expect(onSave).not.toHaveBeenCalled();
    });

    it('still evaluates a math expression in the amount field', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fillSimpleEntry('20+5.5');
        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0][0].splits[1].value_num).toBe(2550);
    });
});

describe('advanced-mode split amount parsing', () => {
    it('books a debit/credit pair typed as 1,234.56 at full value, not $1.00', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fillAdvancedEntry('1,234.56', '1,234.56');
        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const [data] = onSave.mock.calls[0];
        // Both sides used to parseFloat to 1 — balanced, and $1.00 was posted.
        expect(data.splits[0].value_num).toBe(123456);
        expect(data.splits[1].value_num).toBe(-123456);
    });

    it('refuses to post when a split amount is malformed, even if it "balances"', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        // Both sides used to coerce to 0, so the balance check passed and a
        // $0.00 transaction was posted.
        fillAdvancedEntry('abc', 'abc');
        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        const errorList = await screen.findByTestId('form-errors');
        within(errorList).getByText(/Enter a valid amount/);
        expect(within(errorList).queryByText(/unbalanced/i)).toBeNull();
        expect(onSave).not.toHaveBeenCalled();
    });

    it('refuses to post when only one split amount is malformed', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fillAdvancedEntry('1,23', '25.00');
        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        within(await screen.findByTestId('form-errors')).getByText(/Enter a valid amount/);
        expect(onSave).not.toHaveBeenCalled();
    });

    it('still accepts a math expression in a split box', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fillAdvancedEntry('20+5.5', '25.50');
        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0][0].splits[0].value_num).toBe(2550);
    });
});

describe('duplicate-submit protection', () => {
    it('ignores a second Ctrl+Enter while the first save is in flight', async () => {
        let release: () => void = () => {};
        const onSave = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fillSimpleEntry('25.00');

        await act(async () => {
            window.dispatchEvent(ctrlEnter());
            window.dispatchEvent(ctrlEnter());
        });

        expect(onSave).toHaveBeenCalledTimes(1);
        await act(async () => { release(); });
    });

    it('ignores a second Ctrl+Shift+Enter while save-and-another is in flight', async () => {
        let release: () => void = () => {};
        const onSaveAndAnother = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
        render(
            <TransactionForm
                onSave={vi.fn()}
                onSaveAndAnother={onSaveAndAnother}
                onCancel={() => {}}
                defaultCurrencyGuid={USD}
            />
        );

        fillSimpleEntry('25.00');

        await act(async () => {
            window.dispatchEvent(ctrlShiftEnter());
            window.dispatchEvent(ctrlShiftEnter());
        });

        expect(onSaveAndAnother).toHaveBeenCalledTimes(1);
        await act(async () => { release(); });
    });

    it('sends a client guid and reuses it when a failed save is retried', async () => {
        const onSave = vi.fn()
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} defaultCurrencyGuid={USD} />);

        fillSimpleEntry('25.00');

        await act(async () => { window.dispatchEvent(ctrlEnter()); });
        await act(async () => { window.dispatchEvent(ctrlEnter()); });

        expect(onSave).toHaveBeenCalledTimes(2);
        const first = onSave.mock.calls[0][0].guid;
        const second = onSave.mock.calls[1][0].guid;
        expect(first).toMatch(/^[0-9a-f]{32}$/);
        // Same key on the retry → the server dedupes instead of creating a
        // second ledger entry (POST /api/transactions honors a client guid).
        expect(second).toBe(first);
    });

    it('gives the next save-and-another entry its own guid', async () => {
        const onSaveAndAnother = vi.fn().mockResolvedValue(undefined);
        render(
            <TransactionForm
                onSave={vi.fn()}
                onSaveAndAnother={onSaveAndAnother}
                onCancel={() => {}}
                defaultCurrencyGuid={USD}
            />
        );

        fillSimpleEntry('25.00', 'First');
        await act(async () => { window.dispatchEvent(ctrlShiftEnter()); });

        fillSimpleEntry('30.00', 'Second');
        await act(async () => { window.dispatchEvent(ctrlShiftEnter()); });

        expect(onSaveAndAnother).toHaveBeenCalledTimes(2);
        const [first, second] = onSaveAndAnother.mock.calls.map(c => c[0].guid);
        expect(first).toMatch(/^[0-9a-f]{32}$/);
        expect(second).toMatch(/^[0-9a-f]{32}$/);
        expect(second).not.toBe(first);
    });

    it('omits the client guid when editing an existing transaction', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
            <TransactionForm
                transaction={{
                    guid: 'ffff0000000000000000000000000001',
                    currency_guid: USD,
                    post_date: '2026-08-01',
                    description: 'Lunch',
                    num: '',
                    splits: [
                        {
                            guid: 'aaaa0000000000000000000000000001',
                            account_guid: 'from0000000000000000000000000001',
                            account_name: 'Checking',
                            quantity_decimal: '-25.00',
                            value_decimal: '-25.00',
                            memo: '',
                            reconcile_state: 'n',
                        },
                        {
                            guid: 'bbbb0000000000000000000000000001',
                            account_guid: 'to000000000000000000000000000001',
                            account_name: 'Dining',
                            quantity_decimal: '25.00',
                            value_decimal: '25.00',
                            memo: '',
                            reconcile_state: 'n',
                        },
                    ],
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any}
                onSave={onSave}
                onCancel={() => {}}
                defaultCurrencyGuid={USD}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: 'Update Transaction' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        // Edits are keyed by the URL guid; the body must not carry a new one.
        expect(onSave.mock.calls[0][0].guid).toBeUndefined();
    });
});
