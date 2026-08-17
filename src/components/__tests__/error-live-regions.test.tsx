/**
 * Screen-reader announcement of failed submits and actions (WCAG 4.1.3).
 *
 * Error text rendered as ordinary markup is silent: a screen-reader user who
 * submits a form that fails hears nothing, and the form simply appears not to
 * respond.
 *
 * The subtlety this file exists to pin down is *when* and *where* the live
 * region must exist.
 *
 * *When*: a `role="alert"` node announces a change to its contents; a node that
 * arrives already carrying its message is a new subtree, and assistive
 * technology is under no obligation to read it. So the familiar
 * `{error && <div role="alert">{error}</div>}` reliably announces the *second*
 * failure and swallows the first — the one that matters.
 *
 * *Where*: `Modal` (src/components/ui/Modal.tsx) sets `aria-modal="true"`, which
 * tells assistive technology to ignore everything *outside* the dialog. A region
 * that is technically in the document but parked on `document.body` is outside
 * every open dialog, so it is announced into a subtree nothing is listening to.
 * A test that only checks "the element exists" cannot see this at all, which is
 * what makes it a good bug: it passes.
 *
 * Every surface below therefore mounts `<ErrorLiveRegion>`
 * (src/components/a11y/LiveRegion.tsx) unconditionally, inline, and lets its
 * text change.
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
import { CreateBookWizard } from '../CreateBookWizard';
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
    // Not a failed action but a status change, and one that renders with its
    // text already in place — exactly the shape that never announces when the
    // role is hand-rolled onto the visible panel.
    'src/components/dashboard/KPIGrid.tsx',
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
    'src/components/reports/ValuationCoverageNotice.tsx',
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

    it('the shared region renders inline, never through a portal', () => {
        // A portal to document.body puts the region outside every aria-modal
        // dialog, where assistive technology is told not to look. The behaviour
        // is covered below; this keeps the mechanism from creeping back in as a
        // well-meaning fix for the spacing note in LiveRegion.tsx.
        expect(
            source('src/components/a11y/LiveRegion.tsx'),
            'a portalled region lands outside aria-modal dialogs and is never announced'
        ).not.toContain('createPortal');
    });
});

/**
 * Every DOM mutation under `document.body` while `run()` executes, in order.
 *
 * This is the only way to see the distinction that matters. Once React has
 * committed, a region that mounted with its text and a region that mounted
 * empty and was then updated are *indistinguishable* by inspection — same node,
 * same `textContent`. Only the sequence of mutations tells them apart, and the
 * sequence is exactly what a screen reader responds to.
 */
function recordMutations(run: () => void): MutationRecord[] {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((rs) => records.push(...rs));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
        run();
        // Drains synchronously; the callback would not have fired yet.
        records.push(...observer.takeRecords());
    } finally {
        observer.disconnect();
    }
    return records;
}

/**
 * Index of the record that put `node` into the document, or -1.
 *
 * React commits a whole tree at once, so on mount the region arrives as part of
 * a larger added subtree rather than as an `addedNodes` entry of its own.
 */
function insertionOf(records: MutationRecord[], node: Node): number {
    return records.findIndex((r) =>
        Array.from(r.addedNodes).some((added) => added === node || added.contains(node))
    );
}

/** Index of the first record after `after` that changed the contents of `node`, or -1. */
function contentChangeOf(records: MutationRecord[], node: Node, after = -1): number {
    return records.findIndex(
        (r, i) => i > after && (r.target === node || node.contains(r.target))
    );
}

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

/**
 * The regression that a "does the element exist" test cannot see.
 *
 * Testing Library does not model `aria-modal` inertness — `getByRole('alert')`
 * happily returns a region sitting on `document.body` while a modal dialog is
 * open, even though a real screen reader would never read it. So these tests
 * assert containment and mutation order rather than mere queryability.
 */
describe('inside an aria-modal dialog, the announcement actually reaches the user', () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    const DIALOGS: {
        name: string;
        open: () => void;
        fail: () => void;
        announced: string;
    }[] = [
        {
            name: 'BookEditorModal',
            open: () =>
                render(
                    <BookEditorModal
                        book={{ guid: 'book-1', name: 'Household', description: null }}
                        isOpen
                        onClose={() => {}}
                        onSaved={() => {}}
                        onDeleted={() => {}}
                    />
                ),
            fail: () => {
                fireEvent.change(screen.getByPlaceholderText(/book name/i), {
                    target: { value: '  ' },
                });
                fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
            },
            announced: 'Name is required',
        },
        {
            name: 'SaveReportDialog',
            open: () =>
                render(
                    <SaveReportDialog
                        isOpen
                        onClose={() => {}}
                        onSave={async () => {}}
                        baseReportType={ReportType.BALANCE_SHEET}
                        currentConfig={{}}
                    />
                ),
            fail: () => fireEvent.click(screen.getByRole('button', { name: /^save$/i })),
            announced: 'Name is required',
        },
        {
            name: 'BatchEditModal',
            open: () =>
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
                ),
            fail: () => {
                fireEvent.change(screen.getByLabelText(/amount per period/i), {
                    target: { value: 'a lot' },
                });
                fireEvent.click(screen.getByRole('button', { name: /apply to all periods/i }));
            },
            announced: 'Please enter a valid number',
        },
    ];

    it.each(DIALOGS)('$name', ({ open, fail, announced }) => {
        open();

        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');

        const liveRegion = screen.getByRole('alert');

        // The whole bug in one assertion: aria-modal="true" hides everything
        // outside this element from assistive technology, so a region that is
        // not a descendant is announced to nobody.
        expect(
            dialog.contains(liveRegion),
            'live region is outside the aria-modal dialog — it will never be announced'
        ).toBe(true);

        // And nothing was left behind on document.body either.
        const strays = Array.from(
            document.querySelectorAll('[role="alert"], [role="status"]')
        ).filter((node) => !dialog.contains(node));
        expect(strays, 'live region(s) stranded outside the open dialog').toEqual([]);

        // In the tree, and silent, before there is anything to say.
        expect(liveRegion.textContent).toBe('');

        const records = recordMutations(fail);

        // The text ARRIVED as a change to a node that was already there, rather
        // than the node arriving with the text. That is the difference between
        // an announcement and silence, and it is invisible in the final DOM.
        const changed = contentChangeOf(records, liveRegion);
        expect(changed, 'the live region was never mutated — nothing was announced').toBeGreaterThanOrEqual(0);
        expect(
            insertionOf(records, liveRegion),
            'the region was re-inserted rather than updated — a fresh subtree is not announced'
        ).toBe(-1);

        // Same node throughout, still inside the dialog, now carrying the text.
        expect(screen.getByRole('alert')).toBe(liveRegion);
        expect(dialog.contains(liveRegion)).toBe(true);
        expect(liveRegion).toHaveTextContent(announced);
    });
});

describe('a message that is already in hand at mount is still announced', () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('LoginForm: an OIDC failure arrives in props on the very first render', () => {
        const flowError = 'Sign-in with your identity provider failed';

        // Nothing here is asynchronous: the message exists before the component
        // does. Mounting the region and the text together is precisely the bug,
        // so the region has to hold the text back until it is in the tree.
        const records = recordMutations(() =>
            render(
                <LoginForm
                    mode="login"
                    onToggleMode={() => {}}
                    oidcProvider="Okta"
                    flowError={flowError}
                />
            )
        );

        const liveRegion = screen.getByRole('alert');
        expect(liveRegion).toHaveTextContent(flowError);

        const inserted = insertionOf(records, liveRegion);
        const changed = contentChangeOf(records, liveRegion, inserted);

        expect(inserted, 'never saw the region enter the document').toBeGreaterThanOrEqual(0);
        expect(
            changed,
            'the region entered the document already carrying its message — assistive technology is not obliged to read that'
        ).toBeGreaterThan(inserted);
    });

    it('CreateBookWizard: one region for the wizard, not one per step', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            json: async () => ({ error: 'Demo book creation failed' }),
        } as Response);

        render(<CreateBookWizard onBookCreated={() => {}} />);

        const liveRegion = screen.getByRole('alert');
        expect(liveRegion.textContent).toBe('');

        fireEvent.click(screen.getByRole('button', { name: /demo book with sample data/i }));
        fireEvent.click(screen.getByRole('button', { name: /demo household/i }));

        await waitFor(() => expect(liveRegion).toHaveTextContent('Demo book creation failed'));

        // Stepping away and back is where a step-local region betrays itself: it
        // unmounts and then remounts with the previous failure already in its
        // text. A single hoisted region is the same node the whole way through.
        fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
        expect(screen.getByRole('alert')).toBe(liveRegion);

        fireEvent.click(screen.getByRole('button', { name: /demo book with sample data/i }));
        expect(screen.getByRole('alert')).toBe(liveRegion);
        expect(screen.getAllByRole('alert')).toHaveLength(1);
    });
});
