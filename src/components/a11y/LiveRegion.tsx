'use client';

import { useEffect, useState } from 'react';

/**
 * An always-mounted live region for failed actions and status changes.
 *
 * A `role="alert"` / `role="status"` node only announces when its *contents*
 * change while it is already in the accessibility tree. Mounting the node
 * together with the message — the familiar
 * `{error && <div role="alert">{error}</div>}` — races the screen reader, and
 * the first failure is the one most likely to be swallowed. That is exactly the
 * announcement that matters.
 *
 * Two things are therefore true of this component, and both are load-bearing.
 *
 * **It renders inline, in the caller's subtree.** An earlier revision portalled
 * into `document.body` to keep an empty child out of the caller's `space-y-*`
 * stack. That silently broke every modal: `Modal` (src/components/ui/Modal.tsx)
 * sets `aria-modal="true"` on the dialog, which tells assistive technology to
 * ignore *everything outside* that dialog. A region parked on `document.body`
 * is outside it, so on BookEditorModal, ProvenanceModal,
 * TransactionDrilldownModal, BatchEditModal, EstimateModal and SaveReportDialog
 * the announcement was made into a part of the tree nothing was listening to.
 * Rendering inline is what puts the region back inside the dialog.
 *
 * The layout cost of rendering inline is real and accepted, not zero. The
 * region is `sr-only`, hence `position: absolute`, so it is out of flow and
 * adds no height of its own. But Tailwind v4 implements `space-y-*` as
 * `:where(& > :not(:last-child)) { margin-block-end: … }`, and an `sr-only`
 * child *is* selected by that — so where this region lands as the final child
 * of a `space-y-*` stack, the element before it stops being `:last-child` and
 * gains one gap of bottom margin it did not have.
 *
 * Across the 23 call sites that is true of exactly one: ChartSettingsPanel,
 * where the region follows the "Save Defaults" button at the end of a
 * `space-y-4` stack, so that button now carries 16px of bottom margin and the
 * popover ends 16px taller. That is a deliberate, accepted change, not an
 * invisible one. Everywhere else the region has a following sibling, stays a
 * non-last child, and — being out of flow — costs nothing.
 *
 * **It publishes the message one commit after it mounts.** Placement alone is
 * not enough when the region mounts with text already in hand — a login page
 * rendered with an OIDC failure in its props, or a wizard step remounted while
 * an error from the previous attempt is still in state. In both cases the node
 * and its text enter the tree together, which is the very bug the region exists
 * to prevent. Holding the text until a post-mount effect guarantees the node is
 * in the accessibility tree, empty, before the text arrives as a mutation.
 *
 * The honest limit: this separates the two DOM operations by a commit, not by a
 * wall-clock delay. That is what makes the behaviour synchronously testable,
 * and it is the same shape as an error arriving from a fetch a moment later —
 * but an assistive technology that coalesces mutations within a single frame
 * could still treat the two as one. Mounting the region with the surface, as
 * every caller does, is what keeps that case rare.
 *
 * Consequently the visible error surface carries no `role` of its own: the
 * region is what speaks, and doubling the role would announce twice.
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
    const text = message || '';

    // Never render `text` on the mounting commit; see the note above.
    const [announced, setAnnounced] = useState('');
    useEffect(() => {
        setAnnounced(text);
    }, [text]);

    return (
        <div
            role={politeness === 'assertive' ? 'alert' : 'status'}
            aria-live={politeness}
            aria-atomic="true"
            className="sr-only"
        >
            {announced}
        </div>
    );
}
