'use client';

import {
    KeyboardEvent as ReactKeyboardEvent,
    ReactElement,
    ReactNode,
    Ref,
    RefObject,
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

/** The one panel recipe (DESIGN.md: surface-elevated, 1px border, radius md, 13px). */
const PANEL_CLASS =
    'z-[10000] rounded-md border border-border bg-surface-elevated px-3 py-2 text-[13px] leading-snug text-foreground shadow-lg';

interface TooltipPanelController {
    /** Whether the panel is currently rendered. */
    open: boolean;
    /** Attach to the element the panel is positioned against. */
    anchorRef: RefObject<HTMLElement | null>;
    /** Attach to the panel element itself. */
    panelRef: RefObject<HTMLDivElement | null>;
    /** Open immediately (keyboard focus). */
    show: () => void;
    /** Close immediately and unpin (blur, Escape). */
    hide: () => void;
    /** Open after `showDelay` (hover). */
    scheduleShow: () => void;
    /** Close after `hideDelay` (pointer-out). No-op while pinned. */
    scheduleHide: () => void;
    /** Cancel any pending open/close (pointer entering the panel itself). */
    clearTimers: () => void;
    /**
     * Tap/click behaviour: pin open, or unpin and close when already pinned.
     * Touch has no pointer-out, so a tapped tooltip must survive until it is
     * dismissed explicitly (Escape, outside tap, blur).
     */
    togglePinned: () => void;
}

/**
 * Everything a tooltip needs that is not its trigger: open state, the
 * show/hide timers, viewport-aware positioning against an anchor, and the
 * Escape / outside-tap dismissal.
 *
 * `Tooltip` and `Tip` differ only in what they hang the handlers off — a
 * `<span>` of their own versus a cloned child — so this hook is deliberately
 * the whole of the shared behaviour. When it lived twice the two copies drifted
 * (only one of them pinned on tap), which is exactly the bug this prevents.
 */
function useTooltipPanel({
    showDelay,
    hideDelay,
}: {
    showDelay: number;
    hideDelay: number;
}): TooltipPanelController {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLElement | null>(null);
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

    const togglePinned = useCallback(() => {
        if (pinnedRef.current) {
            hide();
            return;
        }
        pinnedRef.current = true;
        show();
    }, [hide, show]);

    useEffect(() => clearTimers, [clearTimers]);

    // Position: above the anchor, centered; flip below when out of room; clamp X.
    // Applied imperatively to the portal panel (DOM is the external system here),
    // so measuring + positioning never round-trips through React state.
    const reposition = useCallback(() => {
        const anchor = anchorRef.current;
        const panel = panelRef.current;
        if (!anchor || !panel) return;
        const rect = anchor.getBoundingClientRect();
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
            if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
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

    return { open, anchorRef, panelRef, show, hide, scheduleShow, scheduleHide, clearTimers, togglePinned };
}

/**
 * The visible panel, portalled to `document.body` and positioned by the hook.
 * Rendered by both `Tooltip` and `Tip` so the two can never style or wire the
 * panel differently.
 */
function TooltipPanel({
    id,
    controller,
    maxWidth,
    children,
}: {
    id: string;
    controller: TooltipPanelController;
    maxWidth: number;
    children: ReactNode;
}) {
    if (typeof document === 'undefined') return null;
    return createPortal(
        <div
            ref={controller.panelRef}
            id={id}
            role="tooltip"
            style={{ position: 'fixed', top: 0, left: 0, visibility: 'hidden', maxWidth }}
            className={PANEL_CLASS}
            onMouseEnter={controller.clearTimers}
            onMouseLeave={controller.scheduleHide}
        >
            {children}
        </div>,
        document.body,
    );
}

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
    const tip = useTooltipPanel({ showDelay, hideDelay });
    const { open, hide } = tip;

    const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
        if (e.key === 'Escape' && open) {
            e.stopPropagation();
            hide();
        }
    };

    return (
        <span
            ref={tip.anchorRef as RefObject<HTMLSpanElement | null>}
            tabIndex={nested ? undefined : 0}
            role={nested ? undefined : 'button'}
            aria-label={ariaLabel}
            aria-describedby={open ? tooltipId : undefined}
            className={`inline-flex cursor-help items-baseline outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-primary/60 ${className}`}
            onMouseEnter={tip.scheduleShow}
            onMouseLeave={tip.scheduleHide}
            onFocus={tip.show}
            onBlur={tip.hide}
            onKeyDown={onTriggerKeyDown}
            onClick={(e) => {
                // Tap/click toggles and pins (touch has no hover-out to dismiss).
                // Always cancel any ancestor default (label activation, link
                // navigation, button submit) — a tap on the hint reads the hint,
                // nothing else.
                e.preventDefault();
                e.stopPropagation();
                tip.togglePinned();
            }}
        >
            {children}
            {open && (
                <TooltipPanel id={tooltipId} controller={tip} maxWidth={maxWidth}>
                    {content}
                </TooltipPanel>
            )}
        </span>
    );
}

/* ------------------------------------------------------------------------- */

/** Call the child's own handler for an event Tip also listens to, if it has one. */
function callHandler(handler: unknown, event: unknown): void {
    if (typeof handler === 'function') (handler as (e: unknown) => void)(event);
}

/**
 * Forward an element to whatever ref the cloned child already had.
 *
 * Module-level on purpose: writing `ref.current` inside `Tip` reads to the
 * `react-hooks/immutability` lint rule as mutating a value reached through the
 * `children` prop. It is not — a ref object exists to be written — but the
 * rule cannot see that through the alias, and taking the ref as a plain
 * parameter is both the fix and the clearer statement of intent.
 */
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
 * `Tip` therefore renders **no element of its own** for an enabled child. It
 * clones the child and merges in the hover/focus/tap handlers plus
 * `aria-describedby`, so the DOM shape, the CSS selectors, the table structure
 * and the tab order all stay exactly what they were. What changes is that the
 * hint now opens on keyboard focus and on tap as well as hover, is styled, and
 * is a real `role="tooltip"` wired to its trigger.
 *
 * Two cases the clone alone cannot handle:
 *
 *  - **Disabled children.** Browsers fire no pointer events on a disabled
 *    control, so handlers merged onto one are dead on arrival — and that is
 *    most of the read-only hints. Native `title=` *did* still render on a
 *    disabled control, so replacing it with a description node alone silently
 *    took the hint away from every sighted user. For a disabled child `Tip`
 *    therefore renders one `inline-flex` wrapper `<span>` (focusable, and
 *    keeping pointer events, which the disabled child itself does not) that
 *    opens the same visible panel, *and* keeps the permanently mounted
 *    description wired to the child through `aria-describedby`.
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
    const tip = useTooltipPanel({ showDelay, hideDelay });
    const { open, anchorRef } = tip;

    if (content === null || content === undefined || content === false || content === '') {
        return children;
    }

    const childProps = (children.props ?? {}) as Record<string, unknown> & {
        ref?: Ref<HTMLElement>;
        disabled?: boolean;
        'aria-describedby'?: string;
    };
    const isDisabled = childProps.disabled === true;
    // A disabled control fires no pointer events, so the hidden description
    // stays mounted for it; otherwise describe the child only while open.
    const describe = describedBy && (isDisabled || open);
    const describedByValue = describe
        ? [childProps['aria-describedby'], tooltipId].filter(Boolean).join(' ')
        : childProps['aria-describedby'];

    if (isDisabled) {
        // The wrapper is the anchor AND the event target: pointer and focus
        // events on the disabled child never fire, but they do fire on a
        // sibling wrapper that still has pointer-events. `inline-flex` keeps
        // it out of the layout's way in the flex/grid rows these buttons live in.
        return (
            <>
                <span
                    ref={anchorRef as RefObject<HTMLSpanElement | null>}
                    className="inline-flex"
                    tabIndex={0}
                    aria-describedby={describedBy ? tooltipId : undefined}
                    onMouseEnter={tip.scheduleShow}
                    onMouseLeave={tip.scheduleHide}
                    onFocus={tip.show}
                    onBlur={tip.hide}
                    onClick={(e) => {
                        // Nothing underneath to activate — the child is disabled —
                        // so a tap only pins the hint.
                        e.preventDefault();
                        e.stopPropagation();
                        tip.togglePinned();
                    }}
                >
                    {cloneElement(children, {
                        'aria-describedby': describedByValue,
                    } as Record<string, unknown>)}
                </span>
                {open ? (
                    <TooltipPanel id={tooltipId} controller={tip} maxWidth={maxWidth}>
                        {content}
                    </TooltipPanel>
                ) : (
                    describedBy &&
                    typeof document !== 'undefined' &&
                    createPortal(
                        <div id={tooltipId} className="sr-only">
                            {content}
                        </div>,
                        document.body,
                    )
                )}
            </>
        );
    }

    const existingRef = childProps.ref ?? (children as { ref?: Ref<HTMLElement> }).ref;
    const setRef = (element: HTMLElement | null) => {
        anchorRef.current = element;
        assignRef(existingRef, element);
    };

    // react-hooks/refs reads "a ref in a props object during render" as reading
    // a ref's value during render. Here `setRef` is a ref CALLBACK being handed
    // to React to invoke after commit — the one legal way to attach to a child
    // you did not create. Nothing reads `.current` here.
    // eslint-disable-next-line react-hooks/refs
    const cloned = cloneElement(children, {
        ref: setRef,
        'aria-describedby': describedByValue,
        // The child's own handler still runs — Tip is additive, never a
        // replacement for what the call site already wired up.
        onMouseEnter: (e: unknown) => {
            tip.scheduleShow();
            callHandler(childProps.onMouseEnter, e);
        },
        onMouseLeave: (e: unknown) => {
            tip.scheduleHide();
            callHandler(childProps.onMouseLeave, e);
        },
        onFocus: (e: unknown) => {
            tip.show();
            callHandler(childProps.onFocus, e);
        },
        onBlur: (e: unknown) => {
            tip.hide();
            callHandler(childProps.onBlur, e);
        },
        // Tap pins the hint open, exactly as it does on a `Tooltip` trigger —
        // touch has no pointer-out to dismiss with. Unlike `Tooltip` the event
        // is NOT cancelled: the child here is the app's own control and its
        // click is the action the user asked for.
        onClick: (e: unknown) => {
            tip.togglePinned();
            callHandler(childProps.onClick, e);
        },
    } as Record<string, unknown>);

    return (
        <>
            {cloned}
            {open && (
                <TooltipPanel id={tooltipId} controller={tip} maxWidth={maxWidth}>
                    {content}
                </TooltipPanel>
            )}
        </>
    );
}
