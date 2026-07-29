import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import SimpleFinSyncIndicator, { isSimpleFinSyncFailure } from '../SimpleFinSyncIndicator';

describe('SimpleFinSyncIndicator', () => {
    it('shows a muted linked indicator for a healthy mapped account', () => {
        render(<SimpleFinSyncIndicator status="success" />);

        const indicator = screen.getByRole('status', { name: 'Linked to SimpleFIN' });
        expect(indicator).toHaveClass('text-foreground-muted');
        expect(indicator).toHaveTextContent('Linked to SimpleFIN');
    });

    it('shows a red failure indicator when a sync fails', () => {
        render(
            <SimpleFinSyncIndicator
                status="failed"
                error="SimpleFIN could not fetch the account"
            />,
        );

        const indicator = screen.getByRole('status', { name: 'SimpleFIN sync failed' });
        expect(indicator).toHaveClass('text-error');
        expect(indicator).toHaveAttribute(
            'title',
            'SimpleFIN sync failed: SimpleFIN could not fetch the account',
        );
    });

    it('identifies authorization failures explicitly', () => {
        render(
            <SimpleFinSyncIndicator
                status="failed"
                error="Connection may need attention. Auth required"
            />,
        );

        expect(
            screen.getByRole('status', { name: 'SimpleFIN authorization required' }),
        ).toHaveClass('text-error');
    });

    it('keeps compact hierarchy indicators accessible', () => {
        render(
            <SimpleFinSyncIndicator
                status="revoked"
                error="Access has been revoked"
                compact
            />,
        );

        expect(
            screen.getByRole('img', { name: 'SimpleFIN authorization required' }),
        ).toHaveClass('text-error');
    });
});

describe('isSimpleFinSyncFailure', () => {
    it('treats failed and revoked statuses as failures', () => {
        expect(isSimpleFinSyncFailure('failed')).toBe(true);
        expect(isSimpleFinSyncFailure('revoked')).toBe(true);
        expect(isSimpleFinSyncFailure('success')).toBe(false);
        expect(isSimpleFinSyncFailure(null)).toBe(false);
    });
});
