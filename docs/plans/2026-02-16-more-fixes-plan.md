# GnuCash Web - More Fixes & Enhancements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 10 features across 3 phases: keyboard shortcuts system, transaction UX improvements (save-and-add-another, date shortcuts, math eval, tax rate), new book wizard with templates, index backfill, cash flow chart, and Redis+BullMQ caching/refresh engine.

**Architecture:** Phase 1 is all client-side (React context + hooks for shortcuts, safe math parser for amount fields, user preferences for tax rate). Phase 2 extends existing API patterns (new book wizard, index backfill via existing `fetchHistoricalPrices()`, Recharts area chart). Phase 3 adds Redis + BullMQ as Docker services with a separate worker process and cache-aside pattern on dashboard APIs.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma ORM, Recharts, BullMQ, ioredis, Redis 7

**Validation:** All features validated using Playwright headless with `.env.test` credentials against "Last Year" (2025) data.

---

## Phase 1: UI/UX Polish

### Task 1: Keyboard Shortcuts Context Provider

**Files:**
- Create: `src/contexts/KeyboardShortcutContext.tsx`

**Step 1: Create the keyboard shortcut context and provider**

This is the central brain for all keyboard shortcuts. It maintains a registry of shortcuts, handles a single document-level `keydown` listener, supports chord sequences (`g` then `d`), and suppresses global shortcuts when the user is typing in an input field.

```tsx
// src/contexts/KeyboardShortcutContext.tsx
'use client';

import { createContext, useContext, useCallback, useEffect, useRef, useState, ReactNode, useMemo } from 'react';

export type ShortcutScope = 'global' | 'transaction-form' | 'date-field' | 'amount-field';

export interface ShortcutRegistration {
  id: string;
  key: string;           // Display key: "?", "g d", "Ctrl+Enter", "+", "Ctrl+T"
  description: string;
  scope: ShortcutScope;
  handler: () => void;
}

interface KeyboardShortcutContextType {
  register: (shortcut: ShortcutRegistration) => () => void;
  shortcuts: ShortcutRegistration[];
  isHelpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

const KeyboardShortcutContext = createContext<KeyboardShortcutContextType | undefined>(undefined);

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function KeyboardShortcutProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef<Map<string, ShortcutRegistration>>(new Map());
  const [shortcuts, setShortcuts] = useState<ShortcutRegistration[]>([]);
  const [isHelpOpen, setHelpOpen] = useState(false);
  const chordPrefixRef = useRef<string | null>(null);
  const chordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const register = useCallback((shortcut: ShortcutRegistration) => {
    registryRef.current.set(shortcut.id, shortcut);
    setShortcuts(Array.from(registryRef.current.values()));
    return () => {
      registryRef.current.delete(shortcut.id);
      setShortcuts(Array.from(registryRef.current.values()));
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inputFocused = isInputFocused();

      // Check for chord completion
      if (chordPrefixRef.current) {
        const chordKey = `${chordPrefixRef.current} ${e.key.toLowerCase()}`;
        chordPrefixRef.current = null;
        if (chordTimerRef.current) clearTimeout(chordTimerRef.current);

        for (const s of registryRef.current.values()) {
          if (s.key === chordKey && s.scope === 'global') {
            e.preventDefault();
            s.handler();
            return;
          }
        }
        return; // Chord failed, ignore
      }

      // Check for chord start (single letter that begins a chord)
      if (!inputFocused && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const possibleChord = e.key.toLowerCase();
        const hasChord = Array.from(registryRef.current.values()).some(
          s => s.key.startsWith(possibleChord + ' ') && s.scope === 'global'
        );
        if (hasChord) {
          e.preventDefault();
          chordPrefixRef.current = possibleChord;
          chordTimerRef.current = setTimeout(() => {
            chordPrefixRef.current = null;
          }, 500);
          return;
        }
      }

      // Check non-chord shortcuts
      for (const s of registryRef.current.values()) {
        if (s.key.includes(' ')) continue; // Skip chord shortcuts

        // Scope-based matching
        if (s.scope === 'global' && inputFocused) continue;
        // date-field and amount-field scopes are handled by their own onKeyDown handlers, not here
        if (s.scope === 'date-field' || s.scope === 'amount-field') continue;
        // transaction-form shortcuts work even when input focused (Ctrl+Enter, etc.)

        const matchesKey = matchShortcutKey(s.key, e);
        if (matchesKey) {
          e.preventDefault();
          s.handler();
          return;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const value = useMemo(() => ({ register, shortcuts, isHelpOpen, setHelpOpen }), [register, shortcuts, isHelpOpen]);

  return (
    <KeyboardShortcutContext.Provider value={value}>
      {children}
    </KeyboardShortcutContext.Provider>
  );
}

function matchShortcutKey(shortcutKey: string, e: KeyboardEvent): boolean {
  const parts = shortcutKey.toLowerCase().split('+').map(p => p.trim());
  const needsCtrl = parts.includes('ctrl');
  const needsShift = parts.includes('shift');
  const needsMeta = parts.includes('meta') || parts.includes('cmd');
  const keyPart = parts.filter(p => !['ctrl', 'shift', 'meta', 'cmd', 'alt'].includes(p))[0];

  if (!keyPart) return false;

  const keyMatch = e.key.toLowerCase() === keyPart ||
    (keyPart === 'enter' && e.key === 'Enter') ||
    (keyPart === 'escape' && e.key === 'Escape') ||
    (keyPart === 'esc' && e.key === 'Escape') ||
    (keyPart === '?' && e.key === '?');

  if (!keyMatch) return false;
  if (needsCtrl && !(e.ctrlKey || e.metaKey)) return false;
  if (!needsCtrl && (e.ctrlKey || e.metaKey)) return false;
  if (needsShift && !e.shiftKey) return false;
  // Don't require !shiftKey for non-shift shortcuts (? needs shift on most keyboards)
  return true;
}

export function useKeyboardShortcuts() {
  const context = useContext(KeyboardShortcutContext);
  if (!context) throw new Error('useKeyboardShortcuts must be used within KeyboardShortcutProvider');
  return context;
}
```

**Step 2: Wire the provider into the app**

Modify `src/app/providers.tsx` to wrap children with `KeyboardShortcutProvider`:

```tsx
// In src/app/providers.tsx, add import:
import { KeyboardShortcutProvider } from '@/contexts/KeyboardShortcutContext';

// Wrap children:
return (
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <KeyboardShortcutProvider>
        {children}
      </KeyboardShortcutProvider>
    </ToastProvider>
  </QueryClientProvider>
);
```

**Step 3: Verify the app still loads**

Run: `npm run build`
Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add src/contexts/KeyboardShortcutContext.tsx src/app/providers.tsx
git commit -m "feat: add keyboard shortcuts context provider with chord support"
```

---

### Task 2: Keyboard Shortcut Registration Hook

**Files:**
- Create: `src/lib/hooks/useKeyboardShortcut.ts`

**Step 1: Create convenience hook for registering shortcuts**

```tsx
// src/lib/hooks/useKeyboardShortcut.ts
import { useEffect } from 'react';
import { useKeyboardShortcuts, ShortcutScope } from '@/contexts/KeyboardShortcutContext';

export function useKeyboardShortcut(
  id: string,
  key: string,
  description: string,
  handler: () => void,
  scope: ShortcutScope = 'global',
  enabled: boolean = true
) {
  const { register } = useKeyboardShortcuts();

  useEffect(() => {
    if (!enabled) return;
    const unregister = register({ id, key, description, scope, handler });
    return unregister;
  }, [id, key, description, handler, scope, enabled, register]);
}
```

**Step 2: Commit**

```bash
git add src/lib/hooks/useKeyboardShortcut.ts
git commit -m "feat: add useKeyboardShortcut convenience hook"
```

---

### Task 3: Help Modal Component

**Files:**
- Create: `src/components/KeyboardShortcutHelp.tsx`

**Step 1: Create the help modal**

This component renders all registered shortcuts grouped by scope. It's toggled by pressing `?`.

```tsx
// src/components/KeyboardShortcutHelp.tsx
'use client';

import { useKeyboardShortcuts } from '@/contexts/KeyboardShortcutContext';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { Modal } from '@/components/ui/Modal';

const SCOPE_LABELS: Record<string, string> = {
  global: 'Global',
  'transaction-form': 'Transaction Form',
  'date-field': 'Date Field',
  'amount-field': 'Amount Field',
};

export function KeyboardShortcutHelp() {
  const { shortcuts, isHelpOpen, setHelpOpen } = useKeyboardShortcuts();

  useKeyboardShortcut('help-toggle', '?', 'Show keyboard shortcuts', () => setHelpOpen(true));
  useKeyboardShortcut('help-close', 'Escape', 'Close', () => setHelpOpen(false));

  // Group shortcuts by scope
  const grouped = shortcuts.reduce((acc, s) => {
    if (!acc[s.scope]) acc[s.scope] = [];
    acc[s.scope].push(s);
    return acc;
  }, {} as Record<string, typeof shortcuts>);

  return (
    <Modal isOpen={isHelpOpen} onClose={() => setHelpOpen(false)} title="Keyboard Shortcuts" size="lg">
      <div className="px-6 py-4 space-y-6">
        {Object.entries(grouped).map(([scope, items]) => (
          <div key={scope}>
            <h3 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider mb-3">
              {SCOPE_LABELS[scope] || scope}
            </h3>
            <div className="space-y-2">
              {items.map((s) => (
                <div key={s.id} className="flex items-center justify-between py-1">
                  <span className="text-sm text-foreground">{s.description}</span>
                  <kbd className="px-2 py-1 text-xs font-mono bg-background-tertiary border border-border-hover rounded">
                    {s.key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
```

**Step 2: Add KeyboardShortcutHelp to the main layout**

In `src/components/Layout.tsx` (or wherever the main layout renders children), add:

```tsx
import { KeyboardShortcutHelp } from './KeyboardShortcutHelp';
// Inside the layout JSX, add:
<KeyboardShortcutHelp />
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add src/components/KeyboardShortcutHelp.tsx src/components/Layout.tsx
git commit -m "feat: add keyboard shortcuts help modal (? key)"
```

---

### Task 4: Register Global Navigation Shortcuts

**Files:**
- Modify: `src/components/Layout.tsx` (or create `src/components/GlobalShortcuts.tsx`)

**Step 1: Create a GlobalShortcuts component that registers navigation shortcuts**

```tsx
// src/components/GlobalShortcuts.tsx
'use client';

import { useRouter } from 'next/navigation';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';

export function GlobalShortcuts() {
  const router = useRouter();

  useKeyboardShortcut('nav-dashboard', 'g d', 'Go to Dashboard', () => router.push('/'));
  useKeyboardShortcut('nav-accounts', 'g a', 'Go to Accounts', () => router.push('/accounts'));
  useKeyboardShortcut('nav-ledger', 'g l', 'Go to Ledger', () => router.push('/ledger'));
  useKeyboardShortcut('nav-investments', 'g i', 'Go to Investments', () => router.push('/investments'));
  useKeyboardShortcut('nav-reports', 'g r', 'Go to Reports', () => router.push('/reports'));

  return null;
}
```

**Step 2: Add GlobalShortcuts to the Layout component**

```tsx
import { GlobalShortcuts } from './GlobalShortcuts';
// In Layout JSX:
<GlobalShortcuts />
```

**Step 3: Playwright test - verify navigation shortcuts work**

Using Playwright headless, login with `.env.test` creds, press `g` then `d`, verify URL is `/`. Press `g` then `a`, verify URL is `/accounts`.

**Step 4: Commit**

```bash
git add src/components/GlobalShortcuts.tsx src/components/Layout.tsx
git commit -m "feat: add global navigation shortcuts (g d/a/l/i/r)"
```

---

### Task 5: Save and Add Another

**Files:**
- Modify: `src/components/TransactionForm.tsx`
- Modify: `src/components/TransactionFormModal.tsx`

**Step 1: Add `onSaveAndAnother` prop and button to TransactionForm**

In `src/components/TransactionForm.tsx`:

1. Add to `TransactionFormProps`:
   ```tsx
   onSaveAndAnother?: () => void;
   ```

2. Add a `resetForm` function that keeps the date but clears everything else:
   ```tsx
   const resetForm = () => {
     const currentDate = formData.post_date;
     setFormData({
       post_date: currentDate,
       description: '',
       num: '',
       currency_guid: defaultCurrencyGuid || formData.currency_guid,
       splits: [createEmptySplit(), createEmptySplit()],
     });
     setSimpleData({ amount: '', fromAccountGuid: defaultFromAccount, toAccountGuid: defaultToAccount });
     setErrors([]);
     setFieldErrors({});
   };
   ```

3. Add a `handleSaveAndAnother` function:
   ```tsx
   const handleSaveAndAnother = async () => {
     const validation = validateForm();
     setErrors(validation.errors);
     setFieldErrors(validation.fieldErrors);
     if (!validation.valid) return;

     // same submission logic as handleSubmit...
     setSaving(true);
     try {
       await onSave(apiData); // build apiData same as handleSubmit
       resetForm();
       success('Transaction saved. Ready for next.');
     } catch (error) { /* same error handling */ }
     finally { setSaving(false); }
   };
   ```

4. Add `Ctrl+Shift+Enter` handler in the existing keyboard shortcuts setup (modify the `useEffect` or use the new `useKeyboardShortcut` hook):
   ```tsx
   // In the keydown handler, detect Ctrl+Shift+Enter:
   useEffect(() => {
     const handler = (e: KeyboardEvent) => {
       if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
         e.preventDefault();
         if (onSaveAndAnother && validateForm().valid) {
           handleSaveAndAnother();
         }
       }
     };
     window.addEventListener('keydown', handler);
     return () => window.removeEventListener('keydown', handler);
   }, [onSaveAndAnother, handleSaveAndAnother]);
   ```

5. Add "Save & New" button next to existing buttons in the Actions section (`TransactionForm.tsx:690-716`):
   ```tsx
   {onSaveAndAnother && (
     <button
       type="button"
       onClick={handleSaveAndAnother}
       disabled={saving}
       className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white rounded-lg transition-colors"
     >
       Save & New
     </button>
   )}
   ```

6. Update the keyboard hint text at line 691 to show both shortcuts:
   ```tsx
   <span className="text-xs text-foreground-muted">
     <kbd>Ctrl+Enter</kbd> save {onSaveAndAnother && <> | <kbd>Ctrl+Shift+Enter</kbd> save & new</>}
   </span>
   ```

**Step 2: Wire up in TransactionFormModal**

In `src/components/TransactionFormModal.tsx`, add `saveAndAnother` mode:

1. Add state: `const [addAnother, setAddAnother] = useState(false);`
2. Create `handleSaveAndAnother` that saves then resets (doesn't close the modal):
   ```tsx
   const handleSaveAndAnother = async (data: CreateTransactionRequest) => {
     await handleSave(data);  // reuse existing save logic but don't close
     // The modal stays open - TransactionForm resets internally
   };
   ```
3. Modify `handleSave` to not call `onClose()` when in add-another mode, or better: pass `onSaveAndAnother` prop to TransactionForm that only calls save without close.
4. Pass to TransactionForm:
   ```tsx
   <TransactionForm
     ...existing props...
     onSaveAndAnother={isEditMode ? undefined : handleSaveAndAnother}
   />
   ```
   (Only show "Save & New" when creating, not editing.)

**Step 3: Playwright test**

Login, open new transaction modal, fill fields, press Ctrl+Shift+Enter, verify form resets (date stays, description clears), verify toast appears.

**Step 4: Commit**

```bash
git add src/components/TransactionForm.tsx src/components/TransactionFormModal.tsx
git commit -m "feat: add Save and Add Another button with Ctrl+Shift+Enter shortcut"
```

---

### Task 6: Date Field Shortcuts (+/-/t)

**Files:**
- Modify: `src/components/TransactionForm.tsx`

**Step 1: Add `onKeyDown` handler to the date input**

In `src/components/TransactionForm.tsx`, locate the date input at ~line 517. Add a keydown handler:

```tsx
const handleDateKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp') {
    e.preventDefault();
    const current = new Date(formData.post_date + 'T12:00:00');
    current.setDate(current.getDate() + 1);
    setFormData(f => ({ ...f, post_date: current.toISOString().split('T')[0] }));
  } else if (e.key === '-' || e.key === 'ArrowDown') {
    e.preventDefault();
    const current = new Date(formData.post_date + 'T12:00:00');
    current.setDate(current.getDate() - 1);
    setFormData(f => ({ ...f, post_date: current.toISOString().split('T')[0] }));
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    setFormData(f => ({ ...f, post_date: new Date().toISOString().split('T')[0] }));
  }
};
```

Add `onKeyDown={handleDateKeyDown}` to the date `<input>` at line 518.

Also register these as display-only shortcuts for the help modal:
```tsx
useKeyboardShortcut('date-plus', '+', 'Next day', () => {}, 'date-field');
useKeyboardShortcut('date-minus', '-', 'Previous day', () => {}, 'date-field');
useKeyboardShortcut('date-today', 't', 'Set to today', () => {}, 'date-field');
```

**Step 2: Playwright test**

Open transaction form, focus date field, press `+`, verify date increments. Press `-`, verify decrement. Press `t`, verify today's date.

**Step 3: Commit**

```bash
git add src/components/TransactionForm.tsx
git commit -m "feat: add date field shortcuts (+/- to inc/dec, t for today)"
```

---

### Task 7: Math Expression Evaluator

**Files:**
- Create: `src/lib/math-eval.ts`

**Step 1: Write the safe math expression evaluator**

This is a recursive descent parser. No `eval()`. Supports `+`, `-`, `*`, `/`, parentheses, decimals.

```typescript
// src/lib/math-eval.ts

/**
 * Safe math expression evaluator using recursive descent parsing.
 * Supports +, -, *, /, parentheses, and decimal numbers.
 * No eval() - pure parser.
 */

class Parser {
  private pos = 0;
  private input: string;

  constructor(input: string) {
    this.input = input.replace(/\s/g, '');
  }

  parse(): number {
    const result = this.expression();
    if (this.pos < this.input.length) {
      throw new Error('Unexpected character: ' + this.input[this.pos]);
    }
    return result;
  }

  private expression(): number {
    let left = this.term();
    while (this.pos < this.input.length) {
      const op = this.input[this.pos];
      if (op !== '+' && op !== '-') break;
      this.pos++;
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number {
    let left = this.factor();
    while (this.pos < this.input.length) {
      const op = this.input[this.pos];
      if (op !== '*' && op !== '/') break;
      this.pos++;
      const right = this.factor();
      if (op === '/' && right === 0) throw new Error('Division by zero');
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  private factor(): number {
    // Handle unary minus
    if (this.input[this.pos] === '-') {
      this.pos++;
      return -this.factor();
    }

    // Handle parentheses
    if (this.input[this.pos] === '(') {
      this.pos++; // skip (
      const result = this.expression();
      if (this.input[this.pos] !== ')') throw new Error('Missing closing parenthesis');
      this.pos++; // skip )
      return result;
    }

    // Parse number
    const start = this.pos;
    while (this.pos < this.input.length && (this.isDigit(this.input[this.pos]) || this.input[this.pos] === '.')) {
      this.pos++;
    }
    if (start === this.pos) throw new Error('Expected number at position ' + this.pos);
    return parseFloat(this.input.slice(start, this.pos));
  }

  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }
}

/**
 * Evaluate a math expression string safely.
 * Returns the result rounded to 2 decimal places, or null if the input
 * is not a valid expression (e.g., just a plain number or invalid syntax).
 *
 * @param input The expression string (e.g., "100+50*2")
 * @returns The evaluated result, or null if input is a plain number or invalid
 */
export function evaluateMathExpression(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // If it's just a plain number (no operators), return null (no evaluation needed)
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return null;

  // Must contain at least one operator to be an expression
  if (!/[+\-*/()]/.test(trimmed.replace(/^-/, ''))) return null;

  try {
    const result = new Parser(trimmed).parse();
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Check if a string contains math operators (useful for showing visual indicator).
 */
export function containsMathExpression(input: string): boolean {
  const trimmed = input.trim().replace(/^-/, '');
  return /[+\-*/()]/.test(trimmed);
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/lib/math-eval.ts
git commit -m "feat: add safe math expression evaluator (no eval)"
```

---

### Task 8: Wire Math Eval into Amount Fields

**Files:**
- Modify: `src/components/SplitRow.tsx`
- Modify: `src/components/TransactionForm.tsx` (simple mode amount field)

**Step 1: Update SplitRow debit/credit inputs**

In `src/components/SplitRow.tsx`:

1. Import math-eval:
   ```tsx
   import { evaluateMathExpression, containsMathExpression } from '@/lib/math-eval';
   ```

2. Change input `type` from `"number"` to `"text"` for debit and credit fields (so users can type `+`, `*`, etc.). Add `inputMode="decimal"` for mobile keyboards.

3. Add blur handler to evaluate expressions:
   ```tsx
   const handleDebitBlur = () => {
     const result = evaluateMathExpression(split.debit);
     if (result !== null) {
       onChange(index, 'debit', result.toFixed(2));
     }
   };
   const handleCreditBlur = () => {
     const result = evaluateMathExpression(split.credit);
     if (result !== null) {
       onChange(index, 'credit', result.toFixed(2));
     }
   };
   ```

4. Add `onBlur` to the debit/credit inputs and change type to text:
   ```tsx
   <input
     type="text"
     inputMode="decimal"
     placeholder="Debit"
     value={split.debit}
     onChange={(e) => handleDebitChange(e.target.value)}
     onBlur={handleDebitBlur}
     className="..."
   />
   ```

5. Add visual indicator when field contains an expression:
   ```tsx
   {containsMathExpression(split.debit) && (
     <span className="absolute right-8 top-1/2 -translate-y-1/2 text-xs text-cyan-400">=</span>
   )}
   ```
   Wrap each input in `relative` positioned div.

**Step 2: Update simple mode amount field in TransactionForm**

In `src/components/TransactionForm.tsx` at ~line 573:

1. Change the simple mode amount input from `type="number"` to `type="text"` with `inputMode="decimal"`
2. Add blur handler:
   ```tsx
   const handleAmountBlur = () => {
     const result = evaluateMathExpression(simpleData.amount);
     if (result !== null) {
       setSimpleData(prev => ({ ...prev, amount: result.toFixed(2) }));
     }
   };
   ```
3. Add `onBlur={handleAmountBlur}` to the input.

**Step 3: Playwright test**

Open transaction form, type `100+50` in amount field, tab out, verify field shows `150.00`. Type `100*1.0675`, verify `106.75`.

**Step 4: Commit**

```bash
git add src/components/SplitRow.tsx src/components/TransactionForm.tsx
git commit -m "feat: add math expression evaluation in amount fields"
```

---

### Task 9: Tax Rate User Preference

**Files:**
- Modify: `src/contexts/UserPreferencesContext.tsx`
- Modify: `src/app/(main)/profile/page.tsx`
- Modify: `src/app/api/user/preferences/route.ts`

**Step 1: Add `defaultTaxRate` to UserPreferencesContext**

In `src/contexts/UserPreferencesContext.tsx`:

1. Add to state:
   ```tsx
   const [defaultTaxRate, setDefaultTaxRateState] = useState<number>(0);
   ```

2. Load from API on mount (extend the existing load logic):
   ```tsx
   // In loadPreferences:
   if (parsed.defaultTaxRate !== undefined) {
     setDefaultTaxRateState(parsed.defaultTaxRate);
   }
   // From API response:
   setDefaultTaxRateState(data.defaultTaxRate || 0);
   ```

3. Add setter:
   ```tsx
   const setDefaultTaxRate = useCallback(async (value: number) => {
     setDefaultTaxRateState(value);
     // Update localStorage cache
     const cached = localStorage.getItem(STORAGE_KEY);
     const existing = cached ? JSON.parse(cached) : {};
     localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, defaultTaxRate: value }));
     // Persist to API
     await fetch('/api/user/preferences', {
       method: 'PATCH',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ defaultTaxRate: value }),
     });
   }, []);
   ```

4. Export in context value.

**Step 2: Update the API route**

In `src/app/api/user/preferences/route.ts`, extend PATCH handler to accept `defaultTaxRate`:

```tsx
const { balanceReversal, defaultTaxRate } = body;

// Validate tax rate
if (defaultTaxRate !== undefined) {
  if (typeof defaultTaxRate !== 'number' || defaultTaxRate < 0 || defaultTaxRate > 1) {
    return NextResponse.json({ error: 'Tax rate must be between 0 and 1' }, { status: 400 });
  }
}
```

Store it via `setPreference(currentUser.id, 'default_tax_rate', defaultTaxRate)` using the existing key-value preferences system.

Extend GET to return it.

**Step 3: Add Tax Rate input to Profile page**

In `src/app/(main)/profile/page.tsx`, add a new section after the theme selector:

```tsx
{/* Default Tax Rate */}
<div className="bg-surface rounded-xl border border-border p-6">
  <h2 className="text-lg font-semibold text-foreground mb-4">Tax Settings</h2>
  <div className="space-y-2">
    <label className="block text-sm text-foreground-secondary">Default Tax Rate</label>
    <div className="flex items-center gap-2">
      <input
        type="number"
        step="0.01"
        min="0"
        max="100"
        value={(defaultTaxRate * 100).toFixed(2)}
        onChange={(e) => {
          const pct = parseFloat(e.target.value);
          if (!isNaN(pct) && pct >= 0 && pct <= 100) {
            setDefaultTaxRate(pct / 100);
          }
        }}
        className="w-24 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm"
      />
      <span className="text-sm text-foreground-muted">%</span>
    </div>
    <p className="text-xs text-foreground-muted">
      Press Ctrl+T in amount fields to apply this tax rate.
    </p>
  </div>
</div>
```

**Step 4: Build and verify**

Run: `npm run build`

**Step 5: Commit**

```bash
git add src/contexts/UserPreferencesContext.tsx src/app/api/user/preferences/route.ts src/app/\(main\)/profile/page.tsx
git commit -m "feat: add default tax rate preference to user settings"
```

---

### Task 10: Tax Application Shortcut (Ctrl+T)

**Files:**
- Modify: `src/components/SplitRow.tsx`
- Modify: `src/components/TransactionForm.tsx`

**Step 1: Add Ctrl+T handler to SplitRow amount fields**

In `src/components/SplitRow.tsx`:

1. Import: `import { useUserPreferences } from '@/contexts/UserPreferencesContext';`
2. Import: `import { useToast } from '@/contexts/ToastContext';`
3. Get tax rate: `const { defaultTaxRate } = useUserPreferences();`
4. Get toast: `const { success } = useToast();`

5. Add keydown handler for debit/credit inputs:
   ```tsx
   const handleAmountKeyDown = (e: React.KeyboardEvent, field: 'debit' | 'credit') => {
     if ((e.ctrlKey || e.metaKey) && e.key === 't') {
       e.preventDefault();
       if (defaultTaxRate <= 0) return;
       const currentValue = parseFloat(split[field]) || 0;
       if (currentValue === 0) return;

       // Evaluate math expression first if present
       const evaluated = evaluateMathExpression(split[field]);
       const base = evaluated !== null ? evaluated : currentValue;

       const withTax = Math.round(base * (1 + defaultTaxRate) * 100) / 100;
       onChange(index, field, withTax.toFixed(2));
       success(`Tax applied: ${base.toFixed(2)} + ${(defaultTaxRate * 100).toFixed(2)}% = ${withTax.toFixed(2)}`);
     }
   };
   ```

6. Add `onKeyDown={(e) => handleAmountKeyDown(e, 'debit')}` to debit input, same for credit.

**Step 2: Add Ctrl+T to simple mode amount in TransactionForm**

Same pattern in `src/components/TransactionForm.tsx` for the simple mode amount input.

**Step 3: Register display shortcut for help modal**

```tsx
useKeyboardShortcut('tax-apply', 'Ctrl+T', 'Apply tax rate', () => {}, 'amount-field');
```

**Step 4: Playwright test**

Set tax rate to 6.75% in profile. Open transaction, type `50` in amount, press Ctrl+T, verify field shows `53.38` and toast appears.

**Step 5: Commit**

```bash
git add src/components/SplitRow.tsx src/components/TransactionForm.tsx
git commit -m "feat: add Ctrl+T shortcut to apply tax rate in amount fields"
```

---

## Phase 2: Data Features

### Task 11: Account Template Data Files

**Files:**
- Create: `src/data/account-templates/` directory
- Create: `src/lib/account-templates.ts`

**Step 1: Create template type definitions and loader**

```typescript
// src/lib/account-templates.ts

export type GnuCashAccountType =
  | 'ASSET' | 'BANK' | 'CASH' | 'CREDIT'
  | 'LIABILITY' | 'INCOME' | 'EXPENSE'
  | 'EQUITY' | 'RECEIVABLE' | 'PAYABLE'
  | 'STOCK' | 'MUTUAL' | 'TRADING' | 'ROOT';

export interface AccountTemplate {
  name: string;
  type: GnuCashAccountType;
  description?: string;
  placeholder?: boolean;
  children?: AccountTemplate[];
}

export interface TemplateFile {
  locale: string;
  id: string;             // e.g., "personal", "business"
  name: string;           // e.g., "Personal Accounts"
  description: string;
  currency: string;       // Default currency mnemonic for this locale
  accounts: AccountTemplate[];
}

export interface TemplateLocale {
  code: string;           // e.g., "en_US"
  name: string;           // e.g., "English (United States)"
  templates: TemplateFile[];
}

/**
 * Get all available template locales and their template files.
 */
export function getAvailableTemplates(): TemplateLocale[] {
  // Dynamic imports from src/data/account-templates/
  // Each file is a JSON module
  return BUNDLED_TEMPLATES;
}

/**
 * Get a specific template by locale code and template ID.
 */
export function getTemplate(localeCode: string, templateId: string): TemplateFile | null {
  const locale = BUNDLED_TEMPLATES.find(l => l.code === localeCode);
  if (!locale) return null;
  return locale.templates.find(t => t.id === templateId) || null;
}

/**
 * Flatten a template's account tree into a flat list with parent references.
 * Used when creating accounts in the database.
 */
export function flattenTemplate(
  accounts: AccountTemplate[],
  parentPath: string = ''
): Array<{ path: string; name: string; type: GnuCashAccountType; placeholder: boolean; description?: string }> {
  const result: Array<{ path: string; name: string; type: GnuCashAccountType; placeholder: boolean; description?: string }> = [];
  for (const account of accounts) {
    const path = parentPath ? `${parentPath}:${account.name}` : account.name;
    result.push({
      path,
      name: account.name,
      type: account.type,
      placeholder: account.placeholder ?? false,
      description: account.description,
    });
    if (account.children) {
      result.push(...flattenTemplate(account.children, path));
    }
  }
  return result;
}

// Bundled templates - converted from GnuCash's XML account files.
// Start with en_US as the primary template, add others as JSON files.
const BUNDLED_TEMPLATES: TemplateLocale[] = [
  // These will be populated from actual GnuCash template data
  // See Step 2 for the conversion script
];
```

**Step 2: Convert GnuCash account template XMLs to JSON**

Fetch the GnuCash account template XML files from GitHub (`https://github.com/Gnucash/gnucash/tree/stable/data/accounts/en_US`, etc.) and convert them to JSON format. This is a one-time manual process.

Create JSON files in `src/data/account-templates/`:
- `en_US.json` - US personal/business templates
- `en_GB.json` - UK templates
- `de_DE.json` - German templates
- `fr_FR.json` - French templates
- `es_ES.json` - Spanish templates
- `pt_BR.json` - Brazilian Portuguese templates

Each JSON file follows the `TemplateLocale` interface.

Import them in `account-templates.ts` and populate `BUNDLED_TEMPLATES`.

**Step 3: Commit**

```bash
git add src/lib/account-templates.ts src/data/account-templates/
git commit -m "feat: add account template definitions and locale data"
```

---

### Task 12: New Book Wizard Component

**Files:**
- Create: `src/components/NewBookWizard.tsx`
- Modify: `src/components/BookSwitcher.tsx`

**Step 1: Create the multi-step wizard**

```tsx
// src/components/NewBookWizard.tsx
'use client';

import { useState, useMemo } from 'react';
import { Modal } from './ui/Modal';
import { getAvailableTemplates, getTemplate, flattenTemplate, TemplateLocale, AccountTemplate } from '@/lib/account-templates';
import { useBooks } from '@/contexts/BookContext';
import { useToast } from '@/contexts/ToastContext';

interface NewBookWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type WizardStep = 'name' | 'template' | 'confirm';

export function NewBookWizard({ isOpen, onClose, onSuccess }: NewBookWizardProps) {
  const { refreshBooks } = useBooks();
  const { success, error: showError } = useToast();

  const [step, setStep] = useState<WizardStep>('name');
  const [bookName, setBookName] = useState('');
  const [bookDescription, setBookDescription] = useState('');
  const [currencyMnemonic, setCurrencyMnemonic] = useState('USD');
  const [selectedLocale, setSelectedLocale] = useState('en_US');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [creating, setCreating] = useState(false);

  const templates = useMemo(() => getAvailableTemplates(), []);

  // Render account tree preview
  const previewTemplate = useMemo(() => {
    if (!selectedLocale || !selectedTemplate) return null;
    return getTemplate(selectedLocale, selectedTemplate);
  }, [selectedLocale, selectedTemplate]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/books/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: bookName,
          description: bookDescription,
          currency: currencyMnemonic,
          locale: selectedLocale,
          templateId: selectedTemplate || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create book');

      success(`Book "${bookName}" created successfully`);
      await refreshBooks();
      onSuccess();
      onClose();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to create book');
    } finally {
      setCreating(false);
    }
  };

  // ... wizard step rendering (name step, template step, confirm step)
  // Each step has Next/Back buttons, the confirm step has a Create button
  // Template step shows locale dropdown, template type list, and account tree preview
  // Name step has book name, description, and currency selector

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create New Book" size="2xl" closeOnBackdrop={false}>
      {/* Step indicator: 1. Name & Currency  2. Template  3. Confirm */}
      {/* Step content */}
      {/* Navigation buttons */}
    </Modal>
  );
}
```

(Full JSX for each wizard step to be implemented by the executor agent.)

**Step 2: Create API endpoint**

Create `src/app/api/books/from-template/route.ts`:

```typescript
// POST /api/books/from-template
// Body: { name, description?, currency, locale?, templateId? }
// Creates a book, its root account, currency commodity, and account hierarchy from template
```

The endpoint:
1. Creates or finds the currency commodity
2. Creates the book with `book_open: 'T'`
3. Creates root account
4. If template provided: flattens template, creates all accounts with proper parent relationships
5. Returns the new book guid

**Step 3: Wire wizard into BookSwitcher**

In `src/components/BookSwitcher.tsx`, replace the inline "New Book" form with opening `NewBookWizard`:

```tsx
import { NewBookWizard } from './NewBookWizard';
// Add state: const [wizardOpen, setWizardOpen] = useState(false);
// Replace inline creation with: <NewBookWizard isOpen={wizardOpen} onClose={() => setWizardOpen(false)} onSuccess={...} />
```

**Step 4: Playwright test**

Click "New Book" in sidebar, verify wizard opens with 3 steps. Fill name "Test Book", select USD, select en_US Personal template, verify preview shows account tree, click Create, verify book appears in switcher.

**Step 5: Commit**

```bash
git add src/components/NewBookWizard.tsx src/app/api/books/from-template/route.ts src/components/BookSwitcher.tsx
git commit -m "feat: add new book wizard with currency selector and template hierarchies"
```

---

### Task 13: Index Price Backfill

**Files:**
- Modify: `src/lib/market-index-service.ts`
- Create: `src/app/api/investments/backfill-indices/route.ts`

**Step 1: Add backfill function to market-index-service**

In `src/lib/market-index-service.ts`, add:

```typescript
/**
 * Backfill index prices to the earliest transaction date.
 * Fetches historical data for the gap between earliest transaction
 * and earliest stored index price.
 *
 * @returns Number of new prices stored per index
 */
export async function backfillIndexPrices(): Promise<{ symbol: string; stored: number; dateRange: string }[]> {
  const { default: prisma } = await import('@/lib/prisma');

  // Find the earliest transaction date across all books
  const earliest = await prisma.transactions.findFirst({
    orderBy: { post_date: 'asc' },
    select: { post_date: true },
  });
  if (!earliest) return [];

  const earliestDate = new Date(earliest.post_date);
  earliestDate.setUTCHours(0, 0, 0, 0);

  const indexGuids = await ensureIndexCommodities();
  const results: { symbol: string; stored: number; dateRange: string }[] = [];

  for (const [symbol, commodityGuid] of indexGuids) {
    let stored = 0;

    // Find earliest stored price for this index
    const earliestPrice = await prisma.prices.findFirst({
      where: { commodity_guid: commodityGuid },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    const endDate = earliestPrice
      ? new Date(earliestPrice.date)
      : new Date(); // If no prices, fetch everything up to now

    // Only backfill if there's a gap
    if (earliestDate < endDate) {
      try {
        const prices = await fetchHistoricalPrices(symbol, earliestDate, endDate);
        const existingDates = await getExistingPriceDates(commodityGuid, earliestDate, endDate);

        for (const row of prices) {
          const dateStr = formatDateYMD(row.date);
          if (!existingDates.has(dateStr)) {
            const result = await storeFetchedPrice(commodityGuid, symbol, row.close, row.date);
            if (result) {
              stored++;
              existingDates.add(dateStr);
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to backfill ${symbol}:`, error);
      }
    }

    results.push({
      symbol,
      stored,
      dateRange: `${formatDateYMD(earliestDate)} to ${formatDateYMD(endDate)}`,
    });
  }

  return results;
}
```

**Step 2: Create API endpoint**

```typescript
// src/app/api/investments/backfill-indices/route.ts
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { backfillIndexPrices } from '@/lib/market-index-service';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const results = await backfillIndexPrices();
    return NextResponse.json({ results });
  } catch (error) {
    console.error('Backfill failed:', error);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
```

**Step 3: Add UI button**

Add a "Backfill Historical Index Data" button to the investments page (wherever the settings/actions area is). The button calls `POST /api/investments/backfill-indices` and shows a loading spinner + results toast.

**Step 4: Playwright test**

Click backfill button, verify it completes and shows count of prices stored.

**Step 5: Commit**

```bash
git add src/lib/market-index-service.ts src/app/api/investments/backfill-indices/route.ts
git commit -m "feat: add index price backfill to earliest transaction date"
```

---

### Task 14: Cash Flow Chart API

**Files:**
- Create: `src/app/api/dashboard/cash-flow-chart/route.ts`

**Step 1: Create the API endpoint**

Follow the existing pattern from `src/app/api/dashboard/income-expense/route.ts`:

```typescript
// src/app/api/dashboard/cash-flow-chart/route.ts
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const period = searchParams.get('period') || '1Y';

  // Calculate start date based on period
  const now = new Date();
  let startDate: Date;
  switch (period) {
    case '6M': startDate = new Date(now.getFullYear(), now.getMonth() - 6, 1); break;
    case '1Y': startDate = new Date(now.getFullYear() - 1, now.getMonth(), 1); break;
    case '2Y': startDate = new Date(now.getFullYear() - 2, now.getMonth(), 1); break;
    case 'ALL': startDate = new Date(2000, 0, 1); break;
    default: startDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  }

  const bookAccountGuids = await getBookAccountGuids();
  const baseCurrency = await getBaseCurrency();

  // Fetch all transactions in range with their splits
  // Group by month
  // For each month: sum income accounts (negate) and expense accounts
  // Return: { months: string[], income: number[], expenses: number[], netCashFlow: number[] }

  // ... (query accounts, splits, group by month, currency conversion)

  return NextResponse.json({ months, income, expenses, netCashFlow });
}
```

The query pattern follows `income-expense/route.ts` exactly: get all accounts in book, get all splits in date range, group by month, convert currencies, separate income vs expense.

**Step 2: Build and verify**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/app/api/dashboard/cash-flow-chart/route.ts
git commit -m "feat: add cash flow chart API endpoint with monthly time series"
```

---

### Task 15: Cash Flow Stacked Area Chart Component

**Files:**
- Create: `src/components/charts/CashFlowChart.tsx`

**Step 1: Create the chart component**

Use Recharts (already installed) with `AreaChart`, `Area`, `Line`, `XAxis`, `YAxis`, `Tooltip`, `ResponsiveContainer`. Follow patterns from existing chart components.

```tsx
// src/components/charts/CashFlowChart.tsx
'use client';

import { useState, useEffect, useContext } from 'react';
import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { ExpandedContext } from './ExpandableChart';

interface CashFlowDataPoint {
  month: string;
  income: number;
  expenses: number;
  netCashFlow: number;
}

const PERIODS = ['6M', '1Y', '2Y', 'ALL'] as const;

export default function CashFlowChart() {
  const [period, setPeriod] = useState<string>('1Y');
  const [data, setData] = useState<CashFlowDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const expanded = useContext(ExpandedContext);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/dashboard/cash-flow-chart?period=${period}`)
      .then(res => res.json())
      .then(json => {
        const points: CashFlowDataPoint[] = json.months.map((m: string, i: number) => ({
          month: m,
          income: json.income[i],
          expenses: json.expenses[i],
          netCashFlow: json.netCashFlow[i],
        }));
        setData(points);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [period]);

  const height = expanded ? 500 : 300;

  return (
    <div>
      {/* Period selector */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider">
          Cash Flow
        </h3>
        <div className="flex gap-1">
          {PERIODS.map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2 py-1 text-xs rounded ${
                period === p
                  ? 'bg-cyan-600 text-white'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center" style={{ height }}>
          <div className="w-6 h-6 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="var(--foreground-muted)" />
            <YAxis tick={{ fontSize: 12 }} stroke="var(--foreground-muted)" />
            <Tooltip
              contentStyle={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
              labelStyle={{ color: 'var(--foreground)' }}
            />
            <Legend />
            <Area type="monotone" dataKey="income" stackId="1" fill="#10b981" fillOpacity={0.3} stroke="#10b981" name="Income" />
            <Area type="monotone" dataKey="expenses" stackId="2" fill="#ef4444" fillOpacity={0.3} stroke="#ef4444" name="Expenses" />
            <Line type="monotone" dataKey="netCashFlow" stroke="#3b82f6" strokeDasharray="5 5" strokeWidth={2} name="Net Cash Flow" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
```

**Step 2: Add to Dashboard**

Wrap with `ExpandableChart` and add to the dashboard page below existing charts.

**Step 3: Playwright test**

Navigate to dashboard, verify cash flow chart renders with period selectors. Click "6M", verify chart updates. Expand chart, verify modal.

**Step 4: Commit**

```bash
git add src/components/charts/CashFlowChart.tsx
git commit -m "feat: add cash flow stacked area chart with period selector"
```

---

## Phase 3: Backend Caching & Refresh Engine

### Task 16: Install Redis + BullMQ Dependencies

**Step 1: Install packages**

```bash
npm install bullmq ioredis
```

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add bullmq and ioredis dependencies"
```

---

### Task 17: Redis Connection + Cache Helpers

**Files:**
- Create: `src/lib/redis.ts`
- Create: `src/lib/cache.ts`

**Step 1: Create Redis connection singleton**

```typescript
// src/lib/redis.ts
import Redis from 'ioredis';

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null, // Required for BullMQ
      lazyConnect: true,
    });
    redis.on('error', (err) => console.warn('Redis error:', err.message));
  }
  return redis;
}

export function isRedisAvailable(): boolean {
  return !!process.env.REDIS_URL;
}
```

**Step 2: Create cache helpers**

```typescript
// src/lib/cache.ts
import { getRedis } from './redis';

/**
 * Get a cached value. Returns null if Redis unavailable or key not found.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/**
 * Set a cached value with TTL in seconds.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 86400): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
    // Track the date in a sorted set for range invalidation
    const dateMatch = key.match(/:(\d{4}-\d{2}-\d{2})$/);
    if (dateMatch) {
      const dateScore = new Date(dateMatch[1]).getTime();
      const prefix = key.replace(`:${dateMatch[1]}`, '');
      await redis.zadd(`idx:${prefix}`, dateScore, key);
    }
  } catch (err) {
    console.warn('Cache set failed:', err);
  }
}

/**
 * Invalidate all cache entries for a book from a given date forward.
 * Uses sorted set index for efficient range queries.
 */
export async function cacheInvalidateFrom(bookGuid: string, fromDate: Date): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  const dateScore = fromDate.getTime();
  let invalidated = 0;

  // Scan for all metric indexes for this book
  const indexPattern = `idx:cache:${bookGuid}:*`;
  const stream = redis.scanStream({ match: indexPattern });

  return new Promise((resolve) => {
    stream.on('data', async (keys: string[]) => {
      for (const indexKey of keys) {
        // Get all cache keys from this date forward
        const cacheKeys = await redis.zrangebyscore(indexKey, dateScore, '+inf');
        if (cacheKeys.length > 0) {
          await redis.del(...cacheKeys);
          await redis.zremrangebyscore(indexKey, dateScore, '+inf');
          invalidated += cacheKeys.length;
        }
      }
    });
    stream.on('end', () => resolve(invalidated));
  });
}

/**
 * Clear all caches for a book.
 */
export async function cacheClearBook(bookGuid: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const stream = redis.scanStream({ match: `cache:${bookGuid}:*` });
  stream.on('data', async (keys: string[]) => {
    if (keys.length > 0) await redis.del(...keys);
  });
}

/**
 * Clear all caches.
 */
export async function cacheClearAll(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const stream = redis.scanStream({ match: 'cache:*' });
  stream.on('data', async (keys: string[]) => {
    if (keys.length > 0) await redis.del(...keys);
  });
  const idxStream = redis.scanStream({ match: 'idx:*' });
  idxStream.on('data', async (keys: string[]) => {
    if (keys.length > 0) await redis.del(...keys);
  });
}
```

**Step 3: Commit**

```bash
git add src/lib/redis.ts src/lib/cache.ts
git commit -m "feat: add Redis connection singleton and cache-aside helpers"
```

---

### Task 18: BullMQ Queue Definitions

**Files:**
- Create: `src/lib/queue/queues.ts`

**Step 1: Define job queues and schedulers**

```typescript
// src/lib/queue/queues.ts
import { Queue } from 'bullmq';
import { getRedis } from '../redis';

let jobQueue: Queue | null = null;

export function getJobQueue(): Queue | null {
  const redis = getRedis();
  if (!redis) return null;
  if (!jobQueue) {
    jobQueue = new Queue('gnucash-jobs', { connection: redis });
  }
  return jobQueue;
}

/**
 * Schedule recurring price refresh job.
 * @param intervalHours Refresh interval in hours (6, 12, or 24)
 */
export async function scheduleRefreshPrices(intervalHours: number = 24): Promise<void> {
  const queue = getJobQueue();
  if (!queue) return;

  // Remove existing repeatable job
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'refresh-prices') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  // Add new repeatable job
  const intervalMs = intervalHours * 60 * 60 * 1000;
  await queue.add('refresh-prices', {}, {
    repeat: { every: intervalMs },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}

/**
 * Enqueue an immediate one-off job.
 */
export async function enqueueJob(name: string, data: Record<string, unknown> = {}): Promise<void> {
  const queue = getJobQueue();
  if (!queue) return;
  await queue.add(name, data, {
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}
```

**Step 2: Commit**

```bash
git add src/lib/queue/queues.ts
git commit -m "feat: add BullMQ queue definitions and scheduling helpers"
```

---

### Task 19: Job Handlers

**Files:**
- Create: `src/lib/queue/jobs/refresh-prices.ts`
- Create: `src/lib/queue/jobs/cache-aggregations.ts`

**Step 1: Create price refresh job handler**

```typescript
// src/lib/queue/jobs/refresh-prices.ts
import { Job } from 'bullmq';
import { fetchAndStorePrices } from '@/lib/yahoo-price-service';
import { fetchIndexPrices } from '@/lib/market-index-service';

export async function handleRefreshPrices(job: Job): Promise<void> {
  console.log(`[Job ${job.id}] Starting price refresh...`);

  // Refresh commodity prices
  const commodityResult = await fetchAndStorePrices();
  console.log(`[Job ${job.id}] Commodity prices: ${commodityResult.stored} stored, ${commodityResult.failed} failed`);

  // Refresh index prices
  const indexResult = await fetchIndexPrices();
  console.log(`[Job ${job.id}] Index prices: ${indexResult.map(r => `${r.symbol}: ${r.stored}`).join(', ')}`);
}
```

**Step 2: Create cache aggregation job handler**

```typescript
// src/lib/queue/jobs/cache-aggregations.ts
import { Job } from 'bullmq';
import { cacheSet } from '@/lib/cache';
// Import the actual calculation functions from dashboard API routes
// These will need to be extracted into shared service functions

export async function handleCacheAggregations(job: Job): Promise<void> {
  const { bookGuid } = job.data as { bookGuid: string };
  const today = new Date().toISOString().split('T')[0];

  console.log(`[Job ${job.id}] Caching aggregations for book ${bookGuid}...`);

  // Cache KPIs, net worth, income-expense, sankey data
  // Each calls the same logic as the API route but stores result in cache
  // The API routes will be updated in Task 20 to check cache first

  // TODO: Extract shared calculation functions from API route handlers
  // For now, the cache-aside pattern in Task 20 handles this
}
```

**Step 3: Commit**

```bash
git add src/lib/queue/jobs/
git commit -m "feat: add BullMQ job handlers for price refresh and cache aggregations"
```

---

### Task 20: Integrate Cache into Dashboard APIs

**Files:**
- Modify: `src/app/api/dashboard/kpis/route.ts`
- Modify: `src/app/api/dashboard/net-worth/route.ts`
- Modify: `src/app/api/dashboard/income-expense/route.ts`
- Modify: `src/app/api/dashboard/sankey/route.ts`

**Step 1: Add cache-aside pattern to each dashboard API**

For each of the 4 dashboard API routes, add cache read at the top and cache write before return. Pattern:

```typescript
import { cacheGet, cacheSet } from '@/lib/cache';
import { getActiveBookGuid } from '@/lib/book-scope';

export async function GET(request: NextRequest) {
  // ... existing param parsing ...
  const bookGuid = await getActiveBookGuid();
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = `cache:${bookGuid}:kpis:${today}`; // adjust metric name per route

  // Check cache first
  const cached = await cacheGet(cacheKey);
  if (cached) return NextResponse.json(cached);

  // ... existing calculation logic (unchanged) ...

  // Cache the result
  await cacheSet(cacheKey, responseData, 86400);

  return NextResponse.json(responseData);
}
```

Do this for all 4 routes, changing only the metric name in the cache key.

**Step 2: Add cache invalidation to transaction mutations**

In `src/app/api/transactions/route.ts` (POST) and `src/app/api/transactions/[guid]/route.ts` (PUT, DELETE):

```typescript
import { cacheInvalidateFrom } from '@/lib/cache';
import { getActiveBookGuid } from '@/lib/book-scope';

// After successful transaction create/update/delete:
const bookGuid = await getActiveBookGuid();
const txDate = new Date(data.post_date);
await cacheInvalidateFrom(bookGuid, txDate);
```

**Step 3: Build and verify**

Run: `npm run build`

**Step 4: Commit**

```bash
git add src/app/api/dashboard/ src/app/api/transactions/
git commit -m "feat: add cache-aside pattern to dashboard APIs with forward-only invalidation"
```

---

### Task 21: Worker Process Entry Point

**Files:**
- Create: `worker.ts` (project root)

**Step 1: Create the worker entry point**

```typescript
// worker.ts
import { Worker } from 'bullmq';
import { getRedis } from './src/lib/redis';
import { handleRefreshPrices } from './src/lib/queue/jobs/refresh-prices';
import { handleCacheAggregations } from './src/lib/queue/jobs/cache-aggregations';
import { backfillIndexPrices } from './src/lib/market-index-service';

const redis = getRedis();
if (!redis) {
  console.error('REDIS_URL not set. Worker cannot start.');
  process.exit(1);
}

const worker = new Worker('gnucash-jobs', async (job) => {
  console.log(`Processing job: ${job.name} (${job.id})`);

  switch (job.name) {
    case 'refresh-prices':
      await handleRefreshPrices(job);
      break;
    case 'cache-aggregations':
      await handleCacheAggregations(job);
      break;
    case 'backfill-indices':
      await backfillIndexPrices();
      break;
    default:
      console.warn(`Unknown job type: ${job.name}`);
  }
}, {
  connection: redis,
  concurrency: 1,
});

worker.on('completed', (job) => console.log(`Job ${job?.id} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed:`, err));

console.log('GnuCash Web worker started, waiting for jobs...');
```

**Step 2: Add worker build script to package.json**

```json
"scripts": {
  "worker": "tsx worker.ts",
  "worker:build": "tsc worker.ts --outDir dist"
}
```

**Step 3: Commit**

```bash
git add worker.ts package.json
git commit -m "feat: add BullMQ worker process entry point"
```

---

### Task 22: Docker Compose Setup

**Files:**
- Create: `docker-compose.yml`

**Step 1: Create docker-compose.yml**

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: redis://redis:6379
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
      NEXTAUTH_URL: ${NEXTAUTH_URL:-http://localhost:3000}
    depends_on:
      - redis

  worker:
    build: .
    command: ["node", "-r", "tsconfig-paths/register", "worker.ts"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: redis://redis:6379
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes

volumes:
  redis-data:
```

**Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add Docker Compose with app, worker, and Redis services"
```

---

### Task 23: Settings Page for Scheduling

**Files:**
- Create: `src/app/(main)/settings/page.tsx`
- Create: `src/app/api/settings/schedules/route.ts`
- Create: `src/app/api/settings/schedules/run-now/route.ts`
- Create: `src/app/api/settings/cache/clear/route.ts`

**Step 1: Create the API endpoints**

`GET/PATCH /api/settings/schedules` - Store schedule config in user_preferences table.

`POST /api/settings/schedules/run-now` - Enqueue immediate refresh job:
```typescript
import { enqueueJob } from '@/lib/queue/queues';
await enqueueJob('refresh-prices');
```

`POST /api/settings/cache/clear` - Clear all caches:
```typescript
import { cacheClearAll } from '@/lib/cache';
await cacheClearAll();
```

**Step 2: Create the Settings page**

```tsx
// src/app/(main)/settings/page.tsx
'use client';

// Sections:
// 1. Price Refresh Schedule - enable/disable, frequency dropdown, "Refresh Now" button
// 2. Index Data - "Backfill Historical Data" button, shows date range of stored data
// 3. Cache Management - "Clear All Caches" button
// 4. Tax Rate - mirrors the profile page tax rate input

// Each section is a card with bg-surface rounded-xl border border-border p-6
// Follow the existing profile page styling patterns
```

**Step 3: Add Settings to sidebar navigation**

Add a "Settings" link to the sidebar (in `src/components/Layout.tsx` or wherever nav items are defined). Use a gear icon. Place it near the bottom of the nav, before the profile link.

**Step 4: Playwright test**

Navigate to Settings page. Set refresh to "Every 6 Hours". Click "Refresh Now", verify toast. Click "Clear All Caches", verify toast. Click "Backfill Historical Data", verify progress + results.

**Step 5: Commit**

```bash
git add src/app/\(main\)/settings/ src/app/api/settings/ src/components/Layout.tsx
git commit -m "feat: add settings page with refresh scheduling, cache management, and index backfill"
```

---

### Task 24: New Transaction Shortcut (`n` key)

**Files:**
- Modify: `src/components/GlobalShortcuts.tsx`

**Step 1: Add `n` shortcut to open new transaction modal**

This requires a way to trigger the transaction modal from a global shortcut. The cleanest approach is a global state or event:

```tsx
// In GlobalShortcuts.tsx, add:
useKeyboardShortcut('new-transaction', 'n', 'New transaction', () => {
  // Dispatch a custom event that the transaction modal listens for
  window.dispatchEvent(new CustomEvent('open-new-transaction'));
});
```

Then in the appropriate page components that render `TransactionFormModal`, listen for this event:

```tsx
useEffect(() => {
  const handler = () => setShowCreateModal(true);
  window.addEventListener('open-new-transaction', handler);
  return () => window.removeEventListener('open-new-transaction', handler);
}, []);
```

**Step 2: Playwright test**

On dashboard page, press `n`, verify transaction modal opens.

**Step 3: Commit**

```bash
git add src/components/GlobalShortcuts.tsx
git commit -m "feat: add 'n' shortcut to open new transaction modal"
```

---

### Task 25: Final Integration Test

**Step 1: Run full build**

```bash
npm run build
```
Expected: Build succeeds with no errors.

**Step 2: Run Playwright end-to-end validation**

Using headless Playwright with `.env.test` credentials, test all features against 2025 data:

1. Press `?` - help modal shows all shortcuts
2. Press `g d` - navigates to dashboard
3. Press `g a` - navigates to accounts
4. Press `n` - opens new transaction modal
5. In transaction form:
   - Press `+` in date field - date increments
   - Press `t` in date field - date becomes today
   - Type `100+50` in amount - on blur shows `150.00`
   - Press Ctrl+T - applies tax rate
   - Press Ctrl+Shift+Enter - saves and resets form
6. Dashboard shows cash flow chart with period selectors
7. Book switcher opens new book wizard
8. Settings page shows refresh scheduling, cache clear, backfill

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "test: fix integration issues from end-to-end validation"
```

---

## Summary

| Task | Phase | Feature | Key Files |
|------|-------|---------|-----------|
| 1 | 1 | Keyboard shortcuts context | `src/contexts/KeyboardShortcutContext.tsx` |
| 2 | 1 | Registration hook | `src/lib/hooks/useKeyboardShortcut.ts` |
| 3 | 1 | Help modal (? key) | `src/components/KeyboardShortcutHelp.tsx` |
| 4 | 1 | Navigation shortcuts (g+d/a/l/i/r) | `src/components/GlobalShortcuts.tsx` |
| 5 | 1 | Save and Add Another | `TransactionForm.tsx`, `TransactionFormModal.tsx` |
| 6 | 1 | Date field +/-/t | `TransactionForm.tsx` |
| 7 | 1 | Math expression evaluator | `src/lib/math-eval.ts` |
| 8 | 1 | Wire math into amount fields | `SplitRow.tsx`, `TransactionForm.tsx` |
| 9 | 1 | Tax rate preference | `UserPreferencesContext.tsx`, `profile/page.tsx` |
| 10 | 1 | Ctrl+T tax shortcut | `SplitRow.tsx`, `TransactionForm.tsx` |
| 11 | 2 | Account template data | `src/lib/account-templates.ts`, `src/data/` |
| 12 | 2 | New book wizard | `src/components/NewBookWizard.tsx` |
| 13 | 2 | Index backfill | `market-index-service.ts` |
| 14 | 2 | Cash flow chart API | `src/app/api/dashboard/cash-flow-chart/` |
| 15 | 2 | Cash flow chart component | `src/components/charts/CashFlowChart.tsx` |
| 16 | 3 | Install Redis + BullMQ | `package.json` |
| 17 | 3 | Redis + cache helpers | `src/lib/redis.ts`, `src/lib/cache.ts` |
| 18 | 3 | Queue definitions | `src/lib/queue/queues.ts` |
| 19 | 3 | Job handlers | `src/lib/queue/jobs/` |
| 20 | 3 | Cache integration in APIs | Dashboard API routes |
| 21 | 3 | Worker process | `worker.ts` |
| 22 | 3 | Docker Compose | `docker-compose.yml` |
| 23 | 3 | Settings page | `src/app/(main)/settings/page.tsx` |
| 24 | 3 | New transaction shortcut | `GlobalShortcuts.tsx` |
| 25 | 3 | Integration test | E2E validation |
