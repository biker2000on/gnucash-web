import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Abbr } from '../Abbr';

describe('Abbr', () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('renders a known term with its glossary tooltip on focus', () => {
        render(<Abbr term="QBI" />);
        const el = screen.getByText('QBI');
        fireEvent.focus(el);
        const tip = screen.getByRole('tooltip');
        expect(tip.textContent).toContain('Qualified Business Income');
    });

    it('shows the gloss when the entry has one', () => {
        render(<Abbr term="NIIT" />);
        fireEvent.focus(screen.getByText('NIIT'));
        expect(screen.getByRole('tooltip').textContent).toContain('3.8%');
    });

    it('renders custom display text via children', () => {
        render(<Abbr term="Schedule F">Sch. F</Abbr>);
        const el = screen.getByText('Sch. F');
        fireEvent.focus(el);
        expect(screen.getByRole('tooltip').textContent).toContain('Profit or Loss From Farming');
    });

    it('includes the (i) icon by default and hides it with hideIcon', () => {
        const { container, rerender } = render(<Abbr term="AGI" />);
        expect(container.querySelector('svg')).toBeTruthy();
        rerender(<Abbr term="AGI" hideIcon />);
        expect(container.querySelector('svg')).toBeNull();
    });

    it('falls back to plain text for unknown terms with a dev console warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        render(<Abbr term="NOT-A-REAL-TERM" />);
        const el = screen.getByText('NOT-A-REAL-TERM');
        expect(el.closest('[role="button"]')).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT-A-REAL-TERM'));
        fireEvent.focus(el);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('only warns once per unknown term', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        render(
            <>
                <Abbr term="ANOTHER-UNKNOWN" />
                <Abbr term="ANOTHER-UNKNOWN" />
            </>,
        );
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('exposes an accessible label combining term and expansion', () => {
        render(<Abbr term="RMD" />);
        expect(screen.getByLabelText(/RMD: Required Minimum Distribution/)).toBeTruthy();
    });

    it('nested mode renders a non-focusable trigger (legal inside buttons/links)', () => {
        render(
            <button type="button">
                <Abbr term="LT" hideIcon nested>LT</Abbr>
            </button>,
        );
        const trigger = screen.getByText('LT');
        const span = trigger.closest('span')!;
        expect(span.getAttribute('tabindex')).toBeNull();
        expect(span.getAttribute('role')).toBeNull();
        // Tooltip still opens on tap, and the tap does not activate the ancestor.
        fireEvent.click(trigger);
        expect(screen.getByRole('tooltip').textContent).toContain('Long-Term');
    });

    it('a click on the trigger cancels the ancestor default action', () => {
        render(<Abbr term="AGI" />);
        const el = screen.getByText('AGI');
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
        fireEvent(el, clickEvent);
        expect(clickEvent.defaultPrevented).toBe(true);
    });
});
