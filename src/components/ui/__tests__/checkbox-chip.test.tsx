import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CheckboxChip } from '../CheckboxChip';

afterEach(cleanup);

describe('CheckboxChip', () => {
    it('exposes checkbox role and checked state to assistive technology', () => {
        render(
            <CheckboxChip checked={false} onChange={() => {}}>
                Sub-Accounts
            </CheckboxChip>,
        );
        const box = screen.getByRole('checkbox', { name: 'Sub-Accounts' });
        expect(box.getAttribute('aria-checked')).toBe('false');
    });

    it('reports aria-checked=true when on', () => {
        render(
            <CheckboxChip checked onChange={() => {}}>
                Unreviewed Only
            </CheckboxChip>,
        );
        expect(screen.getByRole('checkbox', { name: 'Unreviewed Only' }).getAttribute('aria-checked')).toBe('true');
    });

    it('toggles on click and on keyboard activation', () => {
        const onChange = vi.fn();
        render(
            <CheckboxChip checked={false} onChange={onChange}>
                Sub-Accounts
            </CheckboxChip>,
        );
        const box = screen.getByRole('checkbox');
        fireEvent.click(box);
        expect(onChange).toHaveBeenCalledWith(true);

        // A <button> host is what makes Space/Enter work without extra key
        // handlers; jsdom does not synthesise the click, so assert the host.
        expect(box.tagName).toBe('BUTTON');
        expect(box.getAttribute('type')).toBe('button');
        expect((box as HTMLButtonElement).tabIndex).toBe(0);
    });

    it('does not use glyph characters to convey state', () => {
        const { container, rerender } = render(
            <CheckboxChip checked onChange={() => {}}>
                Sub-Accounts
            </CheckboxChip>,
        );
        expect(container.textContent).not.toMatch(/[☐☑☒]/);
        rerender(
            <CheckboxChip checked={false} onChange={() => {}}>
                Sub-Accounts
            </CheckboxChip>,
        );
        expect(container.textContent).not.toMatch(/[☐☑☒]/);
    });

    it('does not double up the accessible name with a decorative check', () => {
        render(
            <CheckboxChip checked onChange={() => {}}>
                Sub-Accounts
            </CheckboxChip>,
        );
        const box = screen.getByRole('checkbox');
        expect(box.querySelector('[aria-hidden="true"]')).not.toBeNull();
        expect(box.textContent).toBe('Sub-Accounts');
    });
});
