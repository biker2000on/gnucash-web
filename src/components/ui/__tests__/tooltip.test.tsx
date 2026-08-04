import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip } from '../Tooltip';

function renderTooltip() {
    return render(
        <Tooltip content="Qualified Business Income" showDelay={0} hideDelay={0}>
            QBI
        </Tooltip>,
    );
}

function trigger() {
    return screen.getByText('QBI');
}

describe('Tooltip', () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('is closed by default and opens on keyboard focus', () => {
        renderTooltip();
        expect(screen.queryByRole('tooltip')).toBeNull();

        fireEvent.focus(trigger());
        expect(screen.getByRole('tooltip').textContent).toContain('Qualified Business Income');
    });

    it('wires aria-describedby to the tooltip id while open', () => {
        renderTooltip();
        expect(trigger().getAttribute('aria-describedby')).toBeNull();

        fireEvent.focus(trigger());
        const describedBy = trigger().getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        expect(screen.getByRole('tooltip').id).toBe(describedBy);
    });

    it('closes on blur', () => {
        renderTooltip();
        fireEvent.focus(trigger());
        expect(screen.getByRole('tooltip')).toBeTruthy();

        fireEvent.blur(trigger());
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('closes on Escape', () => {
        renderTooltip();
        fireEvent.focus(trigger());
        expect(screen.getByRole('tooltip')).toBeTruthy();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('opens on hover after the show delay', () => {
        vi.useFakeTimers();
        render(
            <Tooltip content="hover body" showDelay={200} hideDelay={0}>
                trigger-text
            </Tooltip>,
        );
        fireEvent.mouseEnter(screen.getByText('trigger-text'));
        expect(screen.queryByRole('tooltip')).toBeNull();

        act(() => {
            vi.advanceTimersByTime(250);
        });
        expect(screen.getByRole('tooltip').textContent).toContain('hover body');
    });

    it('cancels a pending hover open when the pointer leaves', () => {
        vi.useFakeTimers();
        render(
            <Tooltip content="hover body" showDelay={200} hideDelay={0}>
                trigger-text
            </Tooltip>,
        );
        const el = screen.getByText('trigger-text');
        fireEvent.mouseEnter(el);
        fireEvent.mouseLeave(el);
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('opens on tap (click) and closes on outside tap', () => {
        renderTooltip();
        fireEvent.click(trigger());
        expect(screen.getByRole('tooltip')).toBeTruthy();

        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('renders the panel with role=tooltip in a portal on document.body', () => {
        renderTooltip();
        fireEvent.focus(trigger());
        const panel = screen.getByRole('tooltip');
        expect(panel.parentElement).toBe(document.body);
    });
});
