import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CollapsibleConfigSection } from '../CollapsibleConfigSection';

function renderSection(configured: boolean, storageKey?: string) {
    return render(
        <CollapsibleConfigSection title="Accounts" configured={configured} storageKey={storageKey} summary="3 selected">
            <p>panel body</p>
        </CollapsibleConfigSection>,
    );
}

describe('CollapsibleConfigSection', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('renders expanded and non-collapsible while unconfigured', () => {
        renderSection(false);
        expect(screen.getByText('panel body')).toBeTruthy();
        expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
        expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('defaults to collapsed when it mounts already configured', () => {
        renderSection(true);
        expect(screen.queryByText('panel body')).toBeNull();
        expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    });

    it('stays open when a section configured after mount, until the user collapses it', () => {
        const { rerender } = renderSection(false);
        rerender(
            <CollapsibleConfigSection title="Accounts" configured summary="3 selected">
                <p>panel body</p>
            </CollapsibleConfigSection>,
        );
        expect(screen.getByText('panel body')).toBeTruthy();

        fireEvent.click(screen.getByRole('button'));
        expect(screen.queryByText('panel body')).toBeNull();
    });

    it('re-expands when the configuration is cleared', () => {
        const { rerender } = renderSection(true);
        expect(screen.queryByText('panel body')).toBeNull();

        rerender(
            <CollapsibleConfigSection title="Accounts" configured={false} summary="3 selected">
                <p>panel body</p>
            </CollapsibleConfigSection>,
        );
        expect(screen.getByText('panel body')).toBeTruthy();
    });

    it('restores the stored expand choice for a configured section', () => {
        localStorage.setItem('cfg-accounts', 'true');
        renderSection(true, 'cfg-accounts');
        expect(screen.getByText('panel body')).toBeTruthy();

        fireEvent.click(screen.getByRole('button'));
        expect(localStorage.getItem('cfg-accounts')).toBe('false');
    });
});
