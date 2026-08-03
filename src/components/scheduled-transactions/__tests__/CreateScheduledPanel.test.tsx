import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// The real selector fetches the account hierarchy. This stand-in keeps its
// value in uncontrolled DOM state, which is exactly the per-instance state that
// index-based keys corrupt when a middle row is removed.
vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: ({ placeholder }: { placeholder?: string }) => (
        <input aria-label="account" placeholder={placeholder} defaultValue="" />
    ),
}));

import { CreateScheduledPanel } from '../CreateScheduledPanel';

describe('CreateScheduledPanel splits', () => {
    it('keeps each split row bound to its own child state when a middle row is removed', () => {
        render(<CreateScheduledPanel onClose={() => {}} onCreated={() => {}} />);

        fireEvent.click(screen.getByText('+ Add Split'));

        const accountInputs = () => screen.getAllByLabelText('account') as HTMLInputElement[];
        expect(accountInputs()).toHaveLength(3);

        accountInputs().forEach((input, i) => {
            fireEvent.change(input, { target: { value: `account-${i}` } });
        });

        // Remove the middle split.
        fireEvent.click(screen.getAllByLabelText('Remove split')[1]);

        const remaining = accountInputs();
        expect(remaining).toHaveLength(2);
        expect(remaining.map(i => i.value)).toEqual(['account-0', 'account-2']);
    });
});
