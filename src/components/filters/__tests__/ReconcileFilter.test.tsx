import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReconcileFilter } from '../ReconcileFilter';

describe('ReconcileFilter', () => {
    it('keeps full state labels hidden until the ledger desktop breakpoint and lets controls shrink', () => {
        const { container } = render(
            <ReconcileFilter selectedStates={[]} onChange={vi.fn()} />
        );

        expect(screen.getByText('Not Reconciled')).toHaveClass('hidden', 'md:inline');
        expect(screen.getByText('Cleared')).toHaveClass('hidden', 'md:inline');
        expect(screen.getByText('Reconciled')).toHaveClass('hidden', 'md:inline');

        const controls = container.querySelector('.flex.min-w-0.gap-2');
        expect(controls).toBeInTheDocument();
        // The hint is a Tip, not a native title= (DESIGN.md), so the buttons
        // are found by their short-label text instead.
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(3);
        for (const button of buttons) expect(button).toHaveClass('flex-1', 'min-w-0');
    });
});
