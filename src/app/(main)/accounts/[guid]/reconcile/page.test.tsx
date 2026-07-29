import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('next/navigation', () => ({
    useParams: () => ({ guid: 'account-guid' }),
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

    beforeEach(() => {
        workspaceRequests = 0;
        deletedTransactions = [];
        toastSuccess.mockReset();
        toastError.mockReset();

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
            if (url === '/api/transactions/transaction-guid' && init?.method === 'DELETE') {
                deletedTransactions.push('transaction-guid');
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        }));
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
    });

    it('pins the running balances below the global application header', async () => {
        const { container } = render(<ReconcilePage />);
        await screen.findByText('Reconciled Balance');

        expect(container.querySelector('.sticky.top-\\[69px\\]')).toBeInTheDocument();
    });
});
