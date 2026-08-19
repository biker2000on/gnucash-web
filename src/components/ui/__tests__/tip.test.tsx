import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Tip } from '../Tooltip';

afterEach(cleanup);

describe('Tip', () => {
    it('adds no element of its own — the child is the only DOM node', () => {
        const { container } = render(
            <Tip content="Return of capital reduces basis">
                <button type="button">ROC</button>
            </Tip>,
        );
        expect(container.children).toHaveLength(1);
        expect(container.firstElementChild?.tagName).toBe('BUTTON');
    });

    it('renders the child untouched when there is no hint', () => {
        render(
            <Tip content={undefined}>
                <button type="button">Plain</button>
            </Tip>,
        );
        const button = screen.getByRole('button');
        expect(button.getAttribute('aria-describedby')).toBeNull();
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('opens on keyboard focus and wires aria-describedby to the panel', () => {
        render(
            <Tip content="Return of capital reduces basis">
                <button type="button">ROC</button>
            </Tip>,
        );
        const button = screen.getByRole('button');
        fireEvent.focus(button);

        const panel = screen.getByRole('tooltip');
        expect(panel.textContent).toBe('Return of capital reduces basis');
        expect(button.getAttribute('aria-describedby')).toBe(panel.id);

        fireEvent.blur(button);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('opens on hover after the delay and closes on pointer-out', () => {
        vi.useFakeTimers();
        try {
            render(
                <Tip content="Hint" showDelay={100} hideDelay={0}>
                    <span>Target</span>
                </Tip>,
            );
            const target = screen.getByText('Target');
            fireEvent.mouseEnter(target);
            expect(screen.queryByRole('tooltip')).toBeNull();
            act(() => vi.advanceTimersByTime(120));
            expect(screen.getByRole('tooltip')).toBeTruthy();

            fireEvent.mouseLeave(target);
            act(() => vi.advanceTimersByTime(10));
            expect(screen.queryByRole('tooltip')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('dismisses on Escape', () => {
        render(
            <Tip content="Hint">
                <button type="button">Target</button>
            </Tip>,
        );
        fireEvent.focus(screen.getByRole('button'));
        expect(screen.getByRole('tooltip')).toBeTruthy();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('describes a DISABLED child permanently — it fires no pointer events', () => {
        render(
            <Tip content="Read-only access">
                <button type="button" disabled>
                    Delete
                </button>
            </Tip>,
        );
        const button = screen.getByRole('button');
        const describedBy = button.getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        expect(document.getElementById(describedBy!)?.textContent).toBe('Read-only access');
    });

    it('shows the VISIBLE panel for a disabled child on hover of the wrapper', () => {
        vi.useFakeTimers();
        try {
            render(
                <Tip content="Read-only access" showDelay={100} hideDelay={0}>
                    <button type="button" disabled>
                        Delete
                    </button>
                </Tip>,
            );
            // A disabled control fires no pointer events, so the hint has to be
            // driven by the wrapper Tip renders around it — otherwise sighted
            // users see nothing at all (native `title=` did still render here).
            const button = screen.getByRole('button', { hidden: true });
            const wrapper = button.parentElement!;
            expect(wrapper.tagName).toBe('SPAN');

            fireEvent.mouseEnter(wrapper);
            act(() => vi.advanceTimersByTime(120));
            expect(screen.getByRole('tooltip').textContent).toBe('Read-only access');

            fireEvent.mouseLeave(wrapper);
            act(() => vi.advanceTimersByTime(10));
            expect(screen.queryByRole('tooltip')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows the visible panel when the disabled child wrapper takes focus', () => {
        render(
            <Tip content="Read-only access">
                <button type="button" disabled>
                    Save
                </button>
            </Tip>,
        );
        const button = screen.getByRole('button', { hidden: true });
        const wrapper = button.parentElement!;
        expect(wrapper.getAttribute('tabindex')).toBe('0');

        fireEvent.focus(wrapper);
        const panel = screen.getByRole('tooltip');
        expect(panel.textContent).toBe('Read-only access');
        // The aria path survives: the child still points at the same node.
        expect(button.getAttribute('aria-describedby')).toBe(panel.id);

        fireEvent.blur(wrapper);
        expect(screen.queryByRole('tooltip')).toBeNull();
        // ...and falls back to the permanently mounted description.
        const describedBy = button.getAttribute('aria-describedby')!;
        expect(document.getElementById(describedBy)?.textContent).toBe('Read-only access');
    });

    it('skips aria-describedby when the text is already the accessible name', () => {
        render(
            <Tip content="Sort" describedBy={false}>
                <button type="button" aria-label="Sort" />
            </Tip>,
        );
        const button = screen.getByRole('button', { name: 'Sort' });
        fireEvent.focus(button);
        expect(screen.getByRole('tooltip')).toBeTruthy();
        expect(button.getAttribute('aria-describedby')).toBeNull();
    });

    it('keeps the child handlers and ref working', () => {
        const onClick = vi.fn();
        const onFocus = vi.fn();
        const ref = createRef<HTMLButtonElement>();
        render(
            <Tip content="Hint">
                <button type="button" ref={ref} onClick={onClick} onFocus={onFocus}>
                    Go
                </button>
            </Tip>,
        );
        const button = screen.getByRole('button');
        expect(ref.current).toBe(button);
        fireEvent.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
        fireEvent.focus(button);
        expect(onFocus).toHaveBeenCalledTimes(1);
        // ...and the tip still opened.
        expect(screen.getByRole('tooltip')).toBeTruthy();
    });

    it('works on a table cell without breaking the row structure', () => {
        render(
            <table>
                <tbody>
                    <tr>
                        <Tip content="Assets:Bank:Checking">
                            <td>Checking</td>
                        </Tip>
                    </tr>
                </tbody>
            </table>,
        );
        const cell = screen.getByRole('cell');
        expect(cell.parentElement?.tagName).toBe('TR');
        fireEvent.focus(cell);
        expect(screen.getByRole('tooltip').textContent).toBe('Assets:Bank:Checking');
    });
});
