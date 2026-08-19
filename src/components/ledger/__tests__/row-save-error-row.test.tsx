import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RowSaveErrorRow } from '../RowSaveErrorRow';
import { ErrorLiveRegion } from '@/components/a11y/LiveRegion';

afterEach(cleanup);

function renderRow(message?: string) {
    return render(
        <table>
            <tbody>
                <RowSaveErrorRow message={message} colSpan={4} />
            </tbody>
        </table>,
    );
}

describe('RowSaveErrorRow', () => {
    it('renders nothing when the row has no error', () => {
        renderRow(undefined);
        expect(screen.queryByTestId('row-save-error')).toBeNull();
    });

    it('shows the reason on the row, spanning the full grid', () => {
        renderRow('Failed to save transaction');
        const row = screen.getByTestId('row-save-error');
        expect(row.textContent).toBe('Failed to save transaction');
        expect(row.querySelector('td')?.getAttribute('colspan')).toBe('4');
    });

    it('carries no role of its own — the ledger announces once through a live region', () => {
        renderRow('Failed to save transaction');
        expect(screen.queryByRole('alert')).toBeNull();
    });
});

describe('inline-save announcement', () => {
    it('AccountLedger pairs the row with a live region that speaks the same text', async () => {
        // The pairing AccountLedger uses: sr-only region announces, the row
        // says where. Asserted together so neither half can be dropped.
        render(
            <>
                <ErrorLiveRegion message="Failed to save transaction" />
                <table>
                    <tbody>
                        <RowSaveErrorRow message="Failed to save transaction" colSpan={4} />
                    </tbody>
                </table>
            </>,
        );
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe('Failed to save transaction');
        expect(screen.getByTestId('row-save-error').textContent).toBe('Failed to save transaction');
    });
});
