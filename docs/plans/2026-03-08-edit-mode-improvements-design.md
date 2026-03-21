# Ledger Edit Mode Improvements

## Fix 1: Account field text selection on focus

**Problem**: When a row becomes active (via click or arrow keys), the account field's `select()` call doesn't work — cursor ends up at the end of text instead of selecting all.

**Cause**: Timing issue — the input element isn't fully rendered/focused when `select()` is called during the autoFocus path.

**Solution**: In AccountSelector, wrap the `select()` call in a `requestAnimationFrame` or `setTimeout(0)` to ensure the DOM has settled before selecting text. This applies to both the autoFocus path and the `handleInputFocus` callback. Arrow-up/down row navigation (when dropdown is closed) is unaffected.

## Fix 2: Global keyboard shortcuts for edit mode toggle

**Shortcuts**:
- `e` — Enter edit mode (global scope)
- `Escape` — Exit edit mode (global scope)

**Implementation**:
- Register both in `GlobalShortcuts.tsx` with `'global'` scope
- Dispatch custom events (`'enter-edit-mode'` / `'exit-edit-mode'`) using the existing pattern (same as `'open-new-transaction'`)
- `AccountLedger.tsx` listens for these events and calls `handleToggleEditMode`
- `e` is no-op if already in edit mode; `Escape` is no-op if already in readonly
- Both appear in the `?` shortcuts help menu under "Global"

**Escape key handling**: Modals handle their own Escape via stopPropagation, so the global `'exit-edit-mode'` event dispatch is safe — AccountLedger only acts on it when in edit mode.
