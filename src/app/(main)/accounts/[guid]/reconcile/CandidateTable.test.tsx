import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CandidateTable } from './CandidateTable';
import type { ReconcileCandidate } from '@/lib/reconcile-shared';

const candidates: ReconcileCandidate[] = [
    {
        guid: 'one',
        date: '2026-07-01T00:00:00.000Z',
        num: '',
        description: 'First item',
        memo: '',
        amount: 10,
        state: 'c',
    },
    {
        guid: 'two',
        date: '2026-07-02T00:00:00.000Z',
        num: '',
        description: 'Second item',
        memo: '',
        amount: -5,
        state: 'n',
    },
];

describe('CandidateTable', () => {
    it('passes shift-click information from rows and checkboxes', () => {
        const onToggle = vi.fn();
        render(
            <CandidateTable
                candidates={candidates}
                selected={new Set()}
                onToggle={onToggle}
                onSelectAll={vi.fn()}
                currency="USD"
            />,
        );

        fireEvent.click(screen.getByText('Second item').closest('tr')!, { shiftKey: true });
        expect(onToggle).toHaveBeenLastCalledWith(1, true);

        fireEvent.click(screen.getByLabelText('Select First item'), { shiftKey: true });
        expect(onToggle).toHaveBeenLastCalledWith(0, true);
    });

    it('uses the header checkbox for every candidate', () => {
        const onSelectAll = vi.fn();
        render(
            <CandidateTable
                candidates={candidates}
                selected={new Set()}
                onToggle={vi.fn()}
                onSelectAll={onSelectAll}
                currency="USD"
            />,
        );

        fireEvent.click(screen.getByLabelText('Select all splits'));
        expect(onSelectAll).toHaveBeenCalledWith(true);
    });
});
