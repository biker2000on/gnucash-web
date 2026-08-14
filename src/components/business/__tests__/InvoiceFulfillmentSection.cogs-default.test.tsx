/**
 * Regression: the engine posts COGS by default on fulfillment, but this modal
 * shipped `post: false` on every submit — the checkbox was initialized to true
 * while the modal's reset effect (which re-runs on EVERY open, not just the
 * first mount) immediately set it back to false. The engine default was inert
 * for the primary invoice workflow.
 *
 * These tests drive the real modal through open → submit → close → REOPEN,
 * because a test that only asserted the initial state passed while the bug was
 * live.
 *
 * Returns are asserted to stay OPT-OUT: returnToStock reverses at the
 * fulfillment line's recorded shipment basis, while the product default stays
 * opt-in and the checkbox must not arm itself (see shouldPostReturnCogs).
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceFulfillmentSection } from '../InvoiceFulfillmentSection';

vi.mock('@/components/ui/Modal', () => ({
    Modal: (props: { isOpen: boolean; children: React.ReactNode }) =>
        props.isOpen ? <div>{props.children}</div> : null,
}));

vi.mock('@/components/business/ItemSelector', () => ({
    ItemSelector: (props: { value: number | null }) => <span>item:{String(props.value)}</span>,
}));

vi.mock('@/contexts/ToastContext', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({
    useCurrentUser: () => ({ isReadonly: false }),
    READONLY_TOOLTIP: 'read only',
}));

const INVOICE_GUID = 'inv00000000000000000000000000001';
const ENTRY_GUID = 'ent00000000000000000000000000001';

/** One line: 10 invoiced, 4 already shipped — so both Fulfill and Return are live. */
const FULFILLMENT = {
    invoiceGuid: INVOICE_GUID,
    invoiceId: '000001',
    fullyFulfilled: false,
    entries: [{
        entryGuid: ENTRY_GUID,
        invoicedQuantity: 10,
        fulfilledQuantity: 4,
        remainingQuantity: 6,
        movements: [{ id: 1, itemId: 7 }],
    }],
};

const ENTRIES = [{ guid: ENTRY_GUID, description: 'Widgets', quantity: 10 }];

/** Fulfillment POST bodies seen by fetch, in order. */
let posted: Array<Record<string, unknown>>;

function stubFetch() {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        const href = String(url);
        if (init?.method === 'POST') {
            posted.push(JSON.parse(String(init.body)));
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ invoiceGuid: INVOICE_GUID, movements: [] }),
            } as Response);
        }
        if (href.includes('/fulfillment')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ fulfillment: FULFILLMENT }) } as Response);
        }
        if (href.includes('/items')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [{ id: 7, sku: 'WIDGET', name: 'Widget' }] }) } as Response);
        }
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ locations: [{ id: 3, name: 'Main', active: true }] }),
        } as Response);
    }));
}

/** Open a mode, submit the prepopulated allocation, and close the modal. */
async function openAndSubmit(opener: 'Fulfill...' | 'Return...', submit: 'Fulfill' | 'Return') {
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: opener }));
    });
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: submit }));
    });
}

const cogsCheckbox = () => document.querySelector('input[type="checkbox"]') as HTMLInputElement;

async function renderSection() {
    render(<InvoiceFulfillmentSection invoiceGuid={INVOICE_GUID} entries={ENTRIES} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fulfill...' })).toBeTruthy());
}

describe('InvoiceFulfillmentSection COGS posting flag', () => {
    beforeEach(() => {
        posted = [];
        stubFetch();
    });

    it('submits post: true on the FIRST fulfillment', async () => {
        await renderSection();

        await openAndSubmit('Fulfill...', 'Fulfill');

        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ mode: 'fulfill', post: true });
    });

    it('submits post: true again after the modal is closed and REOPENED', async () => {
        await renderSection();

        await openAndSubmit('Fulfill...', 'Fulfill');
        // Reopening re-runs the modal reset effect — the exact path that
        // silently forced post back to false.
        await openAndSubmit('Fulfill...', 'Fulfill');

        expect(posted).toHaveLength(2);
        expect(posted[1]).toMatchObject({ mode: 'fulfill', post: true });
    });

    it('re-arms fulfillment after a return, so mode switching cannot strand it off', async () => {
        await renderSection();

        await openAndSubmit('Return...', 'Return');
        await openAndSubmit('Fulfill...', 'Fulfill');

        expect(posted).toHaveLength(2);
        expect(posted[1]).toMatchObject({ mode: 'fulfill', post: true });
    });

    it('keeps returns opt-in across opens and reopens (wrong reversal basis)', async () => {
        await renderSection();

        await openAndSubmit('Return...', 'Return');
        await openAndSubmit('Return...', 'Return');

        expect(posted).toHaveLength(2);
        expect(posted[0]).toMatchObject({ mode: 'return', post: false });
        expect(posted[1]).toMatchObject({ mode: 'return', post: false });
    });

    it('honors an explicit uncheck by the user', async () => {
        await renderSection();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Fulfill...' }));
        });
        expect(cogsCheckbox().checked).toBe(true);
        await act(async () => {
            fireEvent.click(cogsCheckbox());
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Fulfill' }));
        });

        expect(posted[0]).toMatchObject({ mode: 'fulfill', post: false });
    });
});
