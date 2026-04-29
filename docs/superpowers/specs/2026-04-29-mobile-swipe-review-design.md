# Mobile Swipe-to-Review for AccountLedger

**Status:** Approved (design)
**Date:** 2026-04-29
**Owner:** Justin

## Problem

Reviewing imported transactions on mobile is friction-heavy. The existing
flow requires tapping a card to open the detail modal, then tapping a
"Mark reviewed" control. For users triaging dozens of imported items, this
is several taps per transaction. Outlook, Gmail, and similar apps solve
this with a single right-swipe gesture.

## Goal

On mobile (`< sm:` breakpoint) inside `AccountLedger`, a right-swipe on a
transaction card marks it reviewed in one gesture. While dragging, an
emerald action panel reveals from beneath the left edge of the card with a
checkmark and "Review" label, signaling what release will commit.

## Non-goals

- Left-swipe is unassigned in this iteration. The wrapper ignores
  negative `dx` (clamps `translateX` at 0). A future spec can add a
  left-swipe action without changing the right-swipe contract.
- No swipe on already-reviewed cards. The wrapper passes children through
  as a plain `<div>` when `disabled=true`, so already-reviewed cards keep
  their tap-to-open behavior with zero gesture overhead.
- No swipe in `TransactionJournal`. That table doesn't have a mobile-card
  variant yet; adding one is out of scope here.
- No new keyboard equivalent. The detail-modal review action already
  covers keyboard/desktop users.

## "Review" semantics

Swipe-right is **mark-only**: it sets `reviewed=true` on items that are
currently unreviewed. The existing `PATCH /api/transactions/{guid}/review`
endpoint toggles the flag, but because the wrapper is `disabled` on
already-reviewed cards, the only state transition the swipe ever produces
is `false → true`. This matches the Gmail/Outlook archive metaphor and
prevents "swipe twice and silently un-review" mistakes.

## Edge-to-edge cards on mobile

Today the cards have `border border-border rounded-xl p-3` and inherit
horizontal padding from the parent list container. On mobile only:

- Drop `rounded-xl`.
- Drop the left and right `border`.
- Keep a single bottom border (`border-b border-border/30`) for visual
  separation between successive cards.
- Remove the parent list's horizontal padding so cards span 100% of the
  viewport width.

Desktop styles are unchanged.

## Component

**File:** `src/components/ledger/SwipeableTransactionCard.tsx`

**Props:**

```ts
interface Props {
  disabled: boolean;     // pass true for already-reviewed cards
  onCommit: () => void;  // fires once per committed swipe
  children: React.ReactNode;
  className?: string;    // forwarded to the outer wrapper
}
```

**Render structure (when not disabled):**

```tsx
<div className="relative overflow-hidden">
  {/* action panel — anchored to the left, revealed as card slides right */}
  <div
    className="absolute inset-y-0 left-0 flex items-center px-6 bg-emerald-600 text-white"
    style={{ width: '100%', opacity: panelOpacity }}
    aria-hidden="true"
  >
    <CheckIcon className="w-5 h-5 mr-2" />
    <span className="text-sm font-medium">Review</span>
  </div>

  {/* the actual card content, translated by the drag */}
  <div
    onTouchStart={onStart}
    onTouchMove={onMove}
    onTouchEnd={onEnd}
    onTouchCancel={onEnd}
    onClickCapture={suppressClickIfSwiped}
    style={{
      transform: `translateX(${dx}px)`,
      transition: isDragging ? 'none' : 'transform 200ms ease-out',
      touchAction: 'pan-y', // let vertical scroll proceed; we manage horizontal
    }}
  >
    {children}
  </div>
</div>
```

**Render structure (when disabled):**

Just `<div className={className}>{children}</div>` — no wrapper overhead,
no listeners, no transform.

### Gesture state machine

Tracked via component-local refs (no React state for the per-frame drag —
we set `transform` directly on the DOM node via a ref to avoid render
storms). One `useState` is used for `dx` to drive opacity (or use
`requestAnimationFrame` and a ref-only model — implementer's call as
long as it stays smooth on a budget mobile device).

```
state: idle
  touchstart → record startX, startY, mark "axis = unknown"
  state: pending

state: pending
  touchmove
    if axis == "unknown":
      if |dy| > |dx| && |dy| > 10  → axis = "vertical", state: cancelled
                                     (defer to scroll, do nothing further)
      if |dx| > |dy| && |dx| > 10  → axis = "horizontal"
                                     state: dragging
                                     wasSwipe = true
    if axis == "horizontal":
      dx = max(0, currentX - startX)  // right-only
      dx = min(dx, cardWidth)          // cap at full width
      panelOpacity = min(1, dx / threshold)
      preventDefault to keep the page from scrolling

state: dragging
  touchend
    if dx >= threshold:
      animate translateX(cardWidth) over 200ms
      call onCommit()
      reset dx → 0 (no animation; element snaps back behind whatever
        re-render onCommit triggers — typically the card disappears
        from the unreviewed-only filter, otherwise stays in place)
    else:
      animate translateX(0) over 200ms (snap back)
    state: idle
  touchcancel: same as touchend with dx < threshold (snap back)

state: cancelled
  touchend / touchcancel → state: idle, no further action
```

**Threshold:** `threshold = 0.30 * cardWidth`. Measured once per gesture
from the wrapper's `getBoundingClientRect().width`.

**Swipe vs. tap disambiguation:** the inner card already has an `onClick`
that opens the detail modal. The wrapper sets a `wasSwipe` ref to `true`
once `axis === 'horizontal'` and `|dx| > 8`. In an `onClickCapture`
listener, if `wasSwipe.current` is `true`, call `e.stopPropagation()` and
`e.preventDefault()` and reset the flag. Otherwise let the click through
unchanged.

**Vertical-scroll friendliness:** `touchAction: 'pan-y'` on the inner
draggable lets the browser handle vertical scroll natively. We only
`preventDefault` on `touchmove` once we've locked to the horizontal axis.

## Integration in AccountLedger

The mobile branch in `src/components/AccountLedger.tsx` has two card
variants: investment (~line 1827) and regular (further down). Wrap both:

```tsx
const isUnreviewed = tx.reviewed === false;

return (
  <SwipeableTransactionCard
    key={tx.guid}
    disabled={!isUnreviewed}
    onCommit={() => toggleReviewed(tx.guid)}
    className={isInvestmentAccount && invRow ? 'investment-mobile-card' : 'regular-mobile-card'}
  >
    {/* existing card JSX, unchanged except the className adjustments below */}
  </SwipeableTransactionCard>
);
```

The `key={tx.guid}` lifts to the wrapper (it was on the inner `div`
before).

### Card className adjustments

The inner card currently uses
`bg-surface/30 backdrop-blur border border-border rounded-xl p-3 space-y-2`
plus `border-l-2 border-l-amber-500` on unreviewed items. The mobile
behavior we want is edge-to-edge with no horizontal padding gaps — but
we still want the amber left border to flag unreviewed cards.

New className recipe (apply to both card variants):

```
bg-surface/30 backdrop-blur p-3 space-y-2
border-b border-border/30
sm:border sm:border-border sm:rounded-xl sm:border-b-border
${isUnreviewed ? 'border-l-2 border-l-amber-500' : ''}
```

Effect:
- Mobile: a hair-line bottom border between cards, no rounded corners,
  no top/right border. The 2px amber strip on the left edge stays for
  unreviewed cards (visually anchors them, doesn't break edge-to-edge).
- Desktop (`sm:` and up): the card is fully bordered and rounded as
  before. The `sm:border-b-border` line restores the bottom border to
  full opacity at the desktop breakpoint.

### Parent list padding

Find the list container that wraps the mobile branch and ensure it has
`px-0 sm:px-4` (or whatever its current desktop padding is). Today the
ledger root has padding that flows into the mobile branch — verify and
adjust.

## Accessibility & UX details

- `aria-hidden="true"` on the action panel — it's a visual cue for an
  in-progress gesture; the underlying state change is announced by
  whatever feedback `toggleReviewed` already produces (the amber border
  disappears + the card may filter out under "Show unreviewed only").
- The detail modal still opens on tap (no behavioral regression for
  users who don't swipe).
- No new keyboard binding. Out of scope for a mobile-only gesture
  feature.

## State update on commit

`onCommit={() => toggleReviewed(tx.guid)}` reuses the existing function
at `AccountLedger.tsx:745`. It is **not** optimistic today — it awaits
the PATCH response and only then updates local state.

For this iteration we accept that behavior: the visual snap-back has
already finished by the time the PATCH returns (200ms vs typical
~50–100ms network), so the user sees the amber border disappear (or the
card filter out under "show unreviewed only") a hair after the gesture.
If a real perceived-lag problem emerges on slow networks, a follow-up
can convert `toggleReviewed` to optimistic — out of scope here.

On PATCH failure the existing handler logs and toasts; the local state
correctly remains `reviewed=false`, so the user can swipe again.

## Testing

**Unit (`SwipeableTransactionCard.test.tsx`)**:

- Simulated touch sequence from `dx=0` past threshold and release:
  expect `onCommit` fires exactly once.
- Touch sequence under threshold and release: expect `onCommit` does
  not fire.
- `disabled=true` renders children inside a plain `<div>`; no listeners
  attached (verify by querying DOM and checking that touchstart on the
  child doesn't translate anything).
- Vertical-first movement (dy > dx in first 10px) cancels the gesture:
  expect no transform applied to inner element on subsequent moves.
- Click after a swipe (`|dx| > 8` during touch) is suppressed:
  click handler on a child does not fire.
- Click without swipe (touchstart → touchend with no movement) lets the
  child click handler fire.

**Manual**:

- Real device test (iOS Safari + Android Chrome): swipe feels smooth at
  60 fps, no scroll fights, no accidental reviews.
- `showUnreviewedOnly = true`: swiping commits and the card filters out
  on the next render.
- `showUnreviewedOnly = false`: swiping commits and the amber left
  border disappears; the card stays in place.
- Already-reviewed card: swipe does nothing, tap still opens the detail
  modal.
- Edge-to-edge cards span the full viewport width with no horizontal
  scrollbar.

## Files touched

- `src/components/ledger/SwipeableTransactionCard.tsx` — new wrapper component.
- `src/components/__tests__/SwipeableTransactionCard.test.tsx` — new tests.
- `src/components/AccountLedger.tsx` — wrap both mobile card variants
  in `SwipeableTransactionCard`; adjust classNames for edge-to-edge
  layout on mobile; adjust the parent list container's mobile padding.
