/**
 * Server and validation failures must be (a) announced through a live region
 * and (b) placed under the field they are about — not left as an unlabelled
 * <div><ul> at the top of the form that a screen reader never mentions and a
 * sighted user has to map back onto the controls by hand.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionForm } from '../TransactionForm';
import { ApiRequestError } from '@/lib/api-error';
import { INPUT_INVALID } from '@/components/ui/form';

vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: (props: {
        value: string;
        onChange: (guid: string, name: string) => void;
        placeholder?: string;
    }) => (
        <button
            type="button"
            data-testid={`account-selector-${props.placeholder}`}
            onClick={() =>
                props.onChange(
                    props.placeholder?.includes('source')
                        ? 'from0000000000000000000000000001'
                        : 'to000000000000000000000000000001',
                    'Selected account',
                )
            }
        >
            {props.value || props.placeholder}
        </button>
    ),
}));

vi.mock('@/components/ui/DescriptionAutocomplete', () => ({
    DescriptionAutocomplete: (props: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
        <input aria-label="Description" value={props.value} onChange={e => props.onChange(e.target.value)} />
    ),
}));

vi.mock('@/lib/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [], isLoading: false }) }));
vi.mock('@/contexts/UserPreferencesContext', () => ({
    useUserPreferences: () => ({ defaultTaxRate: 0, dateFormat: 'MM/DD/YYYY' }),
}));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/hooks/useFormKeyboardShortcuts', () => ({ useFormKeyboardShortcuts: () => {} }));
vi.mock('@/lib/hooks/useKeyboardShortcut', () => ({ useKeyboardShortcut: () => {} }));

async function fillValidForm() {
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Lunch' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '25.00' } });
    fireEvent.click(screen.getByTestId('account-selector-Select source account...'));
    fireEvent.click(screen.getByTestId('account-selector-Select destination account...'));
}

describe('TransactionForm server + validation errors', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                json: () => Promise.resolve([{ guid: 'usd0000000000000000000000000001', mnemonic: 'USD' }]),
            }),
        );
    });

    it('announces client validation failures through a live region', async () => {
        render(<TransactionForm onSave={vi.fn()} onCancel={() => {}} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        const alert = await screen.findByRole('alert');
        await waitFor(() => expect(alert.textContent).toMatch(/Description is required/));
    });

    it('places client validation failures under the fields they are about', async () => {
        render(<TransactionForm onSave={vi.fn()} onCancel={() => {}} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        // Inline, next to the control — not only in the summary at the top.
        await waitFor(() => expect(document.getElementById('tx-error-amount')?.textContent).toBe('Required'));
        expect(document.getElementById('tx-error-description')?.textContent).toBe('Required');
        expect(document.getElementById('tx-error-fromAccount')?.textContent).toBe('Required');
        expect(document.getElementById('tx-error-toAccount')?.textContent).toBe('Required');

        // ...and the control points at its message.
        const amount = screen.getByPlaceholderText('0.00');
        expect(amount.getAttribute('aria-invalid')).toBe('true');
        expect(amount.getAttribute('aria-describedby')).toBe('tx-error-amount');
    });

    it('marks a rejected control with the shared INPUT_INVALID recipe', async () => {
        render(<TransactionForm onSave={vi.fn()} onCancel={() => {}} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        const amount = screen.getByPlaceholderText('0.00');
        expect(amount.className).not.toContain('border-error');

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        // The invalid look is INPUT_INVALID from ui/form.tsx, not a hand-rolled
        // `border-error : border-border` ternary — that is what keeps validation
        // failures on `--error` rather than drifting onto money's `--negative`.
        await waitFor(() => expect(amount.className).toContain(INPUT_INVALID));
    });

    it('announces a server rejection and parks each field entry under its field', async () => {
        const onSave = vi.fn().mockRejectedValue(
            new ApiRequestError(
                'Post date is required; Description is required',
                { post_date: 'Post date is required', description: 'Description is required' },
                400,
            ),
        );
        render(<TransactionForm onSave={onSave} onCancel={() => {}} />);
        await fillValidForm();

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

        const alert = await screen.findByRole('alert');
        await waitFor(() => expect(alert.textContent).toMatch(/Post date is required/));

        await waitFor(() =>
            expect(document.getElementById('tx-error-post_date')?.textContent).toBe('Post date is required'),
        );
        expect(document.getElementById('tx-error-description')?.textContent).toBe('Description is required');
    });

    it('folds a server split error onto the account row while in simple mode', async () => {
        const onSave = vi.fn().mockRejectedValue(
            new ApiRequestError(
                'Split 1: Account is required',
                { 'splits[0].account_guid': 'Split 1: Account is required' },
                400,
            ),
        );
        render(<TransactionForm onSave={onSave} onCancel={() => {}} />);
        await fillValidForm();

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

        await waitFor(() =>
            expect(document.getElementById('tx-error-splits')?.textContent).toBe('Split 1: Account is required'),
        );
    });

    it('still shows a plain Error as a banner when the server sends no field list', async () => {
        const onSave = vi.fn().mockRejectedValue(new Error('Database is down'));
        render(<TransactionForm onSave={onSave} onCancel={() => {}} />);
        await fillValidForm();

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

        const alert = await screen.findByRole('alert');
        await waitFor(() => expect(alert.textContent).toMatch(/Database is down/));
    });
});
