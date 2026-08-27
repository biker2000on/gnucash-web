import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastSuccess = vi.fn();
const toastError = vi.fn();
const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
    useParams: () => ({ guid: 'account-guid' }),
    useRouter: () => ({ push: routerPush, replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/contexts/ToastContext', () => ({
    useToast: () => ({ success: toastSuccess, error: toastError }),
}));

vi.mock('@/lib/financial-actions/client-events', () => ({
    notifyActionCenterUpdated: vi.fn(),
}));

vi.mock('@/components/TransactionFormModal', () => ({
    TransactionFormModal: ({
        isOpen,
        defaultAccountGuid,
        onSuccess,
    }: {
        isOpen: boolean;
        defaultAccountGuid: string;
        onSuccess: () => void;
    }) => isOpen ? (
        <div role="dialog" aria-label="New Transaction">
            <span>Default account: {defaultAccountGuid}</span>
            <button type="button" onClick={onSuccess}>Complete new transaction</button>
        </div>
    ) : null,
}));

vi.mock('@/components/ui/ConfirmationDialog', () => ({
    ConfirmationDialog: ({
        isOpen,
        onConfirm,
    }: {
        isOpen: boolean;
        onConfirm: () => void;
    }) => isOpen ? (
        <div role="dialog" aria-label="Delete Transaction">
            <button type="button" onClick={onConfirm}>Confirm deletion</button>
        </div>
    ) : null,
}));

import ReconcilePage from './page';

const workspace = {
    account: {
        guid: 'account-guid',
        name: 'Checking',
        account_type: 'BANK',
        currency: 'USD',
    },
    statementDate: '2026-07-28T00:00:00.000Z',
    lastReconcileDate: null,
    reconciledBalance: 100,
    candidates: [{
        guid: 'split-guid',
        transactionGuid: 'transaction-guid',
        date: '2026-07-20T00:00:00.000Z',
        enterDate: '2026-07-20T08:00:00.000Z',
        num: '',
        description: 'Review me',
        memo: '',
        amount: -25,
        state: 'n',
    }],
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
    });
}

describe('ReconcilePage transaction actions', () => {
    let workspaceRequests: number;
    let deletedTransactions: string[];
    let deleteRequestUrls: string[];
    let deleteStatus: number;

    beforeEach(() => {
        workspaceRequests = 0;
        deletedTransactions = [];
        deleteRequestUrls = [];
        deleteStatus = 200;
        toastSuccess.mockReset();
        toastError.mockReset();
        routerPush.mockReset();

        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/api/accounts/account-guid/reconcile?')) {
                workspaceRequests += 1;
                return jsonResponse(workspace);
            }
            if (url === '/api/simplefin/balance/account-guid') {
                return jsonResponse({ hasBalance: false });
            }
            if (url === '/api/reconciliation/sessions') {
                return jsonResponse({ id: 'session-guid' });
            }
            if (url.startsWith('/api/transactions/transaction-guid') && init?.method === 'DELETE') {
                deleteRequestUrls.push(url);
                if (deleteStatus !== 200) {
                    return jsonResponse(
                        { error: 'Transaction was modified by another user', code: 'conflict' },
                        { status: deleteStatus },
                    );
                }
                deletedTransactions.push('transaction-guid');
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        }));
    });

    it('returns to the account ledger on Escape, but blurs a focused input first', async () => {
        render(<ReconcilePage />);
        await screen.findByText('Review me');

        // Focus in an input: Escape leaves the field, not the page.
        const endingInput = screen.getByLabelText(/ending balance/i);
        endingInput.focus();
        fireEvent.keyDown(endingInput, { key: 'Escape' });
        expect(routerPush).not.toHaveBeenCalled();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(routerPush).toHaveBeenCalledWith('/accounts/account-guid');
    });

    it('does not navigate on Escape while the new-transaction dialog is open', async () => {
        render(<ReconcilePage />);
        await screen.findByText('Review me');

        fireEvent.keyDown(window, { key: 'n', altKey: true });
        expect(screen.getByRole('dialog', { name: 'New Transaction' })).toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('opens a transaction modal for Alt+N and defaults it to the reconciled account', async () => {
        render(<ReconcilePage />);
        await screen.findByText('Review me');

        fireEvent.keyDown(window, { key: 'n', altKey: true });

        expect(screen.getByRole('dialog', { name: 'New Transaction' })).toBeInTheDocument();
        expect(screen.getByText('Default account: account-guid')).toBeInTheDocument();
    });

    it('refreshes candidates after creating a transaction', async () => {
        render(<ReconcilePage />);
        await screen.findByText('Review me');
        fireEvent.click(screen.getByRole('button', { name: /New Transaction/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Complete new transaction' }));

        await waitFor(() => expect(workspaceRequests).toBeGreaterThanOrEqual(2));
    });

    it('deletes the candidate owning transaction and refreshes the workspace', async () => {
        render(<ReconcilePage />);
        await screen.findByText('Review me');
        fireEvent.click(screen.getByRole('button', { name: 'Delete Review me' }));
        fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }));

        await waitFor(() => expect(deletedTransactions).toEqual(['transaction-guid']));
        await waitFor(() => expect(workspaceRequests).toBeGreaterThanOrEqual(2));
        expect(toastSuccess).toHaveBeenCalledWith('Transaction deleted');
        // Optimistic-lock token: the enter_date loaded with the workspace
        // must be echoed back so a concurrent edit is detected server-side.
        expect(deleteRequestUrls[0]).toContain(
            `original_enter_date=${encodeURIComponent('2026-07-20T08:00:00.000Z')}`,
        );
    });

    it('reloads the workspace instead of deleting when the server reports a 409 conflict', async () => {
        deleteStatus = 409;
        render(<ReconcilePage />);
        await screen.findByText('Review me');
        fireEvent.click(screen.getByRole('button', { name: 'Delete Review me' }));
        fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(
            'This transaction was changed by someone else — reloading',
        ));
        await waitFor(() => expect(workspaceRequests).toBeGreaterThanOrEqual(2));
        expect(deletedTransactions).toEqual([]);
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('pins the running balances below the global application header', async () => {
        const { container } = render(<ReconcilePage />);
        await screen.findByText('Reconciled Balance');

        expect(container.querySelector('.sticky.top-\\[69px\\]')).toBeInTheDocument();
    });
});
