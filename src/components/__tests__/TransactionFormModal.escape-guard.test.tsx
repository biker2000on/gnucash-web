/**
 * H15 — Escape (and the other exit paths) must not silently destroy a
 * half-typed transaction.
 *
 * A PRISTINE form still closes on the first Escape: the guard has to stay
 * invisible for "opened it, changed my mind", or it would fire constantly. A
 * form holding typed work asks first, and declining has to leave every typed
 * value exactly where it was — a prompt that preserves the modal but resets
 * the fields is still data loss.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionFormModal } from '../TransactionFormModal';
import type { Split, Transaction } from '@/lib/types';

vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: (props: {
        value: string;
        onChange: (guid: string, name: string) => void;
        placeholder?: string;
    }) => (
        <button
            type="button"
            data-testid={`account-selector-${props.placeholder}`}
            onClick={() => props.onChange(
                props.placeholder?.includes('source') ? 'from0000000000000000000000000001' : 'to000000000000000000000000000001',
                'Selected account',
            )}
        >
            {props.value || props.placeholder}
        </button>
    ),
}));

vi.mock('@/components/ui/DescriptionAutocomplete', () => ({
    DescriptionAutocomplete: (props: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
        <input
            aria-label="Description"
            value={props.value}
            onChange={e => props.onChange(e.target.value)}
            placeholder={props.placeholder}
        />
    ),
}));

vi.mock('@/lib/hooks/useAccounts', () => ({
    useAccounts: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
    useUserPreferences: () => ({ defaultTaxRate: 0, dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('@/contexts/ToastContext', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/hooks/useIsMobile', () => ({
    useIsMobile: () => false,
}));

vi.mock('@/lib/hooks/useFormKeyboardShortcuts', () => ({
    useFormKeyboardShortcuts: () => {},
}));

vi.mock('@/lib/hooks/useKeyboardShortcut', () => ({
    useKeyboardShortcut: () => {},
}));

const TX_GUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';

const loadedSplit = (overrides: Partial<Split>): Split => ({
    guid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
    tx_guid: TX_GUID,
    account_guid: 'from0000000000000000000000000001',
    memo: 'lunch money',
    action: '',
    reconcile_state: 'n',
    reconcile_date: null,
    value_num: -2500,
    value_denom: 100,
    quantity_num: -2500,
    quantity_denom: 100,
    lot_guid: null,
    account_name: 'Checking',
    value_decimal: '-25.00',
    quantity_decimal: '-25.00',
    ...overrides,
});

const storedTransaction: Transaction = {
    guid: TX_GUID,
    currency_guid: 'usd0000000000000000000000000001',
    num: '101',
    post_date: new Date('2026-03-04T00:00:00Z'),
    enter_date: new Date('2026-03-04T12:00:00Z'),
    description: 'Groceries',
    splits: [
        loadedSplit({}),
        loadedSplit({
            guid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
            account_guid: 'to000000000000000000000000000001',
            account_name: 'Food',
            value_num: 2500,
            quantity_num: 2500,
            value_decimal: '25.00',
            quantity_decimal: '25.00',
        }),
    ],
};

const stubFetch = () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.startsWith('/api/transactions/')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(JSON.parse(JSON.stringify(storedTransaction))),
            });
        }
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ guid: 'usd0000000000000000000000000001', mnemonic: 'USD' }]),
        });
    }));
};

const renderModal = (props: Partial<React.ComponentProps<typeof TransactionFormModal>> = {}) => {
    const onClose = vi.fn();
    render(
        <TransactionFormModal
            isOpen
            onClose={onClose}
            onSuccess={vi.fn()}
            {...props}
        />
    );
    return { onClose };
};

const pressEscape = () => fireEvent.keyDown(document, { key: 'Escape' });
const discardPrompt = () => screen.queryByText('Discard this transaction?');
const amountBox = () => screen.getByPlaceholderText('0.00') as HTMLInputElement;

/** Enough typing to make the form worth protecting. */
const typeATransaction = () => {
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Feed store' } });
    fireEvent.change(amountBox(), { target: { value: '25.00' } });
    fireEvent.change(screen.getByPlaceholderText('Optional memo (saved on both splits)'), {
        target: { value: 'chicken feed' },
    });
    fireEvent.click(screen.getByTestId('account-selector-Select source account...'));
};

describe('TransactionFormModal escape guard — new transaction', () => {
    beforeEach(() => {
        stubFetch();
    });

    it('(a) closes on Escape with no prompt while the form is pristine', async () => {
        const { onClose } = renderModal();
        // Let the async default-currency fetch land: it writes to form state
        // without the user touching anything, and must not read as an edit.
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        pressEscape();

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(discardPrompt()).not.toBeInTheDocument();
    });

    it('(a2) a pre-populated default account and the pre-seeded empty split rows are not "dirty"', async () => {
        const { onClose } = renderModal({ defaultAccountGuid: 'from0000000000000000000000000001' });
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        pressEscape();

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(discardPrompt()).not.toBeInTheDocument();
    });

    it('(a3) looking at Advanced mode without typing is not "dirty"', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: 'Switch to Advanced (Multiple Splits)' }));
        pressEscape();

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(discardPrompt()).not.toBeInTheDocument();
    });

    it('(b) Escape does not close once an amount has been typed, and the work survives', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.change(amountBox(), { target: { value: '25.00' } });
        pressEscape();

        expect(onClose).not.toHaveBeenCalled();
        expect(discardPrompt()).toBeInTheDocument();
        expect(amountBox().value).toBe('25.00');
    });

    it('(b2) a single typed description is enough to trigger the guard', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fe' } });
        pressEscape();

        expect(onClose).not.toHaveBeenCalled();
        expect(discardPrompt()).toBeInTheDocument();
    });

    it('(c) confirming the prompt closes the modal', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        typeATransaction();
        pressEscape();
        expect(discardPrompt()).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('(d) declining keeps the modal open with every typed value intact', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        typeATransaction();
        // Focus something inside the form, the way a user typing would leave it.
        amountBox().focus();
        pressEscape();

        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

        expect(onClose).not.toHaveBeenCalled();
        expect(discardPrompt()).not.toBeInTheDocument();
        // The whole point: nothing typed may be lost by declining.
        expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Feed store');
        expect(amountBox().value).toBe('25.00');
        expect(
            (screen.getByPlaceholderText('Optional memo (saved on both splits)') as HTMLInputElement).value
        ).toBe('chicken feed');
        expect(screen.getByTestId('account-selector-Select source account...'))
            .toHaveTextContent('from0000000000000000000000000001');
        // Focus comes back to the form, not the page body.
        expect(document.activeElement).toBe(amountBox());
    });

    it('(d2) Escape dismisses the prompt without closing the form underneath it', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.change(amountBox(), { target: { value: '25.00' } });
        pressEscape();
        expect(discardPrompt()).toBeInTheDocument();

        pressEscape();

        expect(discardPrompt()).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(amountBox().value).toBe('25.00');
    });

    it("(f) the form's Cancel button is guarded exactly like Escape", async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        typeATransaction();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(onClose).not.toHaveBeenCalled();
        expect(discardPrompt()).toBeInTheDocument();
        expect(amountBox().value).toBe('25.00');
    });

    it('(f2) the header close button is guarded too', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        typeATransaction();
        fireEvent.click(screen.getAllByLabelText('Close dialog')[0]);

        expect(onClose).not.toHaveBeenCalled();
        expect(discardPrompt()).toBeInTheDocument();
    });

    it('(f3) a pristine form still closes from the Cancel button with no prompt', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(discardPrompt()).not.toBeInTheDocument();
    });

    it('(g) the backdrop is not an exit path at all, dirty or not', async () => {
        const { onClose } = renderModal();
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        const backdrop = document.querySelector('.bg-black\\/70');
        expect(backdrop).not.toBeNull();
        fireEvent.click(backdrop!);

        expect(onClose).not.toHaveBeenCalled();
        expect(discardPrompt()).not.toBeInTheDocument();
    });
});

describe('TransactionFormModal escape guard — editing an existing transaction', () => {
    beforeEach(() => {
        stubFetch();
    });

    const openEditor = async () => {
        const rendered = renderModal({ transaction: storedTransaction });
        // Wait for the modal's own fetch of the full transaction to populate
        // the form; "dirty" here means differing from THIS, not "non-empty".
        await waitFor(() =>
            expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Groceries')
        );
        return rendered;
    };

    it('(e) closes on Escape with no prompt when nothing was changed', async () => {
        const { onClose } = await openEditor();

        pressEscape();

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(discardPrompt()).not.toBeInTheDocument();
    });

    it('(e2) switching the loaded transaction to Advanced mode is still not a change', async () => {
        const { onClose } = await openEditor();

        fireEvent.click(screen.getByRole('button', { name: 'Switch to Advanced (Multiple Splits)' }));
        pressEscape();

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(discardPrompt()).not.toBeInTheDocument();
    });

    it('(e3) prompts once a loaded value is actually edited, and keeps the edit on decline', async () => {
        const { onClose } = await openEditor();

        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Groceries & feed' } });
        pressEscape();

        expect(onClose).not.toHaveBeenCalled();
        expect(discardPrompt()).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
        expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Groceries & feed');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('(e4) prompts when an amount is edited back and forth to a different value', async () => {
        const { onClose } = await openEditor();

        fireEvent.change(amountBox(), { target: { value: '30.00' } });
        pressEscape();
        expect(discardPrompt()).toBeInTheDocument();

        // ...and stops prompting once the value is restored: dirty tracks
        // content, not "the user touched a key".
        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
        fireEvent.change(amountBox(), { target: { value: '25.00' } });
        pressEscape();

        expect(discardPrompt()).not.toBeInTheDocument();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
