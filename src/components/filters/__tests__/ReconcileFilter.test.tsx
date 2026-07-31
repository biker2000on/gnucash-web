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
        expect(screen.getByTitle('Not Reconciled')).toHaveClass('flex-1', 'min-w-0');
        expect(screen.getByTitle('Cleared')).toHaveClass('flex-1', 'min-w-0');
        expect(screen.getByTitle('Reconciled')).toHaveClass('flex-1', 'min-w-0');
    });
});
