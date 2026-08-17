'use client';

import { createPortal } from 'react-dom';

/**
 * An always-mounted live region for failed actions and status changes.
 *
 * A `role="alert"` / `role="status"` node only announces when its *contents*
 * change while it is already in the accessibility tree. Mounting the node
 * together with the message — the familiar
 * `{error && <div role="alert">{error}</div>}` — races the screen reader, and
 * the first failure is the one most likely to be swallowed. That is exactly the
 * announcement that matters, so the region is mounted for as long as the
 * surface that can fail, and only its text changes.
 *
 * It renders through a portal into `document.body` instead of inline. An
 * always-present sibling inside a `space-y-*` stack pushes everything after it
 * down by one gap even while empty, and DESIGN.md's spacing scale is not ours
 * to bend for a screen-reader affordance. The portal is visually inert
 * (`sr-only`), so the visible error surface keeps its exact styling and remains
 * the only thing a sighted user sees.
 *
 * Consequently the visible surface carries no `role` of its own: the region
 * below is what speaks, and doubling the role would announce twice.
 */
export function ErrorLiveRegion({
    message,
    politeness = 'assertive',
}: {
    /** Text to announce. Anything falsy leaves the region mounted but empty. */
    message?: string | null | false;
    /**
     * `assertive` (default) interrupts — correct for an action the user just
     * took that failed. `polite` waits for a pause — correct for status that
     * must not cut across what the user is doing.
     */
    politeness?: 'assertive' | 'polite';
}) {
    if (typeof document === 'undefined') return null;

    return createPortal(
        <div
            role={politeness === 'assertive' ? 'alert' : 'status'}
            aria-live={politeness}
            aria-atomic="true"
            className="sr-only"
        >
            {message || ''}
        </div>,
        document.body
    );
}
