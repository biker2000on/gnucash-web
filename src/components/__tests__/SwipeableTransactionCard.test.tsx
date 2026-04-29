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

    fireEvent.touchStart(draggable, touch(0, 0));
    fireEvent.touchMove(draggable, touch(15, 0));
    fireEvent.touchMove(draggable, touch(120, 0));
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
    fireEvent.touchMove(draggable, touch(60, 0));
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

    expect(container.querySelector('.absolute')).toBeNull();

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
    fireEvent.touchMove(draggable, touch(0, 20));
    fireEvent.touchMove(draggable, touch(150, 20));
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
    fireEvent.touchMove(draggable, touch(180, 0));
    fireEvent.touchMove(draggable, touch(50, 0));
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
    fireEvent.touchMove(draggable, touch(20, 0));
    fireEvent.touchEnd(draggable, endTouch(20, 0));

    fireEvent.click(screen.getByTestId('child'));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
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
