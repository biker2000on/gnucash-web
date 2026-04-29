# Mobile Swipe-to-Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-swipe-to-review gesture on mobile transaction cards in `AccountLedger`, with edge-to-edge cards and an emerald "Review" action panel that bleeds in from beneath the left edge as the card slides right.

**Architecture:** A standalone `SwipeableTransactionCard` wrapper handles the gesture mechanics (touch events, axis lock, threshold, snap animation, tap-vs-swipe disambiguation). When `disabled=true` (already-reviewed cards) the wrapper renders children inside a plain `<div>` with no listeners. Integration in `AccountLedger` wraps both mobile card variants (investment + regular) and adjusts classNames so cards are edge-to-edge on mobile.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Vitest + jsdom, @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-04-29-mobile-swipe-review-design.md`

---

## File Structure

**New files:**
- `src/components/ledger/SwipeableTransactionCard.tsx` — wrapper component. Owns gesture state, threshold logic, snap animation, click suppression.
- `src/components/__tests__/SwipeableTransactionCard.test.tsx` — unit tests using `@testing-library/react`'s `fireEvent.touchStart` / `touchMove` / `touchEnd`.

**Modified files:**
- `src/components/AccountLedger.tsx` — wrap both mobile card variants (investment branch ~line 1828, regular branch ~line 1923) in `SwipeableTransactionCard`; adjust the investment-card className for edge-to-edge mobile layout. The regular card uses `MobileCard`, which is already edge-to-edge — no change needed there beyond the wrapper.

---

## Task 1: Build SwipeableTransactionCard (TDD)

**Files:**
- Create: `src/components/ledger/SwipeableTransactionCard.tsx`
- Test: `src/components/__tests__/SwipeableTransactionCard.test.tsx`

This task ships the wrapper and its full test suite. Task 2 only wires it into `AccountLedger`.

- [ ] **Step 1: Write the failing test file**

Create `src/components/__tests__/SwipeableTransactionCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { SwipeableTransactionCard } from '../ledger/SwipeableTransactionCard';

// jsdom doesn't lay out boxes; getBoundingClientRect returns 0 widths by default.
// Force a non-zero width so the threshold math is meaningful in tests.
beforeEach(() => {
  Element.prototype.getBoundingClientRect = vi.fn(function () {
    return {
      width: 300,
      height: 80,
      top: 0,
      left: 0,
      right: 300,
      bottom: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

function touch(clientX: number, clientY = 0) {
  return { touches: [{ clientX, clientY }] as unknown as TouchList };
}
function endTouch(clientX: number, clientY = 0) {
  return { changedTouches: [{ clientX, clientY }] as unknown as TouchList };
}

describe('SwipeableTransactionCard', () => {
  it('fires onCommit once when the user swipes past the 30% threshold', () => {
    const onCommit = vi.fn();
    render(
      <SwipeableTransactionCard disabled={false} onCommit={onCommit}>
        <div data-testid="child">card content</div>
      </SwipeableTransactionCard>,
    );
    const draggable = screen.getByTestId('child').parentElement!;

    // start at x=0, drag right by 120px (40% of 300 — past 30% threshold)
    fireEvent.touchStart(draggable, touch(0, 0));
    fireEvent.touchMove(draggable, touch(15, 0));   // crosses axis-lock + 8px swipe flag
    fireEvent.touchMove(draggable, touch(120, 0));  // past threshold
    fireEvent.touchEnd(draggable, endTouch(120, 0));

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('does not fire onCommit when released below the threshold', () => {
    const onCommit = vi.fn();
    render(
      <SwipeableTransactionCard disabled={false} onCommit={onCommit}>
        <div data-testid="child">card content</div>
      </SwipeableTransactionCard>,
    );
    const draggable = screen.getByTestId('child').parentElement!;

    fireEvent.touchStart(draggable, touch(0, 0));
    fireEvent.touchMove(draggable, touch(15, 0));
    fireEvent.touchMove(draggable, touch(60, 0));   // 20% of 300, under threshold
    fireEvent.touchEnd(draggable, endTouch(60, 0));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('renders children in a plain div (no listeners) when disabled', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    const { container } = render(
      <SwipeableTransactionCard disabled={true} onCommit={onCommit}>
        <div onClick={onClick} data-testid="child">card</div>
      </SwipeableTransactionCard>,
    );

    // No "absolute" action panel sibling should exist when disabled.
    expect(container.querySelector('.absolute')).toBeNull();

    // Click on the child should propagate normally.
    fireEvent.click(screen.getByTestId('child'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('cancels the gesture and does not commit when the user scrolls vertically first', () => {
    const onCommit = vi.fn();
    render(
      <SwipeableTransactionCard disabled={false} onCommit={onCommit}>
        <div data-testid="child">card</div>
      </SwipeableTransactionCard>,
    );
    const draggable = screen.getByTestId('child').parentElement!;

    fireEvent.touchStart(draggable, touch(0, 0));
    // First decisive movement is vertical — gesture should lock to vertical and ignore further horizontal.
    fireEvent.touchMove(draggable, touch(0, 20));
    fireEvent.touchMove(draggable, touch(150, 20));   // would-be-past-threshold horizontal
    fireEvent.touchEnd(draggable, endTouch(150, 20));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('ignores left-swipe (negative dx)', () => {
    const onCommit = vi.fn();
    render(
      <SwipeableTransactionCard disabled={false} onCommit={onCommit}>
        <div data-testid="child">card</div>
      </SwipeableTransactionCard>,
    );
    const draggable = screen.getByTestId('child').parentElement!;

    fireEvent.touchStart(draggable, touch(200, 0));
    fireEvent.touchMove(draggable, touch(180, 0));   // moving left
    fireEvent.touchMove(draggable, touch(50, 0));    // far left
    fireEvent.touchEnd(draggable, endTouch(50, 0));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('suppresses click after a swipe (any horizontal movement > 8px)', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    render(
      <SwipeableTransactionCard disabled={false} onCommit={onCommit}>
        <div onClick={onClick} data-testid="child">card</div>
      </SwipeableTransactionCard>,
    );
    const draggable = screen.getByTestId('child').parentElement!;

    fireEvent.touchStart(draggable, touch(0, 0));
    fireEvent.touchMove(draggable, touch(20, 0));   // crosses 8px swipe flag
    fireEvent.touchEnd(draggable, endTouch(20, 0)); // below threshold — snap back

    // The browser would synthesize a click after touchend. Simulate it.
    fireEvent.click(screen.getByTestId('child'));

    expect(onCommit).not.toHaveBeenCalled();   // didn't pass threshold
    expect(onClick).not.toHaveBeenCalled();    // click was suppressed because the touch was a swipe
  });

  it('lets a tap (no horizontal movement) propagate to the child onClick', () => {
    const onCommit = vi.fn();
    const onClick = vi.fn();
    render(
      <SwipeableTransactionCard disabled={false} onCommit={onCommit}>
        <div onClick={onClick} data-testid="child">card</div>
      </SwipeableTransactionCard>,
    );
    const draggable = screen.getByTestId('child').parentElement!;

    fireEvent.touchStart(draggable, touch(0, 0));
    fireEvent.touchEnd(draggable, endTouch(0, 0));
    fireEvent.click(screen.getByTestId('child'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/SwipeableTransactionCard.test.tsx`
Expected: FAIL with "Cannot find module '../ledger/SwipeableTransactionCard'".

- [ ] **Step 3: Implement SwipeableTransactionCard**

Create `src/components/ledger/SwipeableTransactionCard.tsx`:

```tsx
'use client';

import { ReactNode, TouchEvent, useRef, useState } from 'react';

interface Props {
    disabled: boolean;
    onCommit: () => void;
    children: ReactNode;
    className?: string;
}

const COMMIT_THRESHOLD_RATIO = 0.30; // 30% of card width
const AXIS_LOCK_PX = 10;             // movement at which we decide horizontal vs vertical
const SWIPE_FLAG_PX = 8;             // horizontal distance that flips wasSwipe ref

type Axis = 'unknown' | 'horizontal' | 'vertical';

export function SwipeableTransactionCard({ disabled, onCommit, children, className = '' }: Props) {
    const [dx, setDx] = useState(0);
    const [isDragging, setIsDragging] = useState(false);

    // Refs for mutable state we don't want to drive renders on every move.
    const startXRef = useRef(0);
    const startYRef = useRef(0);
    const axisRef = useRef<Axis>('unknown');
    const wasSwipeRef = useRef(false);
    const cardWidthRef = useRef(0);
    const containerRef = useRef<HTMLDivElement | null>(null);

    if (disabled) {
        return <div className={className}>{children}</div>;
    }

    const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
        const t = e.touches[0];
        startXRef.current = t.clientX;
        startYRef.current = t.clientY;
        axisRef.current = 'unknown';
        wasSwipeRef.current = false;
        cardWidthRef.current = containerRef.current?.getBoundingClientRect().width ?? 0;
        setDx(0);
        setIsDragging(true);
    };

    const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
        const t = e.touches[0];
        const rawDx = t.clientX - startXRef.current;
        const rawDy = t.clientY - startYRef.current;

        if (axisRef.current === 'unknown') {
            const absDx = Math.abs(rawDx);
            const absDy = Math.abs(rawDy);
            if (absDx > AXIS_LOCK_PX && absDx > absDy) {
                axisRef.current = 'horizontal';
            } else if (absDy > AXIS_LOCK_PX && absDy > absDx) {
                axisRef.current = 'vertical';
                return;
            } else {
                return;
            }
        }

        if (axisRef.current === 'vertical') return;

        // Right-only, capped at card width.
        const capped = Math.max(0, Math.min(rawDx, cardWidthRef.current));
        if (capped > SWIPE_FLAG_PX) wasSwipeRef.current = true;
        setDx(capped);
    };

    const onTouchEnd = () => {
        const width = cardWidthRef.current;
        const threshold = width * COMMIT_THRESHOLD_RATIO;
        if (axisRef.current === 'horizontal' && dx >= threshold && threshold > 0) {
            onCommit();
        }
        setDx(0);
        setIsDragging(false);
    };

    const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
        if (wasSwipeRef.current) {
            e.stopPropagation();
            e.preventDefault();
            wasSwipeRef.current = false;
        }
    };

    const threshold = cardWidthRef.current * COMMIT_THRESHOLD_RATIO;
    const panelOpacity = threshold > 0 ? Math.min(1, dx / threshold) : 0;

    return (
        <div ref={containerRef} className={`relative overflow-hidden ${className}`}>
            <div
                className="absolute inset-y-0 left-0 flex items-center px-6 bg-emerald-600 text-white pointer-events-none"
                style={{ width: '100%', opacity: panelOpacity }}
                aria-hidden="true"
            >
                <svg className="w-5 h-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.42 0z" clipRule="evenodd" />
                </svg>
                <span className="text-sm font-medium">Review</span>
            </div>
            <div
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onTouchCancel={onTouchEnd}
                onClickCapture={onClickCapture}
                style={{
                    transform: `translateX(${dx}px)`,
                    transition: isDragging ? 'none' : 'transform 200ms ease-out',
                    touchAction: 'pan-y',
                }}
            >
                {children}
            </div>
        </div>
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/__tests__/SwipeableTransactionCard.test.tsx`
Expected: All 7 tests PASS.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors related to the new file.

- [ ] **Step 6: Run the lint on changed files**

Run: `npx eslint src/components/ledger/SwipeableTransactionCard.tsx src/components/__tests__/SwipeableTransactionCard.test.tsx`
Expected: no errors. (Warnings about pre-existing rules in unrelated files are not output here.)

- [ ] **Step 7: Commit**

```bash
git add src/components/ledger/SwipeableTransactionCard.tsx src/components/__tests__/SwipeableTransactionCard.test.tsx
git commit -m "feat(ledger): add SwipeableTransactionCard wrapper with right-swipe gesture"
```

---

## Task 2: Wire into AccountLedger and adjust card classNames

**Depends on:** Task 1.

**Files:**
- Modify: `src/components/AccountLedger.tsx`

This task has three edits inside `AccountLedger.tsx`: import the wrapper, wrap the investment-card variant, wrap the regular-card variant. The regular variant uses `MobileCard` which is already edge-to-edge; the only adjustment needed there is the wrapper. The investment variant has its own bordered/rounded styling that needs to become edge-to-edge on mobile.

- [ ] **Step 1: Add the import**

Edit `src/components/AccountLedger.tsx`. Find the existing imports near the top of the file (around line 1–60). After the line:

```ts
import { useIsMobile } from '@/lib/hooks/useIsMobile';
```

add:

```ts
import { SwipeableTransactionCard } from '@/components/ledger/SwipeableTransactionCard';
```

- [ ] **Step 2: Wrap the investment card variant and update its className**

The investment card is rendered around line 1828 in `AccountLedger.tsx`:

```tsx
return isInvestmentAccount && invRow ? (
    <div key={tx.guid} className={`bg-surface/30 backdrop-blur border border-border rounded-xl p-3 space-y-2 ${isUnreviewed ? 'border-l-2 border-l-amber-500' : ''}`} onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}>
```

Replace that opening `<div>` with the swipe wrapper around it, and change the inner `<div>`'s className so the side borders/rounded corners only apply at `sm:` breakpoint and above:

```tsx
return isInvestmentAccount && invRow ? (
    <SwipeableTransactionCard
        key={tx.guid}
        disabled={!isUnreviewed}
        onCommit={() => toggleReviewed(tx.guid)}
    >
        <div className={`bg-surface/30 backdrop-blur p-3 space-y-2 border-b border-border/30 sm:border sm:border-border sm:rounded-xl ${isUnreviewed ? 'border-l-2 border-l-amber-500' : ''}`} onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}>
```

The matching closing `</div>` for this card lives a few dozen lines below (search for the next `</div>` followed by `) : (` to find the boundary between the investment branch and the regular branch). Add a closing `</SwipeableTransactionCard>` after that `</div>`. Concretely, find the block that looks like this:

```tsx
                                </div>
                            </div>
                        ) : (
                            <MobileCard
```

and change it to:

```tsx
                                </div>
                            </div>
                        </SwipeableTransactionCard>
                        ) : (
                            <MobileCard
```

(The `key` prop has moved up to the `SwipeableTransactionCard`. Remove `key={tx.guid}` from the inner `<div>` — it's no longer the outermost element.)

- [ ] **Step 3: Wrap the regular card variant**

The regular card is rendered around line 1923:

```tsx
                        ) : (
                            <MobileCard
                                key={tx.guid}
                                onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}
                                className={isUnreviewed ? 'border-l-2 border-l-amber-500' : ''}
                                fields={[
                                    /* … */
                                ]}
                            />
                        );
                    })}
```

Wrap the `<MobileCard>` in `SwipeableTransactionCard`. The `key` lifts to the wrapper:

```tsx
                        ) : (
                            <SwipeableTransactionCard
                                key={tx.guid}
                                disabled={!isUnreviewed}
                                onCommit={() => toggleReviewed(tx.guid)}
                            >
                                <MobileCard
                                    onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}
                                    className={isUnreviewed ? 'border-l-2 border-l-amber-500' : ''}
                                    fields={[
                                        /* … unchanged … */
                                    ]}
                                />
                            </SwipeableTransactionCard>
                        );
                    })}
```

(Do NOT modify the `fields={[...]}` content. Only restructure the wrapper. Remove `key={tx.guid}` from the `<MobileCard>` since the wrapper owns the key now.)

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (Pre-existing errors in unrelated files like `financial-summary.service.test.ts` are not introduced by this task.)

- [ ] **Step 5: Run the existing test suite**

Run: `npx vitest run src/components/__tests__/SwipeableTransactionCard.test.tsx`
Expected: all 7 tests still PASS (sanity check that Task 1 still works after rebases).

- [ ] **Step 6: Run the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Manual smoke test**

Start the dev server: `npm run dev`. Open the app on a mobile device or in DevTools mobile emulation (iPhone SE width works well for verifying edge-to-edge). Navigate to an account with at least one unreviewed transaction.

1. Tap an unreviewed card → detail modal opens (tap-vs-swipe still routes correctly).
2. Swipe an unreviewed card right slowly → emerald "Review" panel fades in from the left, card translates with the finger.
3. Release before 30% → card snaps back, no PATCH, no state change.
4. Swipe past 30% and release → `toggleReviewed` fires, the amber left border disappears (or the card filters out under "show unreviewed only").
5. Swipe an already-reviewed card → no transform, no panel; tap still opens the modal.
6. Try a vertical swipe (scroll) on a card → page scrolls normally, no horizontal translation.
7. Verify cards are edge-to-edge: no rounded corners, no left/right border on mobile widths. At `sm:` and above (≥640px) the cards have their original bordered/rounded look.
8. Investment account ledger: same gestures work on the investment card variant.

If any UI regression doesn't match `DESIGN.md`, report it.

- [ ] **Step 8: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat(ledger): wire mobile cards into SwipeableTransactionCard with edge-to-edge layout"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers the wrapper with disabled-passthrough, axis lock, threshold commit, snap-back, click suppression, and right-only clamp — every behavior in the spec's gesture state machine. Task 2 covers integration in both card variants and the edge-to-edge mobile classNames. The amber left border for unreviewed cards is preserved on mobile.
- **No placeholders:** every test body and every implementation snippet is complete. No "implement later" or "similar to above" — the regular-card and investment-card variants each get a fully-shown edit.
- **Type consistency:** the `Props` interface in Task 1 matches the props used in Task 2 (`disabled`, `onCommit`, `children`, `className`). `toggleReviewed` is the existing function at `AccountLedger.tsx:745` — its signature is `(guid: string) => Promise<void>`, called as `() => toggleReviewed(tx.guid)`.
- **Reuse:** no new API endpoint, no schema changes, no new dependencies. Reuses the existing `PATCH /api/transactions/{guid}/review` and the existing `toggleReviewed` callback.
