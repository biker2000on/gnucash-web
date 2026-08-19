'use client';

import {
    KeyboardEvent as ReactKeyboardEvent,
    ReactElement,
    ReactNode,
    Ref,
    cloneElement,
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

/* ------------------------------------------------------------------------- */

/**
 * Forward an element to whatever ref the cloned child already had.
 *
 * Module-level on purpose: writing `ref.current` inside `Tip` reads to the
 * `react-hooks/immutability` lint rule as mutating a value reached through the
 * `children` prop. It is not — a ref object exists to be written — but the
 * rule cannot see that through the alias, and taking the ref as a plain
 * parameter is both the fix and the clearer statement of intent.
 */
/** Call the child's own handler for an event Tip also listens to, if it has one. */
function callHandler(handler: unknown, event: unknown): void {
    if (typeof handler === 'function') (handler as (e: unknown) => void)(event);
}

function assignRef(ref: Ref<HTMLElement> | undefined, element: HTMLElement | null): void {
    if (!ref) return;
    if (typeof ref === 'function') ref(element);
    else (ref as { current: HTMLElement | null }).current = element;
}

/**
 * `Tip` — the accessible replacement for a native `title=` attribute.
 *
 * DESIGN.md bans `title=` as a hint mechanism: it never appears on touch, it
 * cannot be styled or reached by keyboard, its ~1s delay hides it from most
 * users, and screen-reader support is inconsistent and unconfigurable. But the
 * ~350 sites that used it are `<td>`s, `<th>`s, table cells and buttons wedged
 * into flex and grid rows — wrapping each in `Tooltip`'s focusable `<span>`
 * would both change layout and, on a `<td>`, produce invalid HTML.
 *
 * `Tip` therefore renders **no element of its own**. It clones its single
 * child and merges in the hover/focus handlers plus `aria-describedby`, so the
 * DOM shape, the CSS selectors, the table structure and the tab order all stay
 * exactly what they were. What changes is that the hint now opens on keyboard
 * focus and on tap as well as hover, is styled, and is a real `role="tooltip"`
 * wired to its trigger.
 *
 * Two cases a plain wrapper cannot handle:
 *
 *  - **Disabled children.** Browsers fire no pointer events on a disabled
 *    control, so a hover tooltip on one is dead on arrival (that is most of
 *    the read-only hints). When the child is disabled, `Tip` instead mounts a
 *    permanently hidden description node and points `aria-describedby` at it —
 *    the only channel a disabled control still has.
 *  - **Text that is already the accessible name.** Pass `describedBy={false}`
 *    when the same string is on the child as `aria-label` (icon-only buttons),
 *    so a screen reader does not read it twice.
 *
 * Falsy `content` is a passthrough: `<Tip content={cond ? hint : undefined}>`
 * costs nothing when there is no hint, which is the shape most call sites
 * already had inside their `title=` ternaries.
 */
export function Tip({
    content,
    children,
    showDelay = 250,
    hideDelay = 100,
    maxWidth = 288,
    describedBy = true,
}: {
    /** Hint text. Falsy renders the child untouched. */
    content?: ReactNode;
    /** Exactly one element. It must forward `ref` — every host element does. */
    children: ReactElement;
    showDelay?: number;
    hideDelay?: number;
    maxWidth?: number;
    /** Set false when the same text is already the child's accessible name. */
    describedBy?: boolean;
}) {
    const id = useId();
    const tooltipId = `tip-${id}`;
    const [open, setOpen] = useState(false);
    const [node, setNode] = useState<HTMLElement | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearTimers = useCallback(() => {
        if (showTimer.current) clearTimeout(showTimer.current);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        showTimer.current = null;
        hideTimer.current = null;
    }, []);
    useEffect(() => clearTimers, [clearTimers]);

    const reposition = useCallback(() => {
        const panel = panelRef.current;
        if (!node || !panel) return;
        const rect = node.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let top = rect.top - panelRect.height - TRIGGER_GAP;
        if (top < EDGE_GAP) {
            const below = rect.bottom + TRIGGER_GAP;
            if (below + panelRect.height + EDGE_GAP <= vh || below < EDGE_GAP) top = below;
            else top = Math.max(EDGE_GAP, vh - panelRect.height - EDGE_GAP);
        }
        let left = rect.left + rect.width / 2 - panelRect.width / 2;
        left = Math.min(Math.max(left, EDGE_GAP), Math.max(EDGE_GAP, vw - panelRect.width - EDGE_GAP));

        panel.style.top = `${top}px`;
        panel.style.left = `${left}px`;
        panel.style.visibility = 'visible';
    }, [node]);

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

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                clearTimers();
                setOpen(false);
            }
        };
        const onPointerDown = (e: Event) => {
            const target = e.target as Node;
            if (node?.contains(target) || panelRef.current?.contains(target)) return;
            clearTimers();
            setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('touchstart', onPointerDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('touchstart', onPointerDown);
        };
    }, [open, node, clearTimers]);

    // The four handlers are memoised rather than written inline in the
    // cloneElement call because they touch the timer refs, and refs may not be
    // read during render (react-hooks/refs).
    const openAfterDelay = useCallback(() => {
        clearTimers();
        showTimer.current = setTimeout(() => setOpen(true), showDelay);
    }, [clearTimers, showDelay]);
    const closeAfterDelay = useCallback(() => {
        clearTimers();
        hideTimer.current = setTimeout(() => setOpen(false), hideDelay);
    }, [clearTimers, hideDelay]);
    const openNow = useCallback(() => {
        clearTimers();
        setOpen(true);
    }, [clearTimers]);
    const closeNow = useCallback(() => {
        clearTimers();
        setOpen(false);
    }, [clearTimers]);

    if (content === null || content === undefined || content === false || content === '') {
        return children;
    }

    const childProps = (children.props ?? {}) as Record<string, unknown> & {
        ref?: Ref<HTMLElement>;
        disabled?: boolean;
        'aria-describedby'?: string;
    };
    const isDisabled = childProps.disabled === true;
    // A disabled control fires no pointer events, so the hidden description is
    // the only channel left; otherwise describe it only while the tip is open.
    const describe = describedBy && (isDisabled || open);

    const existingRef = childProps.ref ?? (children as { ref?: Ref<HTMLElement> }).ref;
    const setRef = (element: HTMLElement | null) => {
        setNode(element);
        assignRef(existingRef, element);
    };

    // react-hooks/refs reads "a ref in a props object during render" as reading
    // a ref's value during render. Here `setRef` is a ref CALLBACK being handed
    // to React to invoke after commit — the one legal way to attach to a child
    // you did not create. Nothing reads `.current` here.
    // eslint-disable-next-line react-hooks/refs
    const cloned = cloneElement(children, {
        ref: setRef,
        'aria-describedby': describe
            ? [childProps['aria-describedby'], tooltipId].filter(Boolean).join(' ')
            : childProps['aria-describedby'],
        // The child's own handler still runs — Tip is additive, never a
        // replacement for what the call site already wired up.
        onMouseEnter: (e: unknown) => {
            openAfterDelay();
            callHandler(childProps.onMouseEnter, e);
        },
        onMouseLeave: (e: unknown) => {
            closeAfterDelay();
            callHandler(childProps.onMouseLeave, e);
        },
        onFocus: (e: unknown) => {
            openNow();
            callHandler(childProps.onFocus, e);
        },
        onBlur: (e: unknown) => {
            closeNow();
            callHandler(childProps.onBlur, e);
        },
    } as Record<string, unknown>);

    return (
        <>
            {cloned}
            {typeof document !== 'undefined' &&
                (open || (isDisabled && describedBy)) &&
                createPortal(
                    open ? (
                        <div
                            ref={panelRef}
                            id={tooltipId}
                            role="tooltip"
                            style={{ position: 'fixed', top: 0, left: 0, visibility: 'hidden', maxWidth }}
                            className="z-[10000] rounded-md border border-border bg-surface-elevated px-3 py-2 text-[13px] leading-snug text-foreground shadow-lg"
                            onMouseEnter={clearTimers}
                            onMouseLeave={closeAfterDelay}
                        >
                            {content}
                        </div>
                    ) : (
                        <div id={tooltipId} className="sr-only">
                            {content}
                        </div>
                    ),
                    document.body,
                )}
        </>
    );
}
