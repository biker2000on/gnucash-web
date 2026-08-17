/**
 * Screen-reader announcement of failed submits and actions (WCAG 4.1.3).
 *
 * Error text rendered as ordinary markup is silent: a screen-reader user who
 * submits a form that fails hears nothing, and the form simply appears not to
 * respond.
 *
 * The subtlety this file exists to pin down is *when* the live region must
 * exist. A `role="alert"` node announces a change to its contents; a node that
 * arrives already carrying its message is a new subtree, and assistive
 * technology is under no obligation to read it. So the familiar
 * `{error && <div role="alert">{error}</div>}` reliably announces the *second*
 * failure and swallows the first — the one that matters. Every surface below
 * therefore mounts `<ErrorLiveRegion>` (src/components/a11y/LiveRegion.tsx)
 * unconditionally and lets its text change.
 *
 * Deliberately NOT covered: validation that recomputes on every keystroke.
 * A live region there produces continuous chatter and is worse than silence.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BudgetForm } from '../BudgetForm';
import { LoginForm } from '../LoginForm';
import BookEditorModal from '../BookEditorModal';
import SaveReportDialog from '../reports/SaveReportDialog';
import { ReportType } from '@/lib/reports/types';
import { BatchEditModal } from '../budget/BatchEditModal';
import { ChartSettingsPanel } from '../investments/ChartSettingsPanel';

/**
 * Every surface that announces a failed action or a status change. The rule is
 * uniform, so the check is uniform: route through the shared component, and
 * never hand-roll a `role` onto markup that is mounted together with its text.
 */
const ANNOUNCING_SURFACES: string[] = [
    'src/components/AccountForm.tsx',
    'src/components/BookEditorModal.tsx',
    'src/components/BudgetForm.tsx',
    'src/components/CreateBookWizard.tsx',
    'src/components/InvestmentTransactionForm.tsx',
    'src/components/LoginForm.tsx',
    'src/components/books/NewBookForm.tsx',
    'src/components/budget/BatchEditModal.tsx',
    'src/components/budget/EstimateModal.tsx',
    'src/components/documents/LinkedDocumentsPanel.tsx',
    'src/components/home/BulkDetailPanel.tsx',
    'src/components/home/RoomDetailPanel.tsx',
    'src/components/import/BusinessImportWizard.tsx',
    'src/components/import/PersonalImportWizard.tsx',
    'src/components/investments/ChartSettingsPanel.tsx',
    'src/components/investments/ScrubAllButton.tsx',
    'src/components/mortgage/MortgageAutoDetect.tsx',
    'src/components/provenance/ProvenanceModal.tsx',
    'src/components/reports/SaveReportDialog.tsx',
    'src/components/reports/TransactionDrilldownModal.tsx',
    'src/components/scheduled-transactions/CreateScheduledPanel.tsx',
    'src/components/settings/TwoFactorSection.tsx',
];

function source(file: string): string {
    return readFileSync(resolve(process.cwd(), file), 'utf8');
}

describe('announced surfaces route through the shared live region', () => {
    it.each(ANNOUNCING_SURFACES)('%s', (file) => {
        const src = source(file);

        expect(src, `${file}: no live region — a failure here is silent`).toContain(
            '<ErrorLiveRegion'
        );
        expect(src).toContain("from '@/components/a11y/LiveRegion'");

        // A hand-rolled role is how the mount-with-the-message bug comes back:
        // the node and its text appear together and nothing is announced.
        expect(
            src,
            `${file}: hand-rolled live-region role — use <ErrorLiveRegion> instead`
        ).not.toMatch(/role="(alert|status)"/);
    });
});

describe('the shared region is mounted before it has anything to say', () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    /** The always-mounted region, whatever else the component has rendered. */
    function region(role: 'alert' | 'status' = 'alert'): HTMLElement {
        return screen.getByRole(role);
    }

    it('BudgetForm: a rejected save', async () => {
        render(
            <BudgetForm
                mode="create"
                onSave={async () => {
                    throw new Error('Budget name already exists');
                }}
                onCancel={() => {}}
            />
        );

        expect(region().textContent).toBe('');

        fireEvent.change(screen.getByPlaceholderText(/annual budget/i), {
            target: { value: 'Household' },
        });
        fireEvent.click(screen.getByRole('button', { name: /create budget/i }));

        await waitFor(() => expect(region()).toHaveTextContent('Budget name already exists'));
    });

    it('LoginForm: rejected credentials', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            json: async () => ({ error: 'Invalid username or password' }),
        } as Response);

        render(<LoginForm mode="login" onToggleMode={() => {}} />);

        expect(region().textContent).toBe('');

        fireEvent.change(screen.getByPlaceholderText(/enter username/i), {
            target: { value: 'ada' },
        });
        fireEvent.change(screen.getByPlaceholderText(/enter password/i), {
            target: { value: 'hunter2' },
        });
        fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

        await waitFor(() => expect(region()).toHaveTextContent('Invalid username or password'));
    });

    it('BookEditorModal: a rejected rename', () => {
        render(
            <BookEditorModal
                book={{ guid: 'book-1', name: 'Household', description: null }}
                isOpen
                onClose={() => {}}
                onSaved={() => {}}
                onDeleted={() => {}}
            />
        );

        expect(region().textContent).toBe('');

        fireEvent.change(screen.getByPlaceholderText(/book name/i), { target: { value: '  ' } });
        fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

        expect(region()).toHaveTextContent('Name is required');
    });

    it('SaveReportDialog: a save with no name', () => {
        render(
            <SaveReportDialog
                isOpen
                onClose={() => {}}
                onSave={async () => {}}
                baseReportType={ReportType.BALANCE_SHEET}
                currentConfig={{}}
            />
        );

        expect(region().textContent).toBe('');

        fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

        expect(region()).toHaveTextContent('Name is required');
    });

    it('BatchEditModal: an unparseable amount', () => {
        render(
            <BatchEditModal
                isOpen
                onClose={() => {}}
                budgetGuid="budget-1"
                accountGuid="account-1"
                accountName="Groceries"
                numPeriods={12}
                onUpdate={() => {}}
            />
        );

        expect(region().textContent).toBe('');

        fireEvent.change(screen.getByLabelText(/amount per period/i), {
            target: { value: 'a lot' },
        });
        fireEvent.click(screen.getByRole('button', { name: /apply to all periods/i }));

        expect(region()).toHaveTextContent('Please enter a valid number');
    });

    it('ChartSettingsPanel: a failed save, announced politely', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);

        render(<ChartSettingsPanel onSettingsChange={() => {}} />);
        fireEvent.click(screen.getByRole('button', { name: /chart settings/i }));

        // Status, not alert: this must not interrupt whatever is being read.
        expect(screen.queryByRole('alert')).toBeNull();
        expect(region('status').textContent).toBe('');

        fireEvent.click(screen.getByRole('button', { name: /save defaults/i }));

        await waitFor(() => expect(region('status')).toHaveTextContent('Save failed'));
    });
});
