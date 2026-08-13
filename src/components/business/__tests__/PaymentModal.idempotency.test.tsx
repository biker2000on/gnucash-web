/**
 * Regression: the payment UI posted no idempotency key, so a retried payment
 * created a second transaction ($80 against a $100 invoice). The modal now
 * sends a `transactionGuid` generated once per open and kept stable across
 * retries; the API forwards it to applyPayment, which returns the existing
 * payment on a replay.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentModal } from '../PaymentModal';

vi.mock('@/components/ui/Modal', () => ({
    Modal: (props: { isOpen: boolean; children: React.ReactNode }) =>
        props.isOpen ? <div>{props.children}</div> : null,
}));

vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: (props: { value: string; onChange: (guid: string) => void; placeholder?: string }) => (
        <input
            aria-label="transfer-account"
            value={props.value}
            onChange={e => props.onChange(e.target.value)}
        />
    ),
}));

vi.mock('@/contexts/ToastContext', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const INVOICE = {
    guid: 'inv00000000000000000000000000001',
    id: '000001',
    posted: true,
    amountDue: 100,
    datePosted: '2026-08-01',
    dueDate: '2026-08-31',
};

/** Payment POST bodies seen by fetch, in order. */
let posted: Array<Record<string, unknown>>;
let postOutcome: () => Promise<Response>;

function stubFetch() {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        if (String(url).startsWith('/api/business/invoices')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ invoices: [INVOICE] }) } as Response);
        }
        posted.push(JSON.parse(String(init?.body)));
        return postOutcome();
    }));
}

const okPayment = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ result: { transactionGuid: 'x', allocations: [], fullyPaidInvoiceGuids: [] } }),
} as Response);

const failedPayment = () => Promise.resolve({
    ok: false,
    json: () => Promise.resolve({ error: 'network' }),
} as Response);

/** The Amount box is the first number input; the rest are allocation cells. */
const amountInput = () => document.querySelectorAll('input[type="number"]')[0] as HTMLInputElement;

async function openAndSubmit(amount = '40.00') {
    fireEvent.change(screen.getByLabelText('transfer-account'), {
        target: { value: 'bank0000000000000000000000000001' },
    });
    fireEvent.change(amountInput(), { target: { value: amount } });
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Record Payment' }));
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    posted = [];
    postOutcome = okPayment;
    stubFetch();
});

describe('PaymentModal idempotency key', () => {
    it('sends a transactionGuid with the payment', async () => {
        render(
            <PaymentModal
                isOpen
                onClose={() => {}}
                ownerType="customer"
                ownerGuid="cust0000000000000000000000000001"
                ownerName="Acme"
            />
        );
        await waitFor(() => expect(amountInput().value).toBe('100.00'));

        await openAndSubmit();

        expect(posted).toHaveLength(1);
        expect(posted[0].amount).toBe(40);
        expect(posted[0].transactionGuid).toMatch(/^[0-9a-f]{32}$/);
    });

    it('reuses the same key when a failed payment is retried', async () => {
        postOutcome = failedPayment;
        render(
            <PaymentModal
                isOpen
                onClose={() => {}}
                ownerType="customer"
                ownerGuid="cust0000000000000000000000000001"
                ownerName="Acme"
            />
        );
        await waitFor(() => expect(amountInput().value).toBe('100.00'));

        await openAndSubmit();
        await openAndSubmit();

        expect(posted).toHaveLength(2);
        // Same key → the server collapses the retry onto one $40 payment
        // instead of posting $80 against the $100 invoice.
        expect(posted[1].transactionGuid).toBe(posted[0].transactionGuid);
    });

    it('uses a fresh key for the next payment after one succeeds', async () => {
        render(
            <PaymentModal
                isOpen
                onClose={() => {}}
                ownerType="customer"
                ownerGuid="cust0000000000000000000000000001"
                ownerName="Acme"
            />
        );
        await waitFor(() => expect(amountInput().value).toBe('100.00'));

        await openAndSubmit();
        await openAndSubmit('25.00');

        expect(posted).toHaveLength(2);
        expect(posted[1].transactionGuid).not.toBe(posted[0].transactionGuid);
    });
});
