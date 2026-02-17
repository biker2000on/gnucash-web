# More Fixes Phase 2 - Design Document

**Date:** 2026-02-17
**Branch:** feat/more-fixes-phase2

## Overview

Seven fixes and enhancements addressing Redis resilience, sidebar UX, transaction form usability, Node.js compatibility, and keyboard shortcut conflicts.

---

## 1. Redis Graceful Fallback (Issues 1 & 4)

**Root cause:** `isRedisAvailable()` checks `!!process.env.REDIS_URL`, not whether Redis is reachable. When REDIS_URL is set but Redis is down, operations fail/hang instead of falling back gracefully. This causes blank 200 responses, which also breaks keyboard chord navigation (Issue 4).

**Approach:** Try/catch wrappers on all Redis operations.

### Changes

**`src/lib/cache.ts`** — Wrap all Redis operations in try/catch:
- `cacheGet`: catch → return `null` (cache miss)
- `cacheSet`: catch → no-op
- `cacheInvalidateFrom`: catch → return `0`
- `cacheClearAll`: catch → return `0`

**`src/lib/redis.ts`** — Add connection status awareness:
- Check `client.status` before returning the client
- If status is not `ready`/`connecting`, return `null` to trigger non-cached path
- Log a warning on first connection failure

**`src/lib/queue/queues.ts`** — Wrap queue operations:
- `getJobQueue()`: try/catch around Queue creation
- `scheduleRefreshPrices()`: try/catch, warn on failure
- `enqueueJob()`: try/catch, return `undefined` (existing fallback)

**Result:** Routes behave identically whether Redis URL is unset or Redis is unreachable. Issue 4 (keyboard chords) resolves automatically since navigation endpoints return proper data.

---

## 2. Resizable Sidebar (Issue 2)

**Problem:** Sidebar only toggles between 256px and 64px.

### Changes to `src/components/Layout.tsx`

**New state:** `sidebarWidth: number` (default 256), persisted to localStorage key `'sidebar-width'`.

**Drag handle:** A 4px `<div>` on the right edge of the desktop sidebar (`absolute right-0 top-0 bottom-0 w-1 cursor-col-resize`). Subtle highlight on hover.

**Drag behavior:**
- `onPointerDown`: capture pointer, record start position
- `onPointerMove` on document: new width = startWidth + (currentX - startX), clamped to 150px–500px
- `onPointerUp`: release capture, persist width to localStorage
- During drag: disable text selection and CSS transitions

**Collapse interaction:**
- When collapsed, drag handle hidden
- Expanding from collapsed restores last saved width
- Collapse toggle unchanged

**Mobile:** No drag handle. Fixed 256px slide-in.

---

## 3. BookSwitcher Dropdown Width (Issue 3)

**Problem:** Dropdown truncates book names.

### Changes to `src/components/BookSwitcher.tsx`

**Expanded mode:** Change from `w-full` to `min-w-full w-max max-w-80`. Dropdown expands to fit content up to 320px, overflowing sidebar to the right if needed.

**Collapsed mode:** Change from `w-56` to `w-max max-w-80`.

---

## 4. Transaction Form Fixes (Issue 5)

### 4a. Auto-focus date field on open

**`src/components/TransactionForm.tsx`:** Add `useEffect` on mount that focuses the date input via ref or `data-field` selector.

### 4b. Preserve account selector values on Tab

**`src/components/ui/AccountSelector.tsx`:**
- On focus with existing value: don't open dropdown, don't reset `focusedIndex`. Select input text instead.
- Open dropdown only on typing or ArrowDown.
- Tab with closed dropdown: move to next field without changing value.

### 4c. Live description autocomplete

**`src/components/ui/DescriptionAutocomplete.tsx`:**
- Verify debounced search triggers on `onChange`, not blur
- Ensure dropdown renders while input is focused and suggestions exist
- Reduce debounce from 300ms to 200ms
- On selection (Enter/Tab/click): auto-fill From/To/Amount via `onSelectSuggestion`

---

## 5. Node.js Upgrade to 24.13.1 LTS (Issue 6)

**Problem:** yahoo-finance2 requires Node >= 22, currently using 20.19.6.

### Changes

- **`package.json`:** Update `volta.node` to `"24.13.1"`
- **`Dockerfile`:** Change all three stages from `node:20-alpine` to `node:24-alpine`
- **Local:** Run `volta install node@24.13.1`

---

## 6. Tax Rate Shortcut Redesign (Issue 7)

**Problem:** `Ctrl+T` opens a new browser tab.

### Changes to `src/components/TransactionForm.tsx`

**New shortcut:** Press `t` while amount field is focused:
1. Evaluate any math expression first (`evaluateMathExpression`)
2. Apply tax: `result * (1 + defaultTaxRate)`
3. Round to 2 decimal places
4. Update field, show toast
5. `e.preventDefault()` to block the letter from appearing

**Tax icon button:** Small percent/calculator icon (16-20px) to the right of each amount field:
- On click: same behavior as pressing `t`
- Tooltip: "Apply tax ({rate}%)"
- Only visible when `defaultTaxRate > 0`

**Shortcut help:** Update registration from `Ctrl+T` to `t`, scope `amount-field`.

---

## File Change Summary

| File | Changes |
|------|---------|
| `src/lib/redis.ts` | Connection status check |
| `src/lib/cache.ts` | Try/catch wrappers |
| `src/lib/queue/queues.ts` | Try/catch wrappers |
| `src/components/Layout.tsx` | Resizable sidebar with drag handle |
| `src/components/BookSwitcher.tsx` | Dropdown width CSS |
| `src/components/TransactionForm.tsx` | Date focus, tax shortcut, icon button |
| `src/components/ui/AccountSelector.tsx` | Tab behavior fix |
| `src/components/ui/DescriptionAutocomplete.tsx` | Autocomplete timing fix |
| `package.json` | Volta node version |
| `Dockerfile` | Node 24 alpine |
