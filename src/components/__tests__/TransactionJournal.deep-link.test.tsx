/**
 * M1 — `/ledger?transaction=<guid>` opens that transaction.
 *
 * Two places write that link: the comment notification (`transaction-comments
 * .service.ts`) and the unresolved-thread Action Center item
 * (`financial-actions/sources.ts`). Nothing read the parameter — the ledger
 * page only looked at `search` — so both links landed on an unfiltered ledger
 * and the reader had to find the row themselves.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TransactionJournal from '../TransactionJournal';
import type { Transaction } from '@/lib/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ isReadonly: false }), READONLY_TOOLTIP: '' }));
vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/receipts/ReceiptIndicator', () => ({ ReceiptIndicator: () => null }));
vi.mock('@/components/transactions/CommentCountBadge', () => ({
    CommentCountBadge: () => null,
    useCommentCounts: () => ({}),
}));
vi.mock('../TransactionFormModal', () => ({ TransactionFormModal: () => null }));
vi.mock('../tags/TransactionTagEditor', () => ({ TransactionTagEditor: () => null }));
vi.mock('../DataEventsProvider', () => ({ suppressNextDataEvent: vi.fn() }));

/** Stands in for the real detail modal, which fetches by guid on its own. */
vi.mock('../TransactionModal', () => ({
    TransactionModal: ({ transactionGuid, isOpen }: { transactionGuid: string | null; isOpen: boolean }) =>
        (isOpen ? <div data-testid="transaction-modal">{transactionGuid}</div> : null),
}));

const TARGET = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

const transaction = (guid: string): Transaction => ({
    guid,
    currency_guid: 'c'.repeat(32),
    post_date: new Date('2026-08-01T00:00:00.000Z'),
    enter_date: new Date('2026-08-01T00:00:00.000Z'),
    description: `Transaction ${guid.slice(0, 4)}`,
    num: '',
    splits: [],
} as unknown as Transaction);

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] } as Response)));
});
afterEach(() => vi.unstubAllGlobals());

describe('?transaction=<guid>', () => {
    it('opens the detail modal on that transaction', async () => {
        render(
            <TransactionJournal
                initialTransactions={[transaction(OTHER), transaction(TARGET)]}
                initialTransactionGuid={TARGET}
            />,
        );
        const modal = await screen.findByTestId('transaction-modal');
        expect(modal.textContent).toBe(TARGET);
    });

    it('opens a transaction that is not on the loaded page', async () => {
        // The modal fetches by guid, so a deep link outside the current date
        // filter still lands on the right transaction.
        render(<TransactionJournal initialTransactions={[]} initialTransactionGuid={TARGET} />);
        const modal = await screen.findByTestId('transaction-modal');
        expect(modal.textContent).toBe(TARGET);
    });

    it('opens nothing without the parameter', async () => {
        render(<TransactionJournal initialTransactions={[transaction(OTHER)]} />);
        await waitFor(() => expect(screen.getByText('Transaction bbbb')).toBeTruthy());
        expect(screen.queryByTestId('transaction-modal')).toBeNull();
    });
});
