/**
 * Simple-mode transaction entry: the memo typed in the modal must land on
 * BOTH created splits (GnuCash desktop Transfer-dialog behavior), and an
 * edit through simple mode must not flatten per-split memos or reconcile
 * states it did not touch.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionForm, buildSimpleModeSplits } from '../TransactionForm';
import type { SplitFormData } from '@/lib/types';

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

describe('TransactionForm simple mode memo', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            json: () => Promise.resolve([{ guid: 'usd0000000000000000000000000001', mnemonic: 'USD' }]),
        }));
    });

    it('carries the memo onto both created splits', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} />);

        // Wait for the default-currency fetch to land
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Lunch' } });
        fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '25.00' } });
        fireEvent.change(screen.getByPlaceholderText('Optional memo (saved on both splits)'), {
            target: { value: 'sandwich run' },
        });
        fireEvent.click(screen.getByTestId('account-selector-Select source account...'));
        fireEvent.click(screen.getByTestId('account-selector-Select destination account...'));

        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const [data] = onSave.mock.calls[0];
        expect(data.splits).toHaveLength(2);
        // GnuCash desktop's Transfer dialog writes the SAME memo to both
        // splits of a simple two-split entry; simple mode matches it.
        expect(data.splits[0]).toMatchObject({
            account_guid: 'from0000000000000000000000000001',
            memo: 'sandwich run',
        });
        expect(data.splits[1]).toMatchObject({
            account_guid: 'to000000000000000000000000000001',
            memo: 'sandwich run',
        });
        expect(data.splits[0].value_num).toBe(-2500);
        expect(data.splits[1].value_num).toBe(2500);
    });

    it('leaves the memo off both splits when the field stays empty', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<TransactionForm onSave={onSave} onCancel={() => {}} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Lunch' } });
        fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '10' } });
        fireEvent.click(screen.getByTestId('account-selector-Select source account...'));
        fireEvent.click(screen.getByTestId('account-selector-Select destination account...'));
        fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const [data] = onSave.mock.calls[0];
        // buildApiData sends memo as undefined when blank
        expect(data.splits[0].memo).toBeUndefined();
        expect(data.splits[1].memo).toBeUndefined();
    });

    it('renders the Num field narrow beside the date, not full-width', () => {
        render(<TransactionForm onSave={vi.fn()} onCancel={() => {}} />);
        const numInput = screen.getByPlaceholderText('Check #');
        // Narrow fixed width (check-number width), sharing a row with Date
        // and Description instead of owning its own full-width block.
        expect(numInput.parentElement?.className).toContain('md:w-24');
        expect(numInput.parentElement?.parentElement?.className).toContain('md:flex-row');
    });
});

describe('buildSimpleModeSplits', () => {
    const loadedFrom: SplitFormData = {
        id: 'aaaa0000000000000000000000000001',
        account_guid: 'from0000000000000000000000000001',
        account_name: 'Checking',
        debit: '',
        credit: '25.00',
        memo: 'from memo',
        reconcile_state: 'y',
    };
    const loadedTo: SplitFormData = {
        id: 'bbbb0000000000000000000000000001',
        account_guid: 'to000000000000000000000000000001',
        account_name: 'Groceries',
        debit: '25.00',
        credit: '',
        memo: 'to memo',
        reconcile_state: 'c',
    };

    it('writes the memo to both splits for a fresh entry', () => {
        const splits = buildSimpleModeSplits(
            {
                amount: '25.00',
                fromAccountGuid: 'from0000000000000000000000000001',
                toAccountGuid: 'to000000000000000000000000000001',
                memo: 'shared memo',
            },
            [],
        );
        expect(splits.map(s => s.memo)).toEqual(['shared memo', 'shared memo']);
        expect(splits[0].credit).toBe('25.00');
        expect(splits[1].debit).toBe('25.00');
        expect(splits.map(s => s.reconcile_state)).toEqual(['n', 'n']);
    });

    it('preserves differing per-split memos when the memo was not edited', () => {
        const splits = buildSimpleModeSplits(
            {
                amount: '25.00',
                fromAccountGuid: loadedFrom.account_guid,
                toAccountGuid: loadedTo.account_guid,
                memo: null,
            },
            [loadedFrom, loadedTo],
        );
        expect(splits[0].memo).toBe('from memo');
        expect(splits[1].memo).toBe('to memo');
    });

    it('keeps split ids and reconcile states while amount and account are untouched', () => {
        const splits = buildSimpleModeSplits(
            {
                amount: '25.00',
                fromAccountGuid: loadedFrom.account_guid,
                toAccountGuid: loadedTo.account_guid,
                memo: 'overwritten everywhere',
            },
            [loadedFrom, loadedTo],
        );
        expect(splits[0].id).toBe(loadedFrom.id);
        expect(splits[1].id).toBe(loadedTo.id);
        expect(splits[0].reconcile_state).toBe('y');
        expect(splits[1].reconcile_state).toBe('c');
        // ...while the memo edit itself never resets reconcile state
        expect(splits.map(s => s.memo)).toEqual(['overwritten everywhere', 'overwritten everywhere']);
    });

    it('resets both reconcile states when the amount changes', () => {
        const splits = buildSimpleModeSplits(
            {
                amount: '30.00',
                fromAccountGuid: loadedFrom.account_guid,
                toAccountGuid: loadedTo.account_guid,
                memo: null,
            },
            [loadedFrom, loadedTo],
        );
        expect(splits.map(s => s.reconcile_state)).toEqual(['n', 'n']);
        expect(splits[0].id).toBe(loadedFrom.id);
    });

    it('treats a retargeted account as a fresh unreconciled split', () => {
        const splits = buildSimpleModeSplits(
            {
                amount: '25.00',
                fromAccountGuid: 'newacct0000000000000000000000001',
                toAccountGuid: loadedTo.account_guid,
                memo: null,
            },
            [loadedFrom, loadedTo],
        );
        expect(splits[0].id).not.toBe(loadedFrom.id);
        expect(splits[0].reconcile_state).toBe('n');
        expect(splits[0].memo).toBe('');
        // The untouched side survives intact
        expect(splits[1].id).toBe(loadedTo.id);
        expect(splits[1].reconcile_state).toBe('c');
    });
});
