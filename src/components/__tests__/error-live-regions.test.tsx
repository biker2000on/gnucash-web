/**
 * Screen-reader announcement of failed submits and actions (WCAG 4.1.3).
 *
 * Error text rendered as ordinary markup is silent: a screen-reader user who
 * submits a form that fails hears nothing, and the form simply appears not to
 * respond. Every error surface that reports a *failed user action* is therefore
 * an assertive live region (`role="alert"`); status and success messages, which
 * must not interrupt, are polite (`role="status"` / `aria-live="polite"`).
 *
 * Deliberately NOT covered: validation that recomputes on every keystroke.
 * A live region there produces continuous chatter and is worse than silence.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BudgetForm } from '../BudgetForm';

/**
 * Error surfaces reporting a failed submit or action, identified by a stable
 * fragment of the container's class list. Each must be assertive: the user is
 * blocked until they act on it.
 */
const ASSERTIVE_SURFACES: Array<[file: string, marker: string, count: number]> = [
    ['src/components/LoginForm.tsx', 'mb-6 p-4 bg-negative/10', 2],
    ['src/components/AccountForm.tsx', 'bg-negative/10 border border-negative/30 rounded-lg p-4 text-negative', 1],
    ['src/components/BudgetForm.tsx', 'bg-negative/10 border border-negative/30 rounded-lg p-4 text-negative', 1],
    ['src/components/BookEditorModal.tsx', 'px-3 py-2 bg-error/10', 1],
    ['src/components/CreateBookWizard.tsx', 'mb-4 p-3 bg-negative/10', 2],
    ['src/components/books/NewBookForm.tsx', 'px-3 py-2 bg-negative/10', 1],
    ['src/components/budget/BatchEditModal.tsx', 'mt-1 text-sm text-negative', 1],
    ['src/components/budget/EstimateModal.tsx', 'p-3 bg-error-light text-error', 1],
    ['src/components/reports/SaveReportDialog.tsx', 'px-3 py-2 bg-error/10', 1],
    ['src/components/scheduled-transactions/CreateScheduledPanel.tsx', 'text-negative text-sm">{error}', 1],
    ['src/components/settings/TwoFactorSection.tsx', 'text-xs text-negative">{formError}', 2],
    ['src/components/investments/ScrubAllButton.tsx', 'mb-4 bg-error-light', 1],
    ['src/components/documents/LinkedDocumentsPanel.tsx', 'border-negative/30 bg-negative/10 px-3 py-2', 1],
    ['src/components/import/BusinessImportWizard.tsx', 'bg-negative/10 border border-negative/30 rounded-lg p-4 text-sm', 2],
    ['src/components/import/PersonalImportWizard.tsx', 'bg-negative/10 border border-negative/30 rounded-lg p-4 text-sm', 2],
    ['src/components/provenance/ProvenanceModal.tsx', 'text-sm text-negative">{error}', 1],
    ['src/components/reports/TransactionDrilldownModal.tsx', 'px-4 py-6 text-sm text-negative', 1],
    ['src/components/home/BulkDetailPanel.tsx', 'border border-error/30 bg-surface/30 rounded-xl p-4', 1],
    ['src/components/home/RoomDetailPanel.tsx', 'border border-error/30 bg-surface/30 rounded-xl p-4', 1],
    ['src/components/InvestmentTransactionForm.tsx', 'bg-negative/10 border border-negative/30 rounded-lg p-4"', 1],
];

/**
 * Surfaces that report state rather than a blocked action. These must stay
 * polite so they never cut across what the user is doing.
 */
const POLITE_SURFACES: Array<[file: string, marker: string]> = [
    ['src/components/mortgage/MortgageAutoDetect.tsx', 'bg-error/10 border border-error/30 rounded-xl p-5'],
    ['src/components/investments/ChartSettingsPanel.tsx', "saved ? 'Settings saved'"],
];

function linesContaining(file: string, marker: string): string[] {
    const src = readFileSync(resolve(process.cwd(), file), 'utf8');
    return src.split(/\r?\n/).filter((line) => line.includes(marker));
}

describe('error surfaces are assertive live regions', () => {
    it.each(ASSERTIVE_SURFACES)('%s (%s)', (file, marker, count) => {
        const lines = linesContaining(file, marker);
        expect(lines, `marker no longer matches anything in ${file}`).toHaveLength(count);
        for (const line of lines) {
            expect(line, `${file}: this error surface is not announced`).toContain(
                'role="alert"'
            );
        }
    });
});

describe('status surfaces are polite live regions', () => {
    it.each(POLITE_SURFACES)('%s (%s)', (file, marker) => {
        const lines = linesContaining(file, marker);
        expect(lines.length, `marker no longer matches anything in ${file}`).toBeGreaterThan(0);
        const region = readFileSync(resolve(process.cwd(), file), 'utf8');
        expect(region).toMatch(/role="status"|aria-live="polite"/);
        for (const line of lines) {
            expect(line, `${file}: a status message must not be assertive`).not.toContain(
                'role="alert"'
            );
        }
    });
});

describe('BudgetForm announces a failed save', () => {
    afterEach(cleanup);

    it('exposes nothing before the user submits', () => {
        render(
            <BudgetForm mode="create" onSave={async () => {}} onCancel={() => {}} />
        );
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('announces the rejection through an alert region', async () => {
        render(
            <BudgetForm
                mode="create"
                onSave={async () => {
                    throw new Error('Budget name already exists');
                }}
                onCancel={() => {}}
            />
        );

        fireEvent.change(screen.getByPlaceholderText(/annual budget/i), {
            target: { value: 'Household' },
        });
        fireEvent.click(screen.getByRole('button', { name: /create budget/i }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Budget name already exists');
    });
});
