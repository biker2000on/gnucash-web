# Edit Mode Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix account field text selection on focus and add global keyboard shortcuts for entering/exiting edit mode.

**Architecture:** Fix 1 wraps the `select()` call in AccountSelector with `requestAnimationFrame` to handle timing issues when focus comes from row activation. Fix 2 adds `e` and `Escape` shortcuts in GlobalShortcuts.tsx that dispatch custom events, with AccountLedger.tsx listening and toggling mode.

**Tech Stack:** React 19, Next.js 16, TypeScript

---

## Task 1: Fix AccountSelector text selection on focus

**Files:**
- Modify: `src/components/ui/AccountSelector.tsx:66-70,195-200`

**Step 1: Fix autoFocus to select text**

In `src/components/ui/AccountSelector.tsx`, the autoFocus effect (lines 66-70) just calls `focus()` without selecting. Change it to also select after a frame:

```typescript
// Auto-focus when requested
useEffect(() => {
    if (autoFocus) {
        inputRef.current?.focus();
    }
}, [autoFocus]);
```

Replace with:

```typescript
// Auto-focus when requested — select text after frame so DOM has settled
useEffect(() => {
    if (autoFocus && inputRef.current) {
        inputRef.current.focus();
        requestAnimationFrame(() => {
            inputRef.current?.select();
        });
    }
}, [autoFocus]);
```

**Step 2: Fix handleInputFocus to select after frame**

The `handleInputFocus` function (lines 196-200) calls `select()` synchronously, which doesn't work reliably when the input value is changing (from `selectedName` to `search` on focus). Change:

```typescript
const handleInputFocus = () => {
    setSearch('');
    inputRef.current?.select();
    onFocus?.();
};
```

Replace with:

```typescript
const handleInputFocus = () => {
    setSearch('');
    requestAnimationFrame(() => {
        inputRef.current?.select();
    });
    onFocus?.();
};
```

**Step 3: Verify**

Run: `npm run build` — should compile without errors.

**Step 4: Commit**

```bash
git add src/components/ui/AccountSelector.tsx
git commit -m "fix: select all text in account field on focus using requestAnimationFrame"
```

---

## Task 2: Add global shortcuts for edit mode toggle

**Files:**
- Modify: `src/components/GlobalShortcuts.tsx`
- Modify: `src/components/AccountLedger.tsx`

**Step 1: Register shortcuts in GlobalShortcuts.tsx**

In `src/components/GlobalShortcuts.tsx`, add two new shortcuts after the existing `close-modal` registration (line 25). Update the existing Escape registration to also dispatch the edit mode event:

Replace the entire file with:

```typescript
'use client'

import { useRouter } from 'next/navigation'
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut'

export function GlobalShortcuts() {
  const router = useRouter()

  // Navigation shortcuts (chords)
  useKeyboardShortcut('nav-dashboard', 'g d', 'Go to Dashboard', () => router.push('/dashboard'))
  useKeyboardShortcut('nav-accounts', 'g a', 'Go to Accounts', () => router.push('/accounts'))
  useKeyboardShortcut('nav-ledger', 'g l', 'Go to Ledger', () => router.push('/ledger'))
  useKeyboardShortcut('nav-investments', 'g i', 'Go to Investments', () => router.push('/investments'))
  useKeyboardShortcut('nav-reports', 'g r', 'Go to Reports', () => router.push('/reports'))

  // New transaction shortcut
  useKeyboardShortcut('new-transaction', 'n', 'New Transaction', () => {
    window.dispatchEvent(new CustomEvent('open-new-transaction'))
  })

  // Edit mode shortcuts
  useKeyboardShortcut('enter-edit-mode', 'e', 'Enter edit mode', () => {
    window.dispatchEvent(new CustomEvent('enter-edit-mode'))
  })

  // Escape to close modal / exit edit mode
  useKeyboardShortcut('close-modal', 'Escape', 'Close modal / Exit edit mode', () => {
    window.dispatchEvent(new CustomEvent('exit-edit-mode'))
  })

  return null
}
```

**Step 2: Listen for edit mode events in AccountLedger.tsx**

In `src/components/AccountLedger.tsx`, add event listeners for the new custom events. Find the existing `open-new-transaction` listener (lines 113-120) and add two more listeners right after it:

After the existing useEffect block:
```typescript
useEffect(() => {
    const handler = () => {
        setEditingTransaction(null);
        setIsEditModalOpen(true);
    };
    window.addEventListener('open-new-transaction', handler);
    return () => window.removeEventListener('open-new-transaction', handler);
}, []);
```

Add:
```typescript
// Listen for global edit mode shortcuts
useEffect(() => {
    const enterHandler = () => {
        if (!isEditMode) {
            handleToggleEditMode();
        }
    };
    const exitHandler = () => {
        if (isEditMode) {
            handleToggleEditMode();
        }
    };
    window.addEventListener('enter-edit-mode', enterHandler);
    window.addEventListener('exit-edit-mode', exitHandler);
    return () => {
        window.removeEventListener('enter-edit-mode', enterHandler);
        window.removeEventListener('exit-edit-mode', exitHandler);
    };
}, [isEditMode, handleToggleEditMode]);
```

**Step 3: Verify**

Run: `npm run build` — should compile without errors.

**Step 4: Commit**

```bash
git add src/components/GlobalShortcuts.tsx src/components/AccountLedger.tsx
git commit -m "feat: add global e/Escape shortcuts to enter/exit edit mode"
```

---

## Task 3: Final verification

**Step 1: Full build**

Run: `npm run build` — must pass with zero errors.

**Step 2: Lint changed files**

Run: `npx eslint src/components/ui/AccountSelector.tsx src/components/GlobalShortcuts.tsx src/components/AccountLedger.tsx`

Must pass with zero errors.
