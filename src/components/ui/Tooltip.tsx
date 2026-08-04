'use client';

import {
    KeyboardEvent as ReactKeyboardEvent,
    ReactNode,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import { createPortal } from 'react-dom';

const EDGE_GAP = 8; // min distance from viewport edges
const TRIGGER_GAP = 6; // distance between trigger and tooltip

export interface TooltipProps {
    /** Tooltip body. Keep it to one or two short sentences. */
    content: ReactNode;
    /** Trigger content. The wrapper span is focusable and carries the aria wiring. */
    children: ReactNode;
    /** Delay before showing on hover (ms). Focus and tap open immediately. */
    showDelay?: number;
    /** Delay before hiding after the pointer leaves (ms). */
    hideDelay?: number;
    /** Extra classes for the trigger wrapper span. */
    className?: string;
    /** Max width of the tooltip panel. */
    maxWidth?: number;
    /** Accessible label for the trigger wrapper (falls back to its text content). */
    ariaLabel?: string;
    /**
     * Render a non-focusable trigger (no `role`/`tabIndex`) so the tooltip can
     * legally sit inside an interactive ancestor (button, link) — HTML forbids
     * focusable descendants there. Opens on hover and tap; a tap suppresses the
     * ancestor's own action so the tooltip can be read before acting.
     */
    nested?: boolean;
}

/**
 * Dependency-free tooltip primitive (DESIGN.md: surface-elevated panel, border,
 * 13px body). Opens on hover (with delay), keyboard focus, and tap; dismisses on
 * Escape, blur, pointer-out, and outside tap. Positioned via a portal with
 * viewport-aware flipping (above by default, below when there is no room) and
 * horizontal clamping. Wires `aria-describedby` to the trigger while open.
 */
export function Tooltip({
    content,
    children,
    showDelay = 250,
    hideDelay = 100,
    className = '',
    maxWidth = 288,
    ariaLabel,
    nested = false,
}: TooltipProps) {
    const id = useId();
    const tooltipId = `tooltip-${id}`;
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Tap-to-open should stay open until dismissed; hover uses the hide delay.
    const pinnedRef = useRef(false);

    const clearTimers = useCallback(() => {
        if (showTimer.current) clearTimeout(showTimer.current);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        showTimer.current = null;
        hideTimer.current = null;
    }, []);

    const show = useCallback(() => {
        clearTimers();
        setOpen(true);
    }, [clearTimers]);

    const hide = useCallback(() => {
        clearTimers();
        pinnedRef.current = false;
        setOpen(false);
    }, [clearTimers]);

    const scheduleShow = useCallback(() => {
        clearTimers();
        showTimer.current = setTimeout(() => setOpen(true), showDelay);
    }, [clearTimers, showDelay]);

    const scheduleHide = useCallback(() => {
        if (pinnedRef.current) return;
        clearTimers();
        hideTimer.current = setTimeout(() => setOpen(false), hideDelay);
    }, [clearTimers, hideDelay]);

    useEffect(() => clearTimers, [clearTimers]);

    // Position: above the trigger, centered; flip below when out of room; clamp X.
    // Applied imperatively to the portal panel (DOM is the external system here),
    // so measuring + positioning never round-trips through React state.
    const reposition = useCallback(() => {
        const trigger = triggerRef.current;
        const panel = panelRef.current;
        if (!trigger || !panel) return;
        const rect = trigger.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let top = rect.top - panelRect.height - TRIGGER_GAP;
        if (top < EDGE_GAP) {
            const below = rect.bottom + TRIGGER_GAP;
            // Flip below unless that would push it off the bottom edge too.
            if (below + panelRect.height + EDGE_GAP <= vh || below < EDGE_GAP) top = below;
            else top = Math.max(EDGE_GAP, vh - panelRect.height - EDGE_GAP);
        }

        let left = rect.left + rect.width / 2 - panelRect.width / 2;
        left = Math.min(Math.max(left, EDGE_GAP), Math.max(EDGE_GAP, vw - panelRect.width - EDGE_GAP));

        panel.style.top = `${top}px`;
        panel.style.left = `${left}px`;
        panel.style.visibility = 'visible';
    }, []);

    useLayoutEffect(() => {
        if (!open) return;
        reposition();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [open, reposition]);

    // Escape + outside-tap dismissal while open.
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') hide();
        };
        const onPointerDown = (e: Event) => {
            const target = e.target as Node;
            if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            hide();
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('touchstart', onPointerDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('touchstart', onPointerDown);
        };
    }, [open, hide]);

    const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
        if (e.key === 'Escape' && open) {
            e.stopPropagation();
            hide();
        }
    };

    return (
        <span
            ref={triggerRef}
            tabIndex={nested ? undefined : 0}
            role={nested ? undefined : 'button'}
            aria-label={ariaLabel}
            aria-describedby={open ? tooltipId : undefined}
            className={`inline-flex cursor-help items-baseline outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-primary/60 ${className}`}
            onMouseEnter={scheduleShow}
            onMouseLeave={scheduleHide}
            onFocus={show}
            onBlur={hide}
            onKeyDown={onTriggerKeyDown}
            onClick={(e) => {
                // Tap/click toggles and pins (touch has no hover-out to dismiss).
                // Always cancel any ancestor default (label activation, link
                // navigation, button submit) — a tap on the hint reads the hint,
                // nothing else.
                e.preventDefault();
                e.stopPropagation();
                if (open && pinnedRef.current) {
                    hide();
                } else {
                    pinnedRef.current = true;
                    show();
                }
            }}
        >
            {children}
            {open &&
                typeof document !== 'undefined' &&
                createPortal(
                    <div
                        ref={panelRef}
                        id={tooltipId}
                        role="tooltip"
                        style={{ position: 'fixed', top: 0, left: 0, visibility: 'hidden', maxWidth }}
                        className="z-[10000] rounded-md border border-border bg-surface-elevated px-3 py-2 text-[13px] leading-snug text-foreground shadow-lg"
                        onMouseEnter={show}
                        onMouseLeave={scheduleHide}
                    >
                        {content}
                    </div>,
                    document.body,
                )}
        </span>
    );
}
