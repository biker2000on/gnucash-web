import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CandidateTable } from './CandidateTable';
import type { ReconcileCandidate } from '@/lib/reconcile-shared';

const candidates: ReconcileCandidate[] = [
    {
        guid: 'one',
        transactionGuid: 'tx-one',
        date: '2026-07-01T00:00:00.000Z',
        num: '',
        description: 'First item',
        memo: '',
        amount: 10,
        state: 'c',
    },
    {
        guid: 'two',
        transactionGuid: 'tx-two',
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
                onDelete={vi.fn()}
                currency="USD"
                commodityScu={100}
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
                onDelete={vi.fn()}
                currency="USD"
                commodityScu={100}
            />,
        );

        fireEvent.click(screen.getByLabelText('Select all splits'));
        expect(onSelectAll).toHaveBeenCalledWith(true);
    });

    it('requests deletion without toggling the row', () => {
        const onToggle = vi.fn();
        const onDelete = vi.fn();
        render(
            <CandidateTable
                candidates={candidates}
                selected={new Set()}
                onToggle={onToggle}
                onSelectAll={vi.fn()}
                onDelete={onDelete}
                currency="USD"
                commodityScu={100}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Delete First item' }));
        expect(onDelete).toHaveBeenCalledWith(candidates[0]);
        expect(onToggle).not.toHaveBeenCalled();
    });
});
