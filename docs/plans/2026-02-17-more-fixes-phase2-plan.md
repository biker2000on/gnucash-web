# More Fixes Phase 2 - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 7 issues: Redis resilience when disconnected, resizable sidebar, BookSwitcher dropdown width, transaction form UX (date focus, account Tab, description autocomplete), Node.js 24 upgrade, and tax shortcut redesign.

**Architecture:** Mostly client-side React fixes (sidebar drag, form behavior, shortcut rebinding) plus one server-side fix (Redis connection resilience). Node.js upgrade is version bumps only. No new dependencies.

**Tech Stack:** Next.js 16, React 19, TypeScript, ioredis, BullMQ, Tailwind CSS 4

---

## Phase 1: Infrastructure (Redis + Node)

### Task 1: Upgrade Node.js from 20 to 24 LTS

**Files:**
- Modify: `package.json:63-65`
- Modify: `Dockerfile:2,12,25`

**Step 1: Update Volta config in package.json**

Change the volta section from:
```json
"volta": {
  "node": "20.19.6"
}
```
To:
```json
"volta": {
  "node": "24.13.1"
}
```

**Step 2: Update Dockerfile base images**

Change all three `FROM` lines:
- Line 2: `FROM node:20-alpine AS deps` → `FROM node:24-alpine AS deps`
- Line 12: `FROM node:20-alpine AS builder` → `FROM node:24-alpine AS builder`
- Line 25: `FROM node:20-alpine AS runner` → `FROM node:24-alpine AS runner`

**Step 3: Update @types/node**

In `package.json` devDependencies, change:
```json
"@types/node": "^20",
```
To:
```json
"@types/node": "^24",
```

**Step 4: Install new Node version locally**

Run: `volta install node@24.13.1`

**Step 5: Reinstall dependencies**

Run: `rm -rf node_modules && npm install`

**Step 6: Verify build**

Run: `npm run build`
Expected: Build succeeds without errors.

**Step 7: Commit**

```
feat: upgrade Node.js from 20 to 24 LTS

yahoo-finance2 requires Node >= 22. Updates Volta config,
Dockerfile base images, and @types/node.
```

---

### Task 2: Redis Graceful Fallback When Disconnected

**Files:**
- Modify: `src/lib/redis.ts:1-23`
- Modify: `src/lib/queue/queues.ts:20-63`

**Context:** When `REDIS_URL` is set but Redis isn't running, `getRedis()` returns a client object that hangs indefinitely on commands because `maxRetriesPerRequest: null` means ioredis never gives up retrying. The try/catch wrappers in `cache.ts` never trigger because the promise never rejects. The fix: set a finite retry limit and connection timeout so commands fail fast, allowing the existing try/catch wrappers to catch and fall back gracefully.

`cache.ts` already has try/catch on every operation - no changes needed there.

**Step 1: Update redis.ts with connection timeout and retry limits**

Replace the entire `src/lib/redis.ts` with:

```typescript
import Redis from 'ioredis';

let redis: Redis | null = null;
let connectionFailed = false;

/**
 * Get Redis connection singleton.
 * Returns null if REDIS_URL is not set or connection has failed.
 * Uses finite retry limits so commands fail fast instead of hanging.
 */
export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (connectionFailed) return null;

  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 3) {
          console.warn('Redis: max connection retries reached, disabling Redis for this process');
          connectionFailed = true;
          return null; // Stop retrying
        }
        return Math.min(times * 500, 2000);
      },
    });
    redis.on('error', (err) => console.warn('Redis connection error:', err.message));
  }
  return redis;
}

/**
 * Get a separate Redis connection for BullMQ (needs maxRetriesPerRequest: null).
 * Returns null if REDIS_URL is not set or connection has previously failed.
 */
export function getBullMQConnection(): { host: string; port: number; password?: string; db?: number; maxRetriesPerRequest: null } | null {
  if (!process.env.REDIS_URL || connectionFailed) return null;
  try {
    const parsed = new URL(process.env.REDIS_URL);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      db: parseInt(parsed.pathname.slice(1) || '0', 10),
      maxRetriesPerRequest: null,
    };
  } catch {
    return null;
  }
}

export function isRedisAvailable(): boolean {
  return !!process.env.REDIS_URL && !connectionFailed;
}
```

Key changes:
- `maxRetriesPerRequest: 1` instead of `null` — commands fail after 1 retry instead of hanging forever
- `connectTimeout: 5000` — 5s timeout on initial connection
- `retryStrategy` — gives up after 3 attempts and sets `connectionFailed = true`
- `connectionFailed` flag — once Redis fails, skip all future attempts for this process
- `getBullMQConnection()` — separate helper for BullMQ which needs `maxRetriesPerRequest: null` (BullMQ manages its own retries)
- `isRedisAvailable()` now also checks `connectionFailed`

**Step 2: Update queues.ts to use getBullMQConnection and add try/catch**

Replace the entire `src/lib/queue/queues.ts` with:

```typescript
import { Queue } from 'bullmq';
import { getBullMQConnection } from '../redis';

let jobQueue: Queue | null = null;

export function getJobQueue(): Queue | null {
  const connection = getBullMQConnection();
  if (!connection) return null;
  if (!jobQueue) {
    try {
      jobQueue = new Queue('gnucash-jobs', { connection });
    } catch (err) {
      console.warn('Failed to create job queue:', err);
      return null;
    }
  }
  return jobQueue;
}

/**
 * Schedule recurring price refresh job.
 */
export async function scheduleRefreshPrices(intervalHours: number = 24): Promise<void> {
  const queue = getJobQueue();
  if (!queue) return;

  try {
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === 'refresh-prices') {
        await queue.removeRepeatableByKey(job.key);
      }
    }

    await queue.add('refresh-prices', {}, {
      repeat: { every: intervalHours * 60 * 60 * 1000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  } catch (err) {
    console.warn('Failed to schedule refresh prices:', err);
  }
}

/**
 * Enqueue an immediate one-off job.
 */
export async function enqueueJob(name: string, data: Record<string, unknown> = {}): Promise<string | undefined> {
  const queue = getJobQueue();
  if (!queue) return undefined;
  try {
    const job = await queue.add(name, data, {
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    return job.id ?? undefined;
  } catch (err) {
    console.warn('Failed to enqueue job:', err);
    return undefined;
  }
}
```

Key changes:
- Uses `getBullMQConnection()` instead of inline URL parsing
- `getJobQueue()` has try/catch around Queue creation
- `scheduleRefreshPrices()` wrapped in try/catch
- `enqueueJob()` wrapped in try/catch, returns `undefined` on failure

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```
fix: Redis graceful fallback when disconnected

When REDIS_URL is set but Redis is unreachable, commands now fail
fast instead of hanging indefinitely. Uses finite retry limits and
a connection-failed flag to skip Redis after repeated failures.
Fixes blank 200 responses and broken keyboard navigation.
```

---

## Phase 2: Sidebar & BookSwitcher

### Task 3: Resizable Sidebar with Drag Handle

**Files:**
- Modify: `src/components/Layout.tsx`

**Context:** The desktop sidebar currently toggles between `w-64` (256px) and `w-16` (64px). We're adding a drag handle on the right edge for free-form resizing between 150px–500px, with the width persisted to localStorage.

**Step 1: Add sidebar width state and localStorage key**

After the existing `SIDEBAR_COLLAPSED_KEY` constant (line 186), add:

```typescript
const SIDEBAR_WIDTH_KEY = 'sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 150;
const MAX_SIDEBAR_WIDTH = 500;
```

Inside the `Layout` component, after the `hydrated` state (line 200), add:

```typescript
const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
const [isDragging, setIsDragging] = useState(false);
```

**Step 2: Hydrate sidebar width from localStorage**

In the existing `useEffect` that hydrates collapsed state (lines 228-238), add width hydration:

```typescript
useEffect(() => {
    try {
        const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
        if (stored === 'true') {
            setCollapsed(true);
        }
        const storedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
        if (storedWidth) {
            const w = parseInt(storedWidth, 10);
            if (w >= MIN_SIDEBAR_WIDTH && w <= MAX_SIDEBAR_WIDTH) {
                setSidebarWidth(w);
            }
        }
    } catch {
        // SSR or access denied -- ignore
    }
    setHydrated(true);
}, []);
```

**Step 3: Add drag handler**

After the `toggleCollapsed` callback, add:

```typescript
const handleDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setIsDragging(true);

    const handleMove = (moveEvent: PointerEvent) => {
        const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + (moveEvent.clientX - startX)));
        setSidebarWidth(newWidth);
    };

    const handleUp = () => {
        setIsDragging(false);
        document.removeEventListener('pointermove', handleMove);
        document.removeEventListener('pointerup', handleUp);
        // Persist final width
        try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
        } catch {
            // ignore
        }
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
}, [sidebarWidth]);
```

Note: there's a closure issue with `sidebarWidth` in `handleUp`. Use a ref instead:

```typescript
const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);

// Keep ref in sync
useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
}, [sidebarWidth]);
```

And in `handleUp`:
```typescript
localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
```

**Step 4: Update the desktop sidebar `<aside>` element**

Replace the desktop sidebar `<aside>` (line 358-360):

From:
```tsx
<aside
    className={`hidden md:flex flex-col border-r border-sidebar-border bg-sidebar-bg transition-all duration-300 shrink-0
        ${collapsed && hydrated ? 'w-16' : 'w-64'}`}
>
```

To:
```tsx
<aside
    className={`hidden md:flex flex-col border-r border-sidebar-border bg-sidebar-bg shrink-0 relative
        ${!isDragging ? 'transition-all duration-300' : ''}`}
    style={collapsed && hydrated ? { width: '4rem' } : { width: `${sidebarWidth}px` }}
>
```

Key: use inline `style` for the pixel width, disable transitions during drag.

**Step 5: Add the drag handle inside the `<aside>` right before `</aside>`**

Before the closing `</aside>` tag for the desktop sidebar (line 393), add:

```tsx
{/* Drag handle */}
{!(collapsed && hydrated) && (
    <div
        onPointerDown={handleDragStart}
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-cyan-500/30 active:bg-cyan-500/50 transition-colors z-10"
        title="Drag to resize sidebar"
    />
)}
```

**Step 6: Update toggleCollapsed to restore saved width**

The existing `toggleCollapsed` callback is fine — when collapsing, the width switches to `4rem`. When expanding, the inline `style` restores `sidebarWidth` which was loaded from localStorage.

**Step 7: Add global drag styles**

Add a `useEffect` to prevent text selection during drag:

```typescript
useEffect(() => {
    if (isDragging) {
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
    } else {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    }
    return () => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    };
}, [isDragging]);
```

**Step 8: Verify build**

Run: `npm run build`
Expected: Build succeeds.

**Step 9: Commit**

```
feat: add resizable sidebar with drag handle

Drag the right edge to resize between 150px-500px. Width persists
to localStorage. Collapse toggle still works. Mobile unaffected.
```

---

### Task 4: BookSwitcher Dropdown Auto-Width

**Files:**
- Modify: `src/components/BookSwitcher.tsx:108-109`

**Step 1: Update dropdown CSS classes**

In `BookSwitcher.tsx`, change the dropdown `<div>` classes (line 108-109):

From:
```tsx
<div className={`absolute z-50 mt-1 bg-surface-elevated border border-border rounded-xl shadow-lg overflow-hidden
    ${collapsed ? 'left-full ml-2 top-0 w-56' : 'left-0 right-0 w-full'}`}
>
```

To:
```tsx
<div className={`absolute z-50 mt-1 bg-surface-elevated border border-border rounded-xl shadow-lg overflow-hidden
    ${collapsed ? 'left-full ml-2 top-0 w-max min-w-56 max-w-80' : 'left-0 w-max min-w-full max-w-80'}`}
>
```

Key changes:
- Expanded mode: `w-max min-w-full max-w-80` — grows to fit content, at least sidebar-wide, capped at 320px. Removed `right-0` so it can overflow right.
- Collapsed mode: `w-max min-w-56 max-w-80` — grows to fit, min 224px, max 320px.

**Step 2: Remove truncation on book names and descriptions**

The book name `<div>` (line 131) has `truncate`. Remove it so names can show fully:

From:
```tsx
<div className="truncate">{book.name}</div>
```

To:
```tsx
<div className="whitespace-nowrap">{book.name}</div>
```

Similarly for the description (line 133), the truncation is handled by the 50-char substring logic, which is fine. But change the CSS:

From:
```tsx
<div className="text-xs text-foreground-tertiary truncate mt-0.5">
```

To:
```tsx
<div className="text-xs text-foreground-tertiary whitespace-nowrap mt-0.5">
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```
fix: BookSwitcher dropdown expands to fit content

Dropdown now auto-sizes to show full book names instead of
truncating. Capped at 320px max-width.
```

---

## Phase 3: Transaction Form Fixes

### Task 5: Auto-Focus Date Field on Open

**Files:**
- Modify: `src/components/TransactionForm.tsx`

**Step 1: Add a ref for the date input**

After the existing `formRef` (line 64), add:

```typescript
const dateInputRef = useRef<HTMLInputElement>(null);
```

**Step 2: Add auto-focus useEffect**

After the existing `useEffect` for fetching default currency (lines 181-197), add:

```typescript
// Auto-focus date field on mount
useEffect(() => {
    // Small delay to ensure the form has rendered
    const timer = setTimeout(() => {
        dateInputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
}, []);
```

**Step 3: Attach ref to date input**

On the date `<input>` element (line 641-647), add the `ref`:

From:
```tsx
<input
    type="date"
    value={formData.post_date}
    onChange={(e) => setFormData(f => ({ ...f, post_date: e.target.value }))}
    onKeyDown={handleDateKeyDown}
    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
/>
```

To:
```tsx
<input
    ref={dateInputRef}
    type="date"
    value={formData.post_date}
    onChange={(e) => setFormData(f => ({ ...f, post_date: e.target.value }))}
    onKeyDown={handleDateKeyDown}
    data-field="post_date"
    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
/>
```

**Step 4: Commit**

```
fix: auto-focus date field when transaction form opens
```

---

### Task 6: Fix AccountSelector Tab Behavior

**Files:**
- Modify: `src/components/ui/AccountSelector.tsx:98-103,152-155,157-197`

**Context:** When you Tab through the From/To account fields, `handleInputFocus` (line 152) always opens the dropdown and clears search. The `useEffect` on line 98-103 resets `focusedIndex` to 0 whenever `isOpen` changes. Combined, this means Tab-through always opens the dropdown with index 0 focused, and Tab-out selects item 0 (changing the value).

**Step 1: Track whether a value already exists on focus**

Replace `handleInputFocus` (lines 152-155):

From:
```typescript
const handleInputFocus = () => {
    setIsOpen(true);
    setSearch('');
};
```

To:
```typescript
const handleInputFocus = () => {
    if (value) {
        // Has existing value - don't open dropdown, select text for easy replacement
        inputRef.current?.select();
    } else {
        // No value - open dropdown to browse
        setIsOpen(true);
        setSearch('');
    }
};
```

**Step 2: Update the Tab handler to not select when dropdown is closed**

In `handleKeyDown` (lines 157-197), the Tab case (lines 186-189) currently selects `flatOptions[focusedIndex]` when the dropdown is open. This is correct. But we need to ensure Tab when dropdown is closed just moves focus:

The current code already handles this correctly at lines 158-165: if `!isOpen`, only ArrowDown opens it. Tab when closed falls through to default browser behavior. No change needed here.

**Step 3: Open dropdown on typing when value exists**

We need the dropdown to open when the user starts typing (to search). Update the `onChange` handler on the input. Currently (line 211):

```tsx
onChange={(e) => setSearch(e.target.value)}
```

Change to:
```tsx
onChange={(e) => {
    setSearch(e.target.value);
    if (!isOpen) setIsOpen(true);
}}
```

**Step 4: Fix the focusedIndex reset effect**

The `useEffect` on lines 98-103 resets `focusedIndex` to 0 when `search` or `isOpen` changes. This is fine for the new behavior since the dropdown only opens when the user starts typing or presses ArrowDown.

**Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds.

**Step 6: Commit**

```
fix: AccountSelector preserves value when tabbing through

Focuses and selects text instead of opening dropdown when field
already has a value. Dropdown opens on typing or ArrowDown.
```

---

### Task 7: Fix Description Autocomplete Focus Tracking

**Files:**
- Modify: `src/components/ui/DescriptionAutocomplete.tsx`

**Context:** The autocomplete dropdown shows suggestions while typing, which already works via the debounced `useEffect`. However, if the user types and tabs away before the debounce fires, the dropdown appears over the next field. We need to track focus and only show the dropdown when the input is focused.

**Step 1: Add focus tracking ref**

After the existing refs (line 34), add:

```typescript
const isFocusedRef = useRef(false);
```

**Step 2: Update the debounced search to check focus**

In the debounced `useEffect` (line 50-76), wrap the `setIsOpen(true)` call:

From (lines 63-64):
```typescript
if (data.suggestions && data.suggestions.length > 0) {
    setIsOpen(true);
```

To:
```typescript
if (data.suggestions && data.suggestions.length > 0 && isFocusedRef.current) {
    setIsOpen(true);
```

**Step 3: Add onFocus and onBlur handlers to the input**

On the `<input>` element (line 188-198), add focus/blur handlers:

From:
```tsx
<input
    ref={inputRef}
    type="text"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={handleKeyDown}
    placeholder={placeholder}
    data-field="description"
    className={...}
/>
```

To:
```tsx
<input
    ref={inputRef}
    type="text"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    onFocus={() => {
        isFocusedRef.current = true;
        // If suggestions already exist, show them
        if (suggestions.length > 0) setIsOpen(true);
    }}
    onBlur={() => {
        isFocusedRef.current = false;
        // Delay closing to allow click events on dropdown items
        setTimeout(() => {
            if (!isFocusedRef.current) setIsOpen(false);
        }, 200);
    }}
    onKeyDown={handleKeyDown}
    placeholder={placeholder}
    data-field="description"
    className={...}
/>
```

**Step 4: Reduce debounce to 200ms**

Change the debounce timer (line 76):

From: `}, 300);`
To: `}, 200);`

**Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds.

**Step 6: Commit**

```
fix: description autocomplete only shows when input is focused

Tracks focus state to prevent dropdown appearing over next field
after tab-away. Reduces debounce from 300ms to 200ms.
```

---

## Phase 4: Tax Rate Shortcut

### Task 8: Redesign Tax Shortcut (Ctrl+T → 't' key + icon button)

**Files:**
- Modify: `src/components/TransactionForm.tsx:332-346,601,694-713`

**Step 1: Create applyTax helper function**

Above `handleAmountKeyDown` (line 332), add a shared helper:

```typescript
const applyTax = () => {
    if (defaultTaxRate <= 0) {
        success('No tax rate configured. Set it in Settings.');
        return;
    }

    // Evaluate any math expression first
    let currentValue: number;
    const evaluated = evaluateMathExpression(simpleData.amount);
    if (evaluated !== null) {
        currentValue = evaluated;
    } else {
        currentValue = parseFloat(simpleData.amount);
    }

    if (isNaN(currentValue) || currentValue === 0) return;

    const withTax = Math.round(currentValue * (1 + defaultTaxRate) * 100) / 100;
    setSimpleData(prev => ({ ...prev, amount: withTax.toFixed(2) }));
    success(`Tax applied: ${currentValue.toFixed(2)} + ${(defaultTaxRate * 100).toFixed(1)}% = ${withTax.toFixed(2)}`);
};
```

**Step 2: Update handleAmountKeyDown to use 't' instead of Ctrl+T**

Replace `handleAmountKeyDown` (lines 332-346):

From:
```typescript
const handleAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        if (defaultTaxRate <= 0) {
            success('No tax rate configured. Set it in Profile settings.');
            return;
        }
        const currentValue = parseFloat(simpleData.amount);
        if (isNaN(currentValue) || currentValue === 0) return;

        const withTax = Math.round(currentValue * (1 + defaultTaxRate) * 100) / 100;
        setSimpleData(prev => ({ ...prev, amount: withTax.toFixed(2) }));
        success(`Tax applied: ${currentValue.toFixed(2)} + ${(defaultTaxRate * 100).toFixed(2)}% = ${withTax.toFixed(2)}`);
    }
};
```

To:
```typescript
const handleAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 't' || e.key === 'T') {
        // Don't intercept if modifier keys are held (let browser handle Ctrl+T etc.)
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        applyTax();
    }
};
```

**Step 3: Update the shortcut registration for help modal**

Change line 601:

From:
```typescript
useKeyboardShortcut('tax-apply', 'Ctrl+T', 'Apply tax rate', () => {}, 'amount-field');
```

To:
```typescript
useKeyboardShortcut('tax-apply', 't', 'Apply tax rate', () => {}, 'amount-field');
```

**Step 4: Add tax icon button next to amount field**

In the amount field section (around lines 694-713), update the `<div className="relative">` wrapper:

From:
```tsx
<div className="relative">
    <input
        type="text"
        inputMode="decimal"
        value={simpleData.amount}
        onChange={(e) => setSimpleData(prev => ({ ...prev, amount: e.target.value }))}
        onBlur={handleAmountBlur}
        onKeyDown={handleAmountKeyDown}
        placeholder="0.00"
        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50"
    />
    {containsMathExpression(simpleData.amount) && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-cyan-400 pointer-events-none">=</span>
    )}
</div>
```

To:
```tsx
<div className="flex gap-1.5 items-center">
    <div className="relative flex-1">
        <input
            type="text"
            inputMode="decimal"
            value={simpleData.amount}
            onChange={(e) => setSimpleData(prev => ({ ...prev, amount: e.target.value }))}
            onBlur={handleAmountBlur}
            onKeyDown={handleAmountKeyDown}
            placeholder="0.00"
            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50"
        />
        {containsMathExpression(simpleData.amount) && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-cyan-400 pointer-events-none">=</span>
        )}
    </div>
    {defaultTaxRate > 0 && (
        <button
            type="button"
            onClick={applyTax}
            className="p-2 rounded-lg bg-input-bg border border-border text-foreground-muted hover:text-foreground hover:border-border-hover transition-colors"
            title={`Apply tax (${(defaultTaxRate * 100).toFixed(1)}%)`}
        >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" d="M19 5L5 19M6.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM17.5 20a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
            </svg>
        </button>
    )}
</div>
```

The icon is a percent symbol (%) SVG. The button is only shown when a tax rate is configured.

**Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds.

**Step 6: Commit**

```
feat: redesign tax shortcut to 't' key + icon button

Changes tax rate application from Ctrl+T (conflicts with browser
new tab) to just 't' when the amount field is focused. Also
evaluates math expressions before applying tax. Adds a percent
icon button for discoverability.
```

---

## Final Verification

After all tasks, run:
```
npm run build && npm run lint
```
Expected: Both pass cleanly.
