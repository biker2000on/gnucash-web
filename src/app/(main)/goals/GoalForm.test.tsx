import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GoalForm, goalToFormValues } from './GoalForm';

vi.mock('@/components/ui/AccountSelector', () => ({
    AccountSelector: () => <div data-testid="account-selector" />,
}));

describe('GoalForm', () => {
    it('pads the form content inside the shared modal', () => {
        const { container } = render(
            <GoalForm
                initial={goalToFormValues(null)}
                saving={false}
                submitLabel="Create Goal"
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        expect(container.querySelector('form')).toHaveClass('p-6');
    });

    it('explains the emergency-fund expense basis', () => {
        render(
            <GoalForm
                initial={{
                    ...goalToFormValues(null),
                    goalType: 'emergency_fund',
                    targetMonths: '2',
                }}
                saving={false}
                submitLabel="Create Goal"
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        expect(screen.getByText(/12 completed months of non-tax spending/i)).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Used only when no expense history exists')).toHaveAttribute(
            'placeholder',
            'Used only when no expense history exists'
        );
    });
});
