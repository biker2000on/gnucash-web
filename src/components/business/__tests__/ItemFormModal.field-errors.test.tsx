/**
 * The item form must read the API's per-field 400 through the ONE shared
 * reader in `lib/api-error.ts`.
 *
 * `mapInventoryError` used to answer with `{ error, fields }` — a fourth
 * error-body shape invented for this route — and the modal hand-parsed
 * `data.fields`. The canonical shape is `errors: [{ field, message }]`, which
 * `ApiRequestError.fromBody` already understands; these tests pin that the
 * modal marks its posting-account inputs from that list, so a future route
 * that drops the legacy `fields` map does not silently blank the form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ItemFormModal } from '../ItemFormModal';

vi.mock('@/components/ui/Modal', () => ({
    Modal: (props: { isOpen: boolean; children: ReactNode }) =>
        props.isOpen ? <div>{props.children}</div> : null,
}));

vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: (props: {
        value: string;
        placeholder?: string;
        accountTypes?: string[];
        onChange: (guid: string) => void;
    }) => (
        <button
            type="button"
            data-testid={`account-${props.accountTypes?.[0]}`}
            onClick={() => props.onChange(`${props.accountTypes?.[0]}-guid`)}
        >
            {props.value || props.placeholder}
        </button>
    ),
}));

const toastError = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({
    useToast: () => ({ success: vi.fn(), error: toastError }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({
    useCurrentUser: () => ({ isReadonly: false }),
    READONLY_TOOLTIP: 'Read-only access',
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

/**
 * Get past the modal's own client-side checks so the request actually goes out
 * — this suite is about how the SERVER's 400 is read, not about that guard.
 */
function fillRequired() {
    fireEvent.change(screen.getByPlaceholderText('e.g. WID-001'), { target: { value: 'SKU-1' } });
    fireEvent.change(screen.getByPlaceholderText('Item name'), { target: { value: 'Widget' } });
    fireEvent.click(screen.getByTestId('account-INCOME'));
    fireEvent.click(screen.getByTestId('account-EXPENSE'));
    fireEvent.click(screen.getByTestId('account-ASSET'));
}

describe('ItemFormModal server field errors', () => {
    beforeEach(() => {
        toastError.mockClear();
    });

    it('marks each posting account from the canonical errors[] list', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                json: () =>
                    Promise.resolve({
                        error: 'Ledger posting is enabled for this item, so its posting accounts must be set',
                        errors: [
                            { field: 'incomeAccountGuid', message: 'Income account is required' },
                            { field: 'cogsAccountGuid', message: 'COGS account is required' },
                        ],
                    }),
            }),
        );

        render(<ItemFormModal editing="new" onClose={vi.fn()} onSaved={vi.fn()} />);
        fillRequired();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(screen.getByText('Income account is required')).toBeTruthy());
        expect(screen.getByText('COGS account is required')).toBeTruthy();
        // The banner still gets the server's joined summary.
        expect(toastError).toHaveBeenCalledWith(
            'Ledger posting is enabled for this item, so its posting accounts must be set',
        );
    });

    it('still surfaces a plain { error } 400 as a toast with no field marks', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                json: () => Promise.resolve({ error: 'sku is required' }),
            }),
        );

        render(<ItemFormModal editing="new" onClose={vi.fn()} onSaved={vi.fn()} />);
        fillRequired();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('sku is required'));
        expect(screen.queryByText(/is required when/)).toBeNull();
    });
});
