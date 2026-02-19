# Security, SimpleFin, Onboarding & Ledger -- Implementation Plan (v3 Revised)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Lock down all routes behind auth, add full RBAC, build a feature landing page, create an onboarding wizard for new users, integrate SimpleFin for bank transaction import, add inline editable rows to account ledgers, and fix the tax rate input bug.

**Architecture:** Next.js middleware for authentication, handler-level RBAC with a permission service, SimpleFin Bridge REST API polling with encrypted credential storage, and keyboard-navigable inline editing in account ledger table rows.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma 7 (raw SQL for schema via `query()` from `src/lib/db.ts`), iron-session v8, SimpleFin Bridge REST API, existing dark-themed UI components.

**Design doc:** `docs/plans/2026-02-18-security-simplefin-design.md`

---

## Design Deviation: Session Caching Intentionally Skipped

> The design doc specifies session caching with a 5-minute TTL for role lookups. This plan intentionally skips session caching and queries the database directly on every request. Rationale:
>
> 1. **Scale**: This is a personal finance app with 1-5 concurrent users. Caching adds complexity without meaningful performance gain.
> 2. **Latency**: A direct DB query for `getUserRoleForBook()` adds <1ms on an indexed table with a few rows.
> 3. **Correctness**: Caching introduces a role revocation delay (up to 5 minutes of stale permissions). Direct queries ensure immediate effect when an admin changes a user's role.
> 4. **Consistency**: The existing codebase already queries the DB per request for user lookups (e.g., `getCurrentUser()`). Adding caching for one subsystem would be inconsistent.
>
> Session caching can be added later if the app scales beyond its intended personal-finance scope.

---

## Dependency Graph

```
Phase 1 (Tax Fix) ---- standalone, no dependencies
Phase 2 (Middleware) -- standalone, foundation for Phase 3
Phase 3 (RBAC) ------- depends on Phase 2 (middleware must exist first)
Phase 4 (Landing) ---- depends on Phase 2 (middleware must exclude "/" from protection)
Phase 5 (Onboarding) - depends on Phase 3 (needs grantRole, book permissions table)
Phase 6 (Inline Edit)- standalone (creates its own gnucash_web_transaction_meta table in Task 6.0)
Phase 7 (SimpleFin) -- depends on Phase 3 (RBAC tables), Phase 6 (transaction_meta table + review indicators)
Phase 8 (Invitations)- depends on Phase 3 (RBAC tables, invitations table)
```

**Phase 6 is fully standalone:** Task 6.0 creates the `gnucash_web_transaction_meta` table within Phase 6 itself, eliminating the previous circular dependency with Phase 7. Phase 7 Task 7.1 creates only the SimpleFin-specific tables (connections, account map) and does NOT recreate the transaction meta table (it already exists via Phase 6).

**Parallelization opportunities:** Phase 1 can run in parallel with everything. Phase 6 (all tasks) can run in parallel with Phases 2-5. Phase 4 can run in parallel with Phase 3 tasks after Phase 2 completes.

---

## Phase 1: Tax Rate Bug Fix

Quick standalone fix -- no dependencies.

### Task 1.1: Fix tax rate input cursor jump

**Files:**
- Modify: `src/app/(main)/settings/page.tsx` (lines 299-343)

**Problem:** The `value` prop at line 316 recalculates `(defaultTaxRate * 100).toFixed(2)` on every render. Each keystroke triggers `setDefaultTaxRate()`, which causes a re-render, reformatting the value and moving the cursor to end.

**Step 1: Add local state for tax rate input**

At the top of the component (after line 33, next to other `useState` calls), add:
```typescript
const [taxRateInput, setTaxRateInput] = useState('');
```

Add a useEffect to sync from context (after the existing useEffects):
```typescript
// Sync tax rate input from context (mount only)
useEffect(() => {
  if (defaultTaxRate > 0) {
    setTaxRateInput((defaultTaxRate * 100).toString());
  } else {
    setTaxRateInput('');
  }
}, []); // Only on mount -- don't re-sync on every context change
```

**Step 2: Replace the input element**

Replace the `<input type="number" ... />` block (lines 311-327) with:
```tsx
<input
  type="number"
  step="0.01"
  min="0"
  max="100"
  value={taxRateInput}
  onChange={(e) => setTaxRateInput(e.target.value)}
  onBlur={() => {
    const pct = parseFloat(taxRateInput);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) {
      setDefaultTaxRate(pct / 100);
    } else if (taxRateInput === '') {
      setDefaultTaxRate(0);
    }
  }}
  placeholder="0.00"
  className="w-32 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
/>
```

**Step 3: Fix the help text**

The help text (lines 330-340) currently renders "Ctrl" and "T" as two separate `<kbd>` elements. Since commit `d86c9f7`, the actual shortcut is just the `t` key (no Ctrl modifier). Replace the entire `<p>` block at lines 330-340 with:
```tsx
<p className="text-xs text-foreground-muted">
  Press{' '}
  <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover text-xs">
    T
  </kbd>{' '}
  in amount fields to apply this tax rate to the current value.
</p>
```

**Step 4: Verify**

Run: `npm run build`
Expected: Clean build, no TypeScript errors.

**Step 5: Manual test**

Open Settings page -> Tax Rate field. Type "6.75" -- cursor should NOT jump. Tab away -> value persists.

**Acceptance criteria:**
- [ ] Typing in tax rate field does not move cursor
- [ ] Tabbing away persists the value to context
- [ ] Help text shows "T" key only (not "Ctrl + T")
- [ ] `npm run build` passes

**Step 6: Commit**

```bash
git add src/app/\(main\)/settings/page.tsx
git commit -m "fix: tax rate input cursor jump on keystroke"
```

---

## Phase 2: Authentication Middleware

Foundation for all security features.

### Task 2.0: Extract session config to shared file

**Files:**
- Create: `src/lib/session-config.ts`
- Modify: `src/lib/auth.ts` (import from session-config instead of defining inline)

**WHY:** The middleware (`src/middleware.ts`) needs the `SessionData` interface and `sessionOptions`, but it CANNOT import from `src/lib/auth.ts` because that file imports `bcrypt` and `prisma` -- both are heavy Node.js modules that break in the Edge Runtime / middleware context. Extracting the lightweight config to a separate file avoids this.

**Step 1: Create `src/lib/session-config.ts`**

```typescript
import { SessionOptions } from 'iron-session';

// Session data structure
export interface SessionData {
    userId?: number;
    username?: string;
    isLoggedIn: boolean;
    activeBookGuid?: string;
}

// Session configuration -- shared between middleware and auth.ts
export const sessionOptions: SessionOptions = {
    password: process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_12345',
    cookieName: 'gnucash_web_session',
    cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24, // 24 hours
    },
};
```

**IMPORTANT:** This file must NOT import bcrypt, prisma, or any heavy dependencies. It exports ONLY the interface and config object.

**Step 2: Update `src/lib/auth.ts` to import from session-config**

Remove the `SessionData` interface and `sessionOptions` constant from `src/lib/auth.ts`. Replace with:

```typescript
import { SessionData, sessionOptions } from './session-config';
export type { SessionData };
```

The rest of `auth.ts` (getSession, hashPassword, verifyPassword, etc.) stays exactly the same.

**Acceptance criteria:**
- [ ] `src/lib/session-config.ts` has NO imports of bcrypt, prisma, or other heavy modules
- [ ] `src/lib/auth.ts` re-exports `SessionData` from session-config
- [ ] All existing code that imports `SessionData` from `@/lib/auth` continues to work
- [ ] `npm run build` passes

**Step 3: Commit**

```bash
git add src/lib/session-config.ts src/lib/auth.ts
git commit -m "refactor: extract session config to shared file for middleware compatibility"
```

### Task 2.1: Create Next.js middleware for route protection

**Files:**
- Create: `src/middleware.ts` (Next.js 16 convention: must be in `src/` when using `src/` directory)
- Reference: `src/lib/session-config.ts` (shared session config)

**IMPORTANT: iron-session in middleware**

Next.js middleware does NOT support `cookies()` from `next/headers`. The `cookies()` function is only available in Server Components and Route Handlers. In middleware, you must use the `getIronSession(request, response, sessionOptions)` signature which iron-session v8 supports for `NextRequest`/`NextResponse` pairs.

**Step 1: Create the middleware**

```typescript
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
import { SessionData, sessionOptions } from '@/lib/session-config';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public auth API routes -- no auth required
  if (pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  // For all protected routes, create the response first, then read session
  const response = NextResponse.next();
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  // Protected API routes -- return 401 if not authenticated
  if (pathname.startsWith('/api/')) {
    if (!session.isLoggedIn || !session.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return response;
  }

  // Protected page routes -- redirect to login
  if (!session.isLoggedIn || !session.userId) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - / (landing page, public)
     * - /login (auth page)
     * - /api/auth/* (auth endpoints)
     * - /_next (Next.js internals)
     * - /icon.svg (favicon)
     * - Static files (.ico, .png, .jpg, .svg, etc.)
     *
     * The regex (?!$) ensures the root path "/" (empty capture after
     * stripping the leading "/") is excluded, keeping the landing page public.
     */
    '/((?!_next|login|icon\\.svg|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css|js)$)(?!$).*)',
  ],
};
```

**KEY DIFFERENCE FROM v2:** The v2 plan used `cookies()` from `next/headers` which does NOT work in middleware. This version uses `getIronSession(request, response, sessionOptions)` which is the correct iron-session v8 API for middleware contexts. The `response` object is created first via `NextResponse.next()`, then `getIronSession` reads the session cookie from the request and can set cookies on the response.

**EDGE CASE: Form submissions blocked by middleware**

If a user's session expires while they have a form open (e.g., editing a transaction), the middleware will block the API request with a 401. The frontend must handle this gracefully:
- API calls returning 401 should trigger a redirect to `/login?redirect={currentPath}`
- Consider adding a global fetch wrapper or Axios interceptor for this

This is tracked as a cross-cutting concern in Task 2.3 (client-side 401 handling).

**Step 2: Test middleware locally**

1. Start dev server: `npm run dev`
2. Open incognito browser -> navigate to `http://localhost:3000/accounts` -> should redirect to `/login?redirect=/accounts`
3. Call `curl http://localhost:3000/api/accounts` -> should return `{"error":"Unauthorized"}` with 401
4. Call `curl http://localhost:3000/api/auth/login` -> should NOT be blocked (public)
5. Navigate to `http://localhost:3000/` -> should show landing page (public) -- NOTE: this page won't exist yet; verify the middleware doesn't intercept
6. Navigate to `http://localhost:3000/login` -> should show login page (public)

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build.

**Acceptance criteria:**
- [ ] Unauthenticated GET `/api/accounts` returns `{"error":"Unauthorized"}` with 401
- [ ] Unauthenticated GET `/accounts` redirects to `/login?redirect=/accounts`
- [ ] GET `/api/auth/login` is NOT blocked
- [ ] GET `/api/auth/register` is NOT blocked
- [ ] GET `/` is NOT blocked by middleware
- [ ] GET `/login` is NOT blocked by middleware
- [ ] Authenticated requests pass through unchanged
- [ ] `npm run build` passes

**Step 4: Commit**

```bash
git add src/middleware.ts
git commit -m "feat: add auth middleware to protect all routes"
```

### Task 2.2: Support redirect back after login

**Files:**
- Modify: `src/app/login/page.tsx`
- Modify: `src/components/LoginForm.tsx`

**Step 1: Read the redirect param in login/page.tsx**

In `src/app/login/page.tsx`, add `useSearchParams`:

```typescript
import { useSearchParams } from 'next/navigation';
```

Inside `LoginPage`, read the redirect param:
```typescript
const searchParams = useSearchParams();
const redirectTo = searchParams.get('redirect') || '/accounts';
```

In the `useEffect` at line 18 where it currently does `router.push('/accounts')`, change to:
```typescript
router.push(redirectTo);
```

Pass `redirectTo` to `LoginForm`:
```tsx
<LoginForm
    mode={mode}
    onToggleMode={() => setMode(mode === 'login' ? 'register' : 'login')}
    redirectTo={redirectTo}
/>
```

**Step 2: Update LoginForm to accept and use redirectTo**

In `src/components/LoginForm.tsx`, update the props interface:
```typescript
interface LoginFormProps {
    mode: 'login' | 'register';
    onToggleMode: () => void;
    redirectTo?: string;
}
```

Update the destructuring:
```typescript
export function LoginForm({ mode, onToggleMode, redirectTo = '/accounts' }: LoginFormProps) {
```

At line 45, replace `router.push('/accounts')` with:
```typescript
router.push(redirectTo);
```

**Step 3: Wrap LoginPage in Suspense for useSearchParams**

Since `useSearchParams()` requires a Suspense boundary in Next.js 16, wrap the page content. Either add a `<Suspense>` wrapper in the page or use a client component that handles it.

**Acceptance criteria:**
- [ ] Visiting `/accounts` while unauthenticated redirects to `/login?redirect=/accounts`
- [ ] After login, user is redirected back to `/accounts` (or whatever the original path was)
- [ ] Direct navigation to `/login` (no redirect param) redirects to `/accounts` after login

**Step 4: Commit**

```bash
git add src/app/login/page.tsx src/components/LoginForm.tsx
git commit -m "feat: redirect to original page after login"
```

### Task 2.3: Add global 401 handler for session expiry

**Files:**
- Create: `src/lib/fetch-with-auth.ts` (utility wrapper)
- Modify: Components that make fetch calls (informational -- not all at once)

**Step 1: Create a fetch wrapper**

```typescript
export async function fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 401) {
    // Session expired -- redirect to login
    const currentPath = window.location.pathname;
    window.location.href = `/login?redirect=${encodeURIComponent(currentPath)}`;
    throw new Error('Session expired');
  }
  return res;
}
```

**Step 2:** This is a progressive enhancement. Existing fetch calls continue to work (middleware returns 401, but the page may show an error). Migrate critical components over time. Priority: `BookContext.tsx` (called on every page load), `AccountLedger.tsx`, `TransactionForm.tsx`.

**Acceptance criteria:**
- [ ] When session expires during use, user sees login page (not a raw error)

**Step 3: Commit**

```bash
git add src/lib/fetch-with-auth.ts
git commit -m "feat: add fetch wrapper for automatic 401 redirect on session expiry"
```

---

## Phase 3: RBAC Database Schema & Permission Service

Depends on Phase 2 (middleware must be in place).

### Task 3.1: Add RBAC tables to db-init.ts

**Files:**
- Modify: `src/lib/db-init.ts` (follow existing `createExtensionTables()` pattern which uses `query()` from `src/lib/db.ts`)

**IMPORTANT:** This file uses `query()` from `./db`, NOT Prisma `$queryRaw`. All DDL must use the same `query()` function.

**Step 1: Add DDL constants**

Add after the existing `userPreferencesTableDDL` constant (around line 275):

```typescript
const rolesTableDDL = `
CREATE TABLE IF NOT EXISTS gnucash_web_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default roles
INSERT INTO gnucash_web_roles (name, description)
VALUES
    ('readonly', 'View-only access to book data and reports'),
    ('edit', 'Can create, edit, and delete transactions, budgets, and accounts'),
    ('admin', 'Full access including user management and book administration')
ON CONFLICT (name) DO NOTHING;
`;

const bookPermissionsTableDDL = `
CREATE TABLE IF NOT EXISTS gnucash_web_book_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL,
    role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),
    granted_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_guid)
);
CREATE INDEX IF NOT EXISTS idx_bp_user_book ON gnucash_web_book_permissions(user_id, book_guid);
CREATE INDEX IF NOT EXISTS idx_bp_book_role ON gnucash_web_book_permissions(book_guid, role_id);
`;

const invitationsTableDDL = `
CREATE TABLE IF NOT EXISTS gnucash_web_invitations (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) UNIQUE NOT NULL,
    book_guid VARCHAR(32) NOT NULL,
    role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),
    created_by INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    used_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    used_at TIMESTAMP,
    max_uses INTEGER DEFAULT 1,
    use_count INTEGER DEFAULT 0,
    is_revoked BOOLEAN DEFAULT FALSE,
    revoked_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inv_code ON gnucash_web_invitations(code);
CREATE INDEX IF NOT EXISTS idx_inv_book ON gnucash_web_invitations(book_guid, is_revoked);
`;
```

**Step 2: Execute the DDLs in `createExtensionTables()`**

Add to the `try` block after line 286 (`await query(userPreferencesTableDDL);`):
```typescript
await query(rolesTableDDL);
await query(bookPermissionsTableDDL);
await query(invitationsTableDDL);
```

**Step 3: Add auto-migration for existing users**

After the table creation statements, add a backfill:

```typescript
// Backfill: grant admin on all books to existing users with no permissions
await query(`
  INSERT INTO gnucash_web_book_permissions (user_id, book_guid, role_id, granted_by, granted_at)
  SELECT u.id, b.guid,
    (SELECT id FROM gnucash_web_roles WHERE name = 'admin'),
    u.id, NOW()
  FROM gnucash_web_users u
  CROSS JOIN books b
  WHERE NOT EXISTS (
    SELECT 1 FROM gnucash_web_book_permissions bp
    WHERE bp.user_id = u.id AND bp.book_guid = b.guid
  )
  ON CONFLICT (user_id, book_guid) DO NOTHING;
`);
```

**EDGE CASE: First user registration (no admin exists yet)**

When the very first user registers, there are no RBAC tables yet (they're created on app startup, not on registration). The flow is:
1. App starts -> `initializeDatabase()` creates RBAC tables + backfill
2. User registers -> no books exist yet, so no permissions needed
3. User creates first book -> `grantRole(userId, bookGuid, 'admin', userId)` is called (Task 5.3)

For existing installations upgrading:
1. App restarts -> `initializeDatabase()` creates RBAC tables
2. Backfill grants admin on all books to all existing users
3. All existing users retain full access

**Step 4: Verify**

Run: `npm run build` -- should pass.
Start dev server -> check logs for "Extension tables created/verified successfully".

**Acceptance criteria:**
- [ ] `gnucash_web_roles` table has 3 rows (readonly, edit, admin)
- [ ] `gnucash_web_book_permissions` table exists with correct schema
- [ ] `gnucash_web_invitations` table exists with correct schema
- [ ] Existing users get admin on all books (backfill)
- [ ] `npm run build` passes

**Step 5: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add RBAC tables (roles, book_permissions, invitations)"
```

### Task 3.2: Create permission service

**Files:**
- Create: `src/lib/services/permission.service.ts`

**IMPORTANT:** Uses `prisma.$queryRaw` from `src/lib/prisma` (the extended Prisma client), consistent with other services like `audit.service.ts` and `transaction.service.ts`.

**Step 1: Implement the permission service**

```typescript
import prisma from '@/lib/prisma';

export type Role = 'readonly' | 'edit' | 'admin';

const ROLE_HIERARCHY: Record<Role, number> = {
  readonly: 0,
  edit: 1,
  admin: 2,
};

/**
 * Get a user's role for a specific book.
 */
export async function getUserRoleForBook(
  userId: number,
  bookGuid: string
): Promise<Role | null> {
  const permission = await prisma.$queryRaw<{ name: string }[]>`
    SELECT r.name
    FROM gnucash_web_book_permissions bp
    JOIN gnucash_web_roles r ON r.id = bp.role_id
    WHERE bp.user_id = ${userId} AND bp.book_guid = ${bookGuid}
    LIMIT 1
  `;
  return (permission[0]?.name as Role) ?? null;
}

/**
 * Check if a user has at least the minimum required role for a book.
 */
export async function hasMinimumRole(
  userId: number,
  bookGuid: string,
  minimumRole: Role
): Promise<boolean> {
  const userRole = await getUserRoleForBook(userId, bookGuid);
  if (!userRole) return false;
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minimumRole];
}

/**
 * Get all books a user has access to, with their role.
 */
export async function getUserBooks(
  userId: number
): Promise<{ guid: string; name: string; role: Role }[]> {
  const rows = await prisma.$queryRaw<{ guid: string; name: string; role: string }[]>`
    SELECT b.guid, COALESCE(b.name, 'Unnamed Book') as name, r.name as role
    FROM gnucash_web_book_permissions bp
    JOIN books b ON b.guid = bp.book_guid
    JOIN gnucash_web_roles r ON r.id = bp.role_id
    WHERE bp.user_id = ${userId}
    ORDER BY b.name
  `;
  return rows.map(r => ({ ...r, role: r.role as Role }));
}

/**
 * Grant a role to a user for a book.
 */
export async function grantRole(
  userId: number,
  bookGuid: string,
  role: Role,
  grantedBy: number
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_book_permissions (user_id, book_guid, role_id, granted_by, granted_at)
    VALUES (
      ${userId}, ${bookGuid},
      (SELECT id FROM gnucash_web_roles WHERE name = ${role}),
      ${grantedBy}, NOW()
    )
    ON CONFLICT (user_id, book_guid)
    DO UPDATE SET role_id = (SELECT id FROM gnucash_web_roles WHERE name = ${role}),
                  granted_by = ${grantedBy},
                  granted_at = NOW()
  `;
}

/**
 * Revoke a user's access to a book.
 */
export async function revokeAccess(
  userId: number,
  bookGuid: string
): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM gnucash_web_book_permissions
    WHERE user_id = ${userId} AND book_guid = ${bookGuid}
  `;
}

/**
 * Check if a user has any permissions at all (used for first-run detection).
 */
export async function userHasAnyPermissions(userId: number): Promise<boolean> {
  const result = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) as count FROM gnucash_web_book_permissions WHERE user_id = ${userId}
  `;
  return Number(result[0]?.count ?? 0) > 0;
}
```

**Acceptance criteria:**
- [ ] All functions compile without TypeScript errors
- [ ] Follows existing service pattern (prisma.$queryRaw)

**Step 2: Commit**

```bash
git add src/lib/services/permission.service.ts
git commit -m "feat: add permission service for RBAC checks"
```

### Task 3.3: Create requireAuth and requireRole helpers

**Files:**
- Modify: `src/lib/auth.ts`

**Step 1: Add imports and helper functions**

Add imports at the top of `src/lib/auth.ts`:
```typescript
import { NextResponse } from 'next/server';
import { getUserRoleForBook, type Role } from './services/permission.service';
```

Add at the end of the file:

```typescript
/**
 * Require authentication. Returns user or 401 response.
 * Used in API route handlers (middleware already checked auth,
 * but this provides the user object + active book context).
 */
export async function requireAuth(): Promise<
  { user: { id: number; username: string }; session: IronSession<SessionData> } |
  NextResponse
> {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const user = await prisma.gnucash_web_users.findUnique({
    where: { id: session.userId },
    select: { id: true, username: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return { user, session };
}

/**
 * Require a minimum role for the active book. Returns user + role or error response.
 * The middleware guarantees authentication; this function adds authorization.
 */
export async function requireRole(minimumRole: Role): Promise<
  { user: { id: number; username: string }; role: Role; bookGuid: string } |
  NextResponse
> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const { user, session } = authResult;
  const bookGuid = session.activeBookGuid;

  if (!bookGuid) {
    return NextResponse.json({ error: 'No active book selected' }, { status: 400 });
  }

  const userRole = await getUserRoleForBook(user.id, bookGuid);
  if (!userRole) {
    return NextResponse.json({ error: 'No access to this book' }, { status: 403 });
  }

  const ROLE_HIERARCHY: Record<string, number> = { readonly: 0, edit: 1, admin: 2 };
  if (ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minimumRole]) {
    return NextResponse.json(
      { error: `Requires ${minimumRole} role, you have ${userRole}` },
      { status: 403 }
    );
  }

  return { user, role: userRole, bookGuid };
}
```

**NOTE on double-checking:** The middleware already blocks unauthenticated requests, so `requireAuth()` in handlers is redundant for auth but necessary to:
1. Get the user object (middleware doesn't pass user info through)
2. Get the active book GUID from session
3. Check authorization (role-based access)

This means the `getCurrentUser()` function still works as before. The `requireAuth()` / `requireRole()` helpers are the NEW preferred approach for route handlers.

**Acceptance criteria:**
- [ ] `requireAuth()` returns user object or 401 NextResponse
- [ ] `requireRole('edit')` returns 403 when user has 'readonly' role
- [ ] `requireRole('readonly')` passes for any authenticated user with book access
- [ ] `npm run build` passes

**Step 2: Commit**

```bash
git add src/lib/auth.ts
git commit -m "feat: add requireAuth and requireRole helpers"
```

### Task 3.4: Add role checks to all API routes

**Files:**
- Modify: All unprotected API route files

**Current state:**
- **70 total API routes** (counted from glob)
- **10 routes** currently use `getCurrentUser()`: settings/schedules, settings/cache/clear, settings/schedules/run-now, investments/index-coverage, investments/backfill-indices, user/preferences, reports/saved/*, auth/me
- **3 auth routes** use other auth functions: auth/login, auth/register, auth/logout
- **1 route** uses `getSession()` directly: books/active
- **56 routes** have NO auth checks at all

**IMPORTANT:** Auth routes (`/api/auth/*`) should NOT get role checks -- they're public by design. The middleware already excludes them.

**Approach:** Add `requireRole()` to the handler level. For the 10 routes that already have `getCurrentUser()`, replace with `requireRole()`. For the 56 unprotected routes, add `requireRole()`.

**Group routes by required role:**

| Role | HTTP Method | Routes |
|------|-------------|--------|
| `readonly` | GET | All data-reading routes: accounts/*, budgets/*, commodities, dashboard/*, exchange-rates/*, investments/*, prices/*, reports/*, transactions/*, assets/*, docs |
| `edit` | POST/PUT/DELETE | transactions (CRUD), accounts (CRUD), budgets/*/amounts (PUT), splits/*/reconcile (PUT), splits/bulk/reconcile (PUT), prices/fetch (POST), accounts/*/move (PUT) |
| `admin` | POST/PUT/DELETE | import, export, settings/*, investments/backfill-indices, user/preferences |

**Pattern for GET-only routes:**
```typescript
import { requireRole } from '@/lib/auth';
import { NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;
  // ... existing handler code, replace activeBookGuid lookups with roleResult.bookGuid
}
```

**Pattern for routes with both GET and POST:**
```typescript
export async function GET(request: NextRequest) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;
  // ...
}

export async function POST(request: NextRequest) {
  const roleResult = await requireRole('edit');
  if (roleResult instanceof NextResponse) return roleResult;
  // ...
}
```

**Detailed route-by-role matrix (CORRECTED for book-related endpoints):**

**Book-related routes (special auth rules):**

| Endpoint | Method | Auth Level | Rationale |
|----------|--------|-----------|-----------|
| `GET /api/books` | GET | `requireAuth()` + filter by user's permissions | Returns empty array for new users (not 403). Use `getUserBooks(user.id)` to filter. |
| `GET /api/books/active` | GET | `requireAuth()` | Session read -- any authenticated user needs this |
| `PUT /api/books/active` | PUT | `requireAuth()` + verify permission on target book | Manual check: before switching, verify user has permission on the target book via `getUserRoleForBook()` |
| `POST /api/books` | POST | `requireAuth()` | Book creation bootstraps its own permissions (creator gets admin). No prior book role needed. |
| `POST /api/books/from-template` | POST | `requireAuth()` | Same as book creation -- bootstraps permissions |
| `GET /api/books/templates` | GET | `requireAuth()` | Needed during onboarding when user has no books yet |
| `PUT /api/books/[guid]` | PUT | `requireRole('admin')` | Only book admin can modify book settings |
| `DELETE /api/books/[guid]` | DELETE | `requireRole('admin')` | Only book admin can delete a book |
| `PUT /api/books/default` | PUT | `requireAuth()` | User preference -- no role check needed |

**readonly (GET only):**
- `src/app/api/accounts/route.ts` (GET)
- `src/app/api/accounts/[guid]/route.ts` (GET)
- `src/app/api/accounts/[guid]/info/route.ts` (GET)
- `src/app/api/accounts/[guid]/transactions/route.ts` (GET)
- `src/app/api/accounts/[guid]/valuation/route.ts` (GET)
- `src/app/api/accounts/balances/route.ts` (GET)
- `src/app/api/budgets/route.ts` (GET)
- `src/app/api/budgets/[guid]/route.ts` (GET)
- `src/app/api/budgets/[guid]/accounts/route.ts` (GET)
- `src/app/api/budgets/[guid]/amounts/route.ts` (GET)
- `src/app/api/budgets/[guid]/amounts/all-periods/route.ts` (GET)
- `src/app/api/budgets/[guid]/estimate/route.ts` (GET)
- `src/app/api/commodities/route.ts` (GET)
- `src/app/api/dashboard/kpis/route.ts` (GET)
- `src/app/api/dashboard/net-worth/route.ts` (GET)
- `src/app/api/dashboard/income-expense/route.ts` (GET)
- `src/app/api/dashboard/sankey/route.ts` (GET)
- `src/app/api/dashboard/cash-flow-chart/route.ts` (GET)
- `src/app/api/exchange-rates/route.ts` (GET)
- `src/app/api/exchange-rates/pair/route.ts` (GET)
- `src/app/api/investments/status/route.ts` (GET)
- `src/app/api/investments/portfolio/route.ts` (GET)
- `src/app/api/investments/history/route.ts` (GET)
- `src/app/api/investments/index-coverage/route.ts` (GET - currently has getCurrentUser)
- `src/app/api/prices/route.ts` (GET)
- `src/app/api/prices/[guid]/route.ts` (GET)
- `src/app/api/reports/account-summary/route.ts` (GET)
- `src/app/api/reports/balance-sheet/route.ts` (GET)
- `src/app/api/reports/cash-flow/route.ts` (GET)
- `src/app/api/reports/equity-statement/route.ts` (GET)
- `src/app/api/reports/general-journal/route.ts` (GET)
- `src/app/api/reports/general-ledger/route.ts` (GET)
- `src/app/api/reports/income-expense-chart/route.ts` (GET)
- `src/app/api/reports/income-statement/route.ts` (GET)
- `src/app/api/reports/investment-portfolio/route.ts` (GET)
- `src/app/api/reports/net-worth-chart/route.ts` (GET)
- `src/app/api/reports/reconciliation/route.ts` (GET)
- `src/app/api/reports/transaction-report/route.ts` (GET)
- `src/app/api/reports/treasurer/route.ts` (GET)
- `src/app/api/reports/trial-balance/route.ts` (GET)
- `src/app/api/reports/saved/route.ts` (GET - currently has getCurrentUser)
- `src/app/api/reports/saved/[id]/route.ts` (GET - currently has getCurrentUser)
- `src/app/api/transactions/route.ts` (GET)
- `src/app/api/transactions/descriptions/route.ts` (GET)
- `src/app/api/assets/transactions/route.ts` (GET)
- `src/app/api/assets/schedules/route.ts` (GET)
- `src/app/api/assets/fixed/route.ts` (GET)
- `src/app/api/docs/route.ts` (GET)

**edit (POST/PUT/DELETE on data):**
- `src/app/api/transactions/route.ts` (POST)
- `src/app/api/transactions/[guid]/route.ts` (PUT, DELETE)
- `src/app/api/accounts/route.ts` (POST)
- `src/app/api/accounts/[guid]/route.ts` (PUT, DELETE)
- `src/app/api/accounts/[guid]/move/route.ts` (PUT)
- `src/app/api/budgets/[guid]/amounts/route.ts` (PUT)
- `src/app/api/splits/[guid]/reconcile/route.ts` (PUT)
- `src/app/api/splits/bulk/reconcile/route.ts` (PUT)
- `src/app/api/prices/route.ts` (POST)
- `src/app/api/prices/[guid]/route.ts` (DELETE)
- `src/app/api/prices/fetch/route.ts` (POST)
- `src/app/api/reports/saved/route.ts` (POST - currently has getCurrentUser)
- `src/app/api/reports/saved/[id]/route.ts` (PUT, DELETE - currently has getCurrentUser)
- `src/app/api/reports/saved/[id]/star/route.ts` (PUT - currently has getCurrentUser)

**admin (management operations):**
- `src/app/api/books/[guid]/route.ts` (PUT, DELETE)
- `src/app/api/import/route.ts` (POST)
- `src/app/api/export/route.ts` (GET)
- `src/app/api/settings/schedules/route.ts` (GET/PUT - currently has getCurrentUser)
- `src/app/api/settings/schedules/run-now/route.ts` (POST - currently has getCurrentUser)
- `src/app/api/settings/cache/clear/route.ts` (POST - currently has getCurrentUser)
- `src/app/api/investments/backfill-indices/route.ts` (POST - currently has getCurrentUser)
- `src/app/api/user/preferences/route.ts` (GET/PUT - currently has getCurrentUser)

**Acceptance criteria:**
- [ ] Every non-auth API route has a `requireRole()` or `requireAuth()` check
- [ ] GET endpoints use `requireRole('readonly')` (except book-related which use `requireAuth()`)
- [ ] Data mutation endpoints use `requireRole('edit')`
- [ ] Admin endpoints use `requireRole('admin')`
- [ ] Book-related endpoints follow the corrected auth table above
- [ ] `GET /api/books` returns empty array (not 403) for users with no book permissions
- [ ] `POST /api/books` and `POST /api/books/from-template` use `requireAuth()` (not `requireRole`)
- [ ] `PUT /api/books/active` verifies permission on the target book
- [ ] `npm run build` passes
- [ ] Existing functionality unchanged for admin users

**Step 1: Commit**

```bash
git add src/app/api/
git commit -m "feat: add RBAC role checks to all API routes"
```

### Task 3.5: Bootstrap RBAC for new user registration

**Files:**
- Modify: `src/app/api/auth/register/route.ts`

**Problem:** When a new user registers, they have no book permissions. The backfill in `db-init.ts` only runs on app startup. If a user registers after startup, they get no permissions.

**Solution:** After registration, check if books exist. If yes, grant `readonly` on all books (conservative default). If no books exist (first user), that's fine -- they'll create a book via onboarding (Phase 5) which grants `admin`.

```typescript
// After createSession(user.id, user.username):
import { grantRole } from '@/lib/services/permission.service';

// Grant readonly on all existing books for new users
const books = await prisma.books.findMany({ select: { guid: true } });
for (const book of books) {
  await grantRole(user.id, book.guid, 'readonly', user.id);
}
```

**NOTE:** This is a policy decision. Alternative: grant NO permissions and require an admin to invite them. The implementation should be easy to change later.

**Acceptance criteria:**
- [ ] New user can register and see existing books with readonly access
- [ ] First user (no books) can register without errors

**Step 1: Commit**

```bash
git add src/app/api/auth/register/route.ts
git commit -m "feat: grant readonly on existing books for new user registration"
```

---

## Phase 4: Landing Page

Depends on Phase 2 (middleware excludes `/` from protection).

### Task 4.1: Create public landing page

**Files:**
- Create: `src/app/page.tsx` (root page, outside `(main)` route group)

**IMPORTANT:** Currently `src/app/page.tsx` does NOT exist. There is no root page. The `(main)` route group handles all authenticated pages. Creating `src/app/page.tsx` will serve the `/` route without going through `(main)/layout.tsx` (which calls `initializeDatabase()` and wraps in `BookProvider`).

**Step 1: Create the landing page**

Create `src/app/page.tsx` as a Server Component (no `'use client'` needed):

```tsx
import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
            GnuCash Web
          </h1>
          <div className="flex gap-3">
            <Link href="/login" className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors">
              Sign In
            </Link>
            <Link href="/login" className="px-4 py-2 text-sm bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white rounded-lg transition-all">
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 py-20 text-center">
        <h2 className="text-4xl font-bold text-foreground mb-4">
          View and manage your GnuCash data on the web
        </h2>
        <p className="text-lg text-foreground-muted max-w-2xl mx-auto mb-10">
          A modern web interface for your GnuCash financial data. Dashboards, reports, transaction management, and more.
        </p>
        <Link href="/login" className="inline-block px-8 py-3 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white font-medium rounded-lg transition-all">
          Sign In to Get Started
        </Link>
      </section>

      {/* Feature Cards */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* 4 feature cards: Dashboard, Transactions, Reports, Investments */}
        </div>
      </section>
    </div>
  );
}
```

**Step 2: Ensure middleware excludes it**

The middleware matcher regex `(?!$)` already excludes the root path `/`. Verify by navigating to `http://localhost:3000/` while unauthenticated -- should show landing page.

**Step 3: Ensure Tailwind classes work**

The landing page uses the same Tailwind config as the rest of the app. Since it's in `src/app/`, it will be picked up by Tailwind's content configuration.

**Acceptance criteria:**
- [ ] `http://localhost:3000/` shows landing page without auth
- [ ] "Sign In" and "Get Started" links navigate to `/login`
- [ ] Page matches dark theme aesthetic
- [ ] `npm run build` passes

**Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: add public landing page with feature showcase"
```

---

## Phase 5: New User Onboarding & Book Creation

Depends on Phase 3 (RBAC tables and `grantRole()`).

### Task 5.1: Add business and non-profit account templates

**Files:**
- Create: `src/data/account-templates/en_US_business.json`
- Create: `src/data/account-templates/en_US_nonprofit.json`
- Modify: `src/lib/account-templates.ts` (register new templates)

**Step 1: Create template JSON files**

Follow the exact structure of `src/data/account-templates/en_US.json`. The file format has a top-level `{ "templates": [...] }` with each template having `{ locale, id, name, description, currency, accounts: [...] }`.

For business and non-profit, create **separate files** with their own template entries. The account hierarchies are detailed in the design doc Section 2.

**Step 2: Register in account-templates.ts**

Add imports in `src/lib/account-templates.ts` (after line 9):
```typescript
import enUSBusiness from '@/data/account-templates/en_US_business.json';
import enUSNonProfit from '@/data/account-templates/en_US_nonprofit.json';
```

Modify the `locales` array to merge templates for the same locale:
```typescript
const locales: TemplateLocale[] = [
  {
    code: 'en_US',
    name: 'English (US)',
    templates: [
      ...(enUS as { templates: TemplateFile[] }).templates,
      ...(enUSBusiness as { templates: TemplateFile[] }).templates,
      ...(enUSNonProfit as { templates: TemplateFile[] }).templates,
    ],
  },
  {
    code: 'en_GB',
    name: 'English (UK)',
    templates: (enGB as { templates: TemplateFile[] }).templates,
  },
];
```

**Acceptance criteria:**
- [ ] `getAvailableTemplates()` returns en_US locale with 3+ templates (Personal, Business, Non-Profit)
- [ ] `getTemplate('en_US', 'business')` returns the business template
- [ ] `flattenTemplate()` correctly flattens the new templates
- [ ] `npm run build` passes

**Step 3: Commit**

```bash
git add src/data/account-templates/ src/lib/account-templates.ts
git commit -m "feat: add small business and non-profit account templates"
```

### Task 5.2: Create template listing API

**Files:**
- Create: `src/app/api/books/templates/route.ts`

**Step 1: Implement GET handler**

```typescript
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAvailableTemplates } from '@/lib/account-templates';

export async function GET() {
  // Use requireAuth() -- NOT requireRole() -- because a new user with
  // no books (and therefore no roles) needs to see templates during onboarding.
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const templates = getAvailableTemplates();
  return NextResponse.json(templates);
}
```

**WHY `requireAuth()` not `requireRole()`:** A new user who just registered has no books and therefore no roles. `requireRole('readonly')` would return 400 ("No active book selected") or 403 ("No access to this book"). But the user needs to see templates to create their first book during onboarding. `requireAuth()` only checks that the user is logged in, which is all we need here.

**Acceptance criteria:**
- [ ] `GET /api/books/templates` returns template list for authenticated users
- [ ] Returns 401 for unauthenticated users
- [ ] Returns 200 (not 403) for authenticated users with no books

**Step 2: Commit**

```bash
git add src/app/api/books/templates/route.ts
git commit -m "feat: add API endpoint to list available book templates"
```

### Task 5.3: Create onboarding page and CreateBookWizard

**Files:**
- Create: `src/app/(main)/onboarding/page.tsx`
- Create: `src/components/CreateBookWizard.tsx`
- Modify: `src/app/(main)/layout.tsx` (or BookProvider) for first-run detection

**Step 1: Create CreateBookWizard component**

A reusable `'use client'` component with:
- Two cards: "Start from Template" and "Import from GnuCash"
- Template card: fetches `/api/books/templates`, shows template picker, book name input, currency selector
- Import card: file upload dropzone for `.gnucash` files
- On submit: calls `POST /api/books/from-template` or `POST /api/import`, then calls `onBookCreated(newGuid)`

Props:
```typescript
interface CreateBookWizardProps {
  onBookCreated: (bookGuid: string) => void;
  isOnboarding?: boolean; // Shows welcome message when true
}
```

**Step 2: Create onboarding page**

`src/app/(main)/onboarding/page.tsx`:
```tsx
'use client';

import { CreateBookWizard } from '@/components/CreateBookWizard';
import { useBooks } from '@/contexts/BookContext';
import { useRouter } from 'next/navigation';

export default function OnboardingPage() {
  const { refreshBooks, switchBook } = useBooks();
  const router = useRouter();

  const handleBookCreated = async (bookGuid: string) => {
    await refreshBooks();
    await switchBook(bookGuid);
    router.push('/accounts');
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <CreateBookWizard onBookCreated={handleBookCreated} isOnboarding={true} />
    </div>
  );
}
```

**Step 3: Grant admin role on book creation**

Modify `src/app/api/books/from-template/route.ts` to:
1. Add `requireAuth()` check (not `requireRole` -- user may have no books yet)
2. After creating the book, call `grantRole(userId, bookGuid, 'admin', userId)`

```typescript
import { requireAuth } from '@/lib/auth';
import { grantRole } from '@/lib/services/permission.service';

export async function POST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  // ... existing book creation logic ...

  // Grant admin role to the creating user
  await grantRole(user.id, bookGuid, 'admin', user.id);

  return NextResponse.json({ guid: bookGuid, ... }, { status: 201 });
}
```

**Step 4: Add first-run detection**

In `src/contexts/BookContext.tsx`, after loading books: if user has zero books, the `BookProvider` should expose a `hasNoBooks` flag. The `(main)/layout.tsx` or a client-side wrapper checks this and redirects to `/onboarding`.

Option A (BookContext): Add `hasNoBooks: boolean` to context, let consuming components check it.
Option B (Layout): Add a client component wrapper in `(main)/layout.tsx` that checks book count.

Recommended: Option A in BookContext:
```typescript
const hasNoBooks = !loading && books.length === 0;
```

Then in a new `<OnboardingGuard>` wrapper component:
```tsx
function OnboardingGuard({ children }: { children: ReactNode }) {
  const { hasNoBooks, loading } = useBooks();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && hasNoBooks && pathname !== '/onboarding') {
      router.push('/onboarding');
    }
  }, [hasNoBooks, loading, pathname, router]);

  if (loading) return <LoadingSpinner />;
  return <>{children}</>;
}
```

**Acceptance criteria:**
- [ ] New user with no books sees onboarding page after login
- [ ] Can create book from template (Personal, Business, Non-Profit)
- [ ] After book creation, user has admin role on the new book
- [ ] After book creation, redirected to `/accounts`
- [ ] CreateBookWizard can be reused in book management settings
- [ ] `npm run build` passes

**Step 5: Commit**

```bash
git add src/app/\(main\)/onboarding/ src/components/CreateBookWizard.tsx src/contexts/BookContext.tsx src/app/api/books/from-template/route.ts
git commit -m "feat: add onboarding page and reusable book creation wizard"
```

---

## Phase 6: Inline Editable Ledger

Phase 6 is fully standalone. Task 6.0 creates the `gnucash_web_transaction_meta` table needed by Task 6.3.

### Task 6.0: Create transaction metadata table

**Files:**
- Modify: `src/lib/db-init.ts`

**WHY in Phase 6:** The `gnucash_web_transaction_meta` table is needed by Task 6.3 (reviewed toggle) and later by Phase 7 (SimpleFin imports). Creating it here makes Phase 6 fully standalone with no cross-phase dependencies.

**Step 1: Add DDL constant**

Add after the existing table DDL constants in `src/lib/db-init.ts`:

```typescript
const transactionMetaTableDDL = `
CREATE TABLE IF NOT EXISTS gnucash_web_transaction_meta (
    id SERIAL PRIMARY KEY,
    transaction_guid VARCHAR(32) NOT NULL UNIQUE,
    source VARCHAR(50) NOT NULL DEFAULT 'manual',
    reviewed BOOLEAN NOT NULL DEFAULT TRUE,
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    simplefin_transaction_id VARCHAR(255),
    confidence VARCHAR(20)
);
CREATE INDEX IF NOT EXISTS idx_txn_meta_source ON gnucash_web_transaction_meta(source) WHERE source != 'manual';
CREATE INDEX IF NOT EXISTS idx_txn_meta_simplefin_id ON gnucash_web_transaction_meta(simplefin_transaction_id) WHERE simplefin_transaction_id IS NOT NULL;
`;
```

**Step 2: Execute in `createExtensionTables()`**

Add after the existing `await query(...)` calls:
```typescript
await query(transactionMetaTableDDL);
```

**NOTE:** This uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, making it idempotent and safe to run on every startup.

**Acceptance criteria:**
- [ ] `gnucash_web_transaction_meta` table created on app startup
- [ ] Table has correct schema (transaction_guid UNIQUE, source, reviewed, simplefin_transaction_id, confidence)
- [ ] Partial indexes created for source and simplefin_transaction_id
- [ ] `npm run build` passes

**Step 3: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add transaction metadata table for review tracking"
```

### Task 6.1: Add keyboard navigation to AccountLedger

**Files:**
- Modify: `src/components/AccountLedger.tsx`

**Current state of AccountLedger:**
- 430+ lines
- Uses `useState` for transactions, modals, reconciliation
- Renders a `<table>` with `<tr>` rows for each transaction
- Each row has: reconcile state, date, description, transfer/splits, amount, running balance
- Rows are clickable (opens TransactionModal for view)
- Multi-split transactions show "-- Multiple Splits --" and can be expanded

**Step 1: Add focus tracking state**

After the existing state declarations (around line 60):
```typescript
const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);
const [editingGuid, setEditingGuid] = useState<string | null>(null);
const tableRef = useRef<HTMLTableElement>(null);
```

**Step 2: Add keyboard event handler**

**IMPORTANT:** The `r` key handler for "reviewed" toggle is NOT included here because `toggleReviewed` is defined in Task 6.3. Including it now would cause a build error. The `r` key handler will be added in Task 6.3 when the reviewed toggle is implemented.

```typescript
const handleTableKeyDown = useCallback((e: KeyboardEvent) => {
  if (editingGuid) return; // Let InlineEditRow handle keys during edit

  // Only handle if focus is on the table or body (not in a modal or input)
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

  switch (e.key) {
    case 'ArrowDown':
    case 'j': // vim-style
      e.preventDefault();
      setFocusedRowIndex(i => Math.min(i + 1, transactions.length - 1));
      break;
    case 'ArrowUp':
    case 'k': // vim-style
      e.preventDefault();
      setFocusedRowIndex(i => Math.max(i - 1, 0));
      break;
    case 'Enter':
      if (focusedRowIndex >= 0) {
        e.preventDefault();
        const tx = transactions[focusedRowIndex];
        const isMultiSplit = (tx.splits?.length || 0) > 2;
        if (isMultiSplit) {
          // Multi-split: open modal instead of inline edit
          handleRowClick(tx.guid);
        } else {
          setEditingGuid(tx.guid);
        }
      }
      break;
    case 'Delete':
    case 'Backspace':
      if (focusedRowIndex >= 0) {
        e.preventDefault();
        const tx = transactions[focusedRowIndex];
        // Open confirmation dialog before deleting
        setDeleteConfirmGuid(tx.guid);
      }
      break;
    case 'Escape':
      setFocusedRowIndex(-1);
      break;
  }
}, [editingGuid, focusedRowIndex, transactions, handleRowClick]);
```

**Step 2b: Add delete confirmation state and dialog**

Add state for delete confirmation:
```typescript
const [deleteConfirmGuid, setDeleteConfirmGuid] = useState<string | null>(null);
```

Add a confirmation dialog component (rendered at the bottom of the component, before the closing tag):
```tsx
{deleteConfirmGuid && (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div className="bg-background-secondary border border-border rounded-xl p-6 max-w-sm">
      <h3 className="text-lg font-semibold text-foreground mb-2">Delete Transaction</h3>
      <p className="text-sm text-foreground-muted mb-4">
        Are you sure you want to delete this transaction? This cannot be undone.
      </p>
      <div className="flex gap-3 justify-end">
        <button
          onClick={() => setDeleteConfirmGuid(null)}
          className="px-4 py-2 text-sm border border-border rounded-lg text-foreground-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          onClick={async () => {
            await handleDeleteTransaction(deleteConfirmGuid);
            setDeleteConfirmGuid(null);
          }}
          className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg"
        >
          Delete
        </button>
      </div>
    </div>
  </div>
)}
```

**Step 3: Attach keyboard listener**

```typescript
useEffect(() => {
  window.addEventListener('keydown', handleTableKeyDown);
  return () => window.removeEventListener('keydown', handleTableKeyDown);
}, [handleTableKeyDown]);
```

**Step 4: Apply focus styling to rows**

In the `<tr>` element (around line 297), add conditional focus ring:
```tsx
className={`hover:bg-white/[0.02] transition-colors group cursor-pointer
  ${isSelected ? 'bg-amber-500/5' : ''}
  ${index === focusedRowIndex ? 'ring-2 ring-cyan-500/50 ring-inset bg-white/[0.03]' : ''}`}
```

Where `index` comes from `transactions.map((tx, index) => { ... })` -- note the current code doesn't destructure `index`, so add it.

**Step 5: Scroll focused row into view**

```typescript
useEffect(() => {
  if (focusedRowIndex >= 0 && tableRef.current) {
    const rows = tableRef.current.querySelectorAll('tbody tr');
    rows[focusedRowIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}, [focusedRowIndex]);
```

**Acceptance criteria:**
- [ ] Up/Down arrows move focus ring between rows
- [ ] j/k also works (vim-style)
- [ ] Enter on focused row opens inline edit (simple splits) or modal (multi-split)
- [ ] Delete/Backspace on focused row opens confirmation dialog before deleting
- [ ] Escape clears focus
- [ ] Focus ring is visible and scrolls into view
- [ ] Keyboard navigation doesn't interfere with modals or inputs
- [ ] `npm run build` passes (no reference to undefined `toggleReviewed`)

**Step 6: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add keyboard navigation (up/down/enter/delete) to account ledger"
```

### Task 6.2: Create InlineEditRow component

**Files:**
- Create: `src/components/InlineEditRow.tsx`
- Create: `src/lib/hooks/useDateShortcuts.ts`
- Create: `src/lib/hooks/useTaxShortcut.ts`

**Step 1: Extract shared hooks from TransactionForm**

Currently in `src/components/TransactionForm.tsx`:
- `handleDateKeyDown` (lines 512-527): +/- increment date, t for today
- Tax shortcut logic (lines 342-361 + 363-370): t key in amount field applies tax

Extract these into reusable hooks:

**`src/lib/hooks/useDateShortcuts.ts`:**
```typescript
import { useCallback } from 'react';

export function useDateShortcuts(
  currentDate: string,
  onDateChange: (newDate: string) => void
) {
  const handleDateKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      const current = new Date(currentDate + 'T12:00:00');
      current.setDate(current.getDate() + 1);
      onDateChange(current.toISOString().split('T')[0]);
    } else if (e.key === '-') {
      e.preventDefault();
      const current = new Date(currentDate + 'T12:00:00');
      current.setDate(current.getDate() - 1);
      onDateChange(current.toISOString().split('T')[0]);
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      onDateChange(new Date().toISOString().split('T')[0]);
    }
  }, [currentDate, onDateChange]);

  return { handleDateKeyDown };
}
```

**`src/lib/hooks/useTaxShortcut.ts`:**
```typescript
import { useCallback } from 'react';

export function useTaxShortcut(
  currentAmount: string,
  taxRate: number,
  onAmountChange: (newAmount: string) => void,
  onMessage?: (msg: string) => void
) {
  const applyTax = useCallback(() => {
    if (taxRate <= 0) {
      onMessage?.('No tax rate configured. Set it in Settings.');
      return;
    }
    const currentValue = parseFloat(currentAmount);
    if (isNaN(currentValue) || currentValue === 0) return;
    const withTax = Math.round(currentValue * (1 + taxRate) * 100) / 100;
    onAmountChange(withTax.toFixed(2));
    onMessage?.(`Tax applied: ${currentValue.toFixed(2)} + ${(taxRate * 100).toFixed(1)}% = ${withTax.toFixed(2)}`);
  }, [currentAmount, taxRate, onAmountChange, onMessage]);

  return { applyTax };
}
```

**Step 2: Build InlineEditRow component**

```typescript
interface InlineEditRowProps {
  transaction: AccountTransaction;
  accountGuid: string;
  columnCount: number; // Number of columns (changes during reconciliation mode)
  onSave: (guid: string, data: { post_date: string; description: string; accountGuid: string; amount: string }) => Promise<void>;
  onCancel: () => void;
}
```

The component renders a `<tr>` with editable cells:
- Date: `<input type="date">` with `useDateShortcuts`
- Description: `<DescriptionAutocomplete>` from `src/components/ui/DescriptionAutocomplete.tsx`
- Account: `<AccountSelector>` from `src/components/ui/AccountSelector.tsx`
- Amount: `<input type="text">` with `useTaxShortcut`
- Running balance: Displayed as-is (not editable, but note it will be stale during editing)

**MULTI-SPLIT HANDLING:** The InlineEditRow only handles simple 2-split transactions. Multi-split transactions (>2 splits) should NOT be inline-editable -- they open the full TransactionModal instead. The keyboard handler in Task 6.1 already routes multi-split Enter to the modal.

**RUNNING BALANCE DURING EDIT:** The running balance column shows the pre-edit value with reduced opacity during editing. After save, the ledger refreshes to recalculate running balances.

Keyboard behavior:
- Tab/Shift+Tab: move between fields (Date -> Description -> Account -> Amount)
- Enter: save changes (call `onSave`)
- Escape: cancel edit (call `onCancel`)

**Step 3: Integrate into AccountLedger**

In AccountLedger's row rendering (around line 288), conditionally render:
```tsx
{editingGuid === tx.guid ? (
  <InlineEditRow
    transaction={tx}
    accountGuid={accountGuid}
    columnCount={isReconciling ? 7 : 6}
    onSave={handleInlineSave}
    onCancel={() => setEditingGuid(null)}
  />
) : (
  <tr ... > {/* existing row rendering */} </tr>
)}
```

The `handleInlineSave` function:
```typescript
const handleInlineSave = async (guid: string, data: { ... }) => {
  // Call PUT /api/transactions/{guid}
  // On success, refetch transactions
  setEditingGuid(null);
  await fetchTransactions();
};
```

**Step 4: Update TransactionForm to use shared hooks**

Refactor `TransactionForm.tsx` to use `useDateShortcuts` and `useTaxShortcut` instead of inline handlers. This is optional but recommended for consistency.

**Acceptance criteria:**
- [ ] Enter on a simple (2-split) row opens inline edit
- [ ] Enter on a multi-split row opens the existing TransactionModal
- [ ] Tab moves between Date -> Description -> Account -> Amount
- [ ] +/- in date field increments/decrements date
- [ ] t in date field sets today
- [ ] t in amount field applies tax rate
- [ ] Enter saves changes
- [ ] Escape cancels without saving
- [ ] Running balance shows stale value during edit (with visual indicator)
- [ ] After save, ledger refreshes with correct running balances
- [ ] `npm run build` passes

**Step 5: Commit**

```bash
git add src/components/InlineEditRow.tsx src/components/AccountLedger.tsx src/lib/hooks/useDateShortcuts.ts src/lib/hooks/useTaxShortcut.ts
git commit -m "feat: add inline editable rows to account ledger"
```

### Task 6.3: Add "reviewed" toggle for imported transactions

**DEPENDENCY:** This task requires the `gnucash_web_transaction_meta` table from Task 6.0 (same phase). Task 6.0 must run before Task 6.3.

**Files:**
- Modify: `src/components/AccountLedger.tsx`
- Create: `src/app/api/transactions/[guid]/review/route.ts`

**Step 1: Create review API endpoint**

`src/app/api/transactions/[guid]/review/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';

// PATCH /api/transactions/{guid}/review -- toggle reviewed status
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  const roleResult = await requireRole('edit');
  if (roleResult instanceof NextResponse) return roleResult;

  const { guid } = await params;

  // Upsert: if no meta row exists, create one as reviewed=true (toggle from default)
  const existing = await prisma.$queryRaw<{ reviewed: boolean }[]>`
    SELECT reviewed FROM gnucash_web_transaction_meta WHERE transaction_guid = ${guid}
  `;

  if (existing.length > 0) {
    await prisma.$executeRaw`
      UPDATE gnucash_web_transaction_meta
      SET reviewed = NOT reviewed
      WHERE transaction_guid = ${guid}
    `;
    return NextResponse.json({ reviewed: !existing[0].reviewed });
  } else {
    // No meta row -- create one as reviewed (since manual transactions default to reviewed)
    await prisma.$executeRaw`
      INSERT INTO gnucash_web_transaction_meta (transaction_guid, source, reviewed)
      VALUES (${guid}, 'manual', TRUE)
    `;
    return NextResponse.json({ reviewed: true });
  }
}
```

**Step 2: Add `r` key handler to keyboard navigation**

In `AccountLedger.tsx`, update the `handleTableKeyDown` callback (from Task 6.1) to add the `r` key case:

```typescript
case 'r':
  if (focusedRowIndex >= 0) {
    e.preventDefault();
    toggleReviewed(transactions[focusedRowIndex].guid);
  }
  break;
```

**Step 3: Implement `toggleReviewed` function**

Add to AccountLedger:
```typescript
const toggleReviewed = useCallback(async (transactionGuid: string) => {
  try {
    const res = await fetch(`/api/transactions/${transactionGuid}/review`, {
      method: 'PATCH',
    });
    if (!res.ok) throw new Error('Failed to toggle reviewed status');
    const { reviewed } = await res.json();
    // Update local state to reflect the change without refetching all transactions
    setTransactions(prev => prev.map(tx =>
      tx.guid === transactionGuid ? { ...tx, reviewed } : tx
    ));
  } catch (error) {
    console.error('Failed to toggle reviewed:', error);
  }
}, []);
```

**Step 4: Visual indicators in AccountLedger**

Modify the ledger to:
1. Fetch transaction meta (reviewed status) alongside transactions
2. Unreviewed rows get: amber left border + "Imported" badge
3. `r` key toggles reviewed via API call

The API for fetching transactions (`/api/accounts/{guid}/transactions`) needs to JOIN with `gnucash_web_transaction_meta` to include `reviewed` and `source` fields. Add to the query:
```sql
LEFT JOIN gnucash_web_transaction_meta meta ON meta.transaction_guid = t.guid
```

Return `meta.reviewed` and `meta.source` in the response.

**Step 5: Filter toggle**

Add "Show unreviewed only" toggle button to the toolbar (next to "New Transaction" button):
```tsx
<button
  onClick={() => setShowUnreviewedOnly(prev => !prev)}
  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
    showUnreviewedOnly
      ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
      : 'border-border text-foreground-muted hover:text-foreground'
  }`}
>
  {showUnreviewedOnly ? 'Showing Unreviewed' : 'Show Unreviewed Only'}
</button>
```

**Acceptance criteria:**
- [ ] Unreviewed transactions have amber left border
- [ ] "Imported" badge visible on imported transactions
- [ ] `r` key toggles reviewed status
- [ ] "Show unreviewed only" filter works
- [ ] `npm run build` passes

**Step 6: Commit**

```bash
git add src/components/AccountLedger.tsx src/app/api/transactions/
git commit -m "feat: add reviewed status indicators and toggle for imported transactions"
```

### Task 6.4: Add optimistic locking for transaction edits

**Files:**
- Modify: `src/app/api/transactions/[guid]/route.ts` (PUT handler)
- Modify: `src/components/InlineEditRow.tsx` (pass `enter_date`)

**Purpose:** Prevent lost updates when two users edit the same transaction concurrently. Uses the existing `enter_date` column in GnuCash's `transactions` table as a version marker.

**Step 1: Update PUT handler for optimistic locking**

In `src/app/api/transactions/[guid]/route.ts`, the PUT handler should:

1. Accept an optional `original_enter_date` field in the request body
2. Before updating, check if the transaction's current `enter_date` matches the provided value
3. If it doesn't match, return 409 Conflict

```typescript
export async function PUT(request: NextRequest, { params }: { params: Promise<{ guid: string }> }) {
  const roleResult = await requireRole('edit');
  if (roleResult instanceof NextResponse) return roleResult;

  const { guid } = await params;
  const body = await request.json();
  const { original_enter_date, ...updateData } = body;

  // Optimistic locking: check enter_date hasn't changed since the client read it
  if (original_enter_date) {
    const current = await prisma.$queryRaw<{ enter_date: Date }[]>`
      SELECT enter_date FROM transactions WHERE guid = ${guid}
    `;
    if (current.length === 0) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }
    const currentEnterDate = current[0].enter_date.toISOString();
    if (currentEnterDate !== original_enter_date) {
      return NextResponse.json(
        { error: 'Transaction was modified by another user. Please refresh and try again.' },
        { status: 409 }
      );
    }
  }

  // ... proceed with existing update logic, which also updates enter_date to NOW() ...
}
```

**Step 2: Update InlineEditRow to send `original_enter_date`**

When the InlineEditRow opens (enters edit mode), capture the transaction's `enter_date`. When saving, include it in the PUT request body as `original_enter_date`.

**Step 3: Handle 409 in the frontend**

In `AccountLedger`'s `handleInlineSave`, check for 409 response:
```typescript
if (res.status === 409) {
  // Show toast: "Transaction was modified by another user. Refreshing..."
  await fetchTransactions(); // Refresh to get latest data
  setEditingGuid(null);
  return;
}
```

**Acceptance criteria:**
- [ ] Concurrent edits to same transaction: second save gets 409 Conflict
- [ ] 409 response shows user-friendly message and refreshes the ledger
- [ ] Normal (non-conflicting) edits work as before
- [ ] `npm run build` passes

**Step 4: Commit**

```bash
git add src/app/api/transactions/\[guid\]/route.ts src/components/InlineEditRow.tsx src/components/AccountLedger.tsx
git commit -m "feat: add optimistic locking for concurrent transaction edits"
```

---

## Phase 7: SimpleFin Integration

Depends on Phase 3 (RBAC tables) and Phase 6 (transaction_meta table created in Task 6.0).

### Task 7.1: Add SimpleFin database tables

**Files:**
- Modify: `src/lib/db-init.ts`

**NOTE:** The `gnucash_web_transaction_meta` table is already created in Phase 6 Task 6.0. This task only creates the SimpleFin-specific tables (connections and account map). The `CREATE TABLE IF NOT EXISTS` pattern makes all DDLs idempotent.

**Step 1: Add DDLs for SimpleFin tables**

```typescript
const simpleFinConnectionsTableDDL = `
CREATE TABLE IF NOT EXISTS gnucash_web_simplefin_connections (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL,
    access_url_encrypted TEXT NOT NULL,
    last_sync_at TIMESTAMP,
    sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_guid)
);
`;

const simpleFinAccountMapTableDDL = `
CREATE TABLE IF NOT EXISTS gnucash_web_simplefin_account_map (
    id SERIAL PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES gnucash_web_simplefin_connections(id) ON DELETE CASCADE,
    simplefin_account_id VARCHAR(255) NOT NULL,
    simplefin_account_name VARCHAR(255),
    simplefin_institution VARCHAR(255),
    simplefin_last4 VARCHAR(4),
    gnucash_account_guid VARCHAR(32),
    last_sync_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(connection_id, simplefin_account_id)
);
`;

```

**Key additions from original plan:**
- `book_guid` on connections (scoped to book, not just user)
- `sync_enabled` flag
- `simplefin_institution` and `simplefin_last4` on account map (display purposes)
- `gnucash_account_guid` is nullable (unmapped accounts)
- `last_sync_at` per mapped account (not just per connection)

**Step 2: Execute in createExtensionTables()**

```typescript
await query(simpleFinConnectionsTableDDL);
await query(simpleFinAccountMapTableDDL);
// NOTE: gnucash_web_transaction_meta is already created in Phase 6 Task 6.0
```

**Acceptance criteria:**
- [ ] Both SimpleFin tables created on app startup
- [ ] `npm run build` passes

**Step 3: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add SimpleFin connection and account map tables"
```

### Task 7.2: Create SimpleFin service

**Files:**
- Create: `src/lib/services/simplefin.service.ts`

**Step 1: Implement the SimpleFin API client**

Key functions:
- `claimSetupToken(token: string)`: Decode base64 token -> POST to claim URL -> return access URL
- `fetchAccounts(accessUrl: string, startDate?: number, endDate?: number)`: GET /accounts with Basic Auth extracted from URL
- `encryptAccessUrl(url: string)`: Encrypt using `crypto.createCipheriv` with SESSION_SECRET-derived key
- `decryptAccessUrl(encrypted: string)`: Decrypt

**SimpleFin API details (from protocol spec):**
- Setup token is Base64-encoded claim URL
- POST to claim URL (empty body) returns the access URL (a URL with embedded Basic Auth credentials like `https://user:pass@bridge.simplefin.org/simplefin`)
- GET `{accessUrl}/accounts?start-date={unix}&end-date={unix}` returns account set JSON
- Transaction object: `{ id, posted, amount, description, payee?, memo?, pending? }`
- `amount` is a string like "-45.67" (negative = debit)
- **60-day window limit**: The `start-date` to `end-date` range must be <= 60 days. For longer ranges, make multiple requests.

**Encryption approach (with random salt):**

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
}

export function encryptAccessUrl(url: string): string {
  const secret = process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_12345';
  const salt = randomBytes(16); // Random salt per encryption
  const key = deriveKey(secret, salt);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(url, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  // Format: salt:iv:authTag:encrypted
  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptAccessUrl(encrypted: string): string {
  const secret = process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_12345';
  const [saltHex, ivHex, authTagHex, data] = encrypted.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const key = deriveKey(secret, salt);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

**NOTE on salt:** Each encryption generates a random 16-byte salt stored alongside the ciphertext in `salt:iv:authTag:encrypted` format. This prevents identical access URLs from producing identical ciphertexts and defends against precomputed key attacks. The v2 plan used a hardcoded `'simplefin-salt'` string which is cryptographically weak.

**Error handling for revoked/expired access:**
```typescript
export class SimpleFinAccessRevokedError extends Error {
  constructor() {
    super('SimpleFin access has been revoked. Please reconnect.');
    this.name = 'SimpleFinAccessRevokedError';
  }
}
```

When fetching accounts, check for HTTP 403 (revoked) and throw `SimpleFinAccessRevokedError`. The API route should catch this and update the connection status.

**Acceptance criteria:**
- [ ] `claimSetupToken()` decodes base64 and POSTs to claim URL
- [ ] `fetchAccounts()` makes authenticated GET request
- [ ] 60-day chunking logic exists for long date ranges
- [ ] Encryption/decryption roundtrips correctly
- [ ] Encryption uses random salt (not hardcoded)
- [ ] Encrypted format is `salt:iv:authTag:encrypted` (4 colon-separated segments)
- [ ] Revoked access (403) throws meaningful error
- [ ] `npm run build` passes

**Step 2: Commit**

```bash
git add src/lib/services/simplefin.service.ts
git commit -m "feat: add SimpleFin Bridge API client service"
```

### Task 7.3: Create SimpleFin API routes

**Files:**
- Create: `src/app/api/simplefin/connect/route.ts` -- POST: claim token, store connection
- Create: `src/app/api/simplefin/accounts/route.ts` -- GET: list SimpleFin accounts with mapping status
- Create: `src/app/api/simplefin/accounts/map/route.ts` -- PUT: update account mapping
- Create: `src/app/api/simplefin/sync/route.ts` -- POST: trigger manual sync
- Create: `src/app/api/simplefin/disconnect/route.ts` -- DELETE: remove connection
- Create: `src/app/api/simplefin/status/route.ts` -- GET: connection status + last sync

**Role requirements:**
- `status` (GET) -> `requireRole('readonly')`
- `accounts` (GET) -> `requireRole('readonly')`
- `connect`, `disconnect`, `accounts/map`, `sync` -> `requireRole('admin')`

**Key behaviors:**

`POST /api/simplefin/connect`:
- Accepts `{ setupToken: string }`
- Calls `claimSetupToken(token)` to exchange for access URL
- Encrypts access URL
- Stores in `gnucash_web_simplefin_connections`
- Returns `{ success: true }`
- If token is invalid or already claimed, returns 400

`POST /api/simplefin/sync`:
- Triggers sync for the active book's connection
- If no Redis/worker: runs sync directly (same pattern as price refresh in `settings/schedules/run-now/route.ts`)
- If Redis available: enqueues a `sync-simplefin` job
- Returns progress/status

**Error handling:**
- If access revoked (403 from SimpleFin), mark connection as inactive and return error to user
- If network timeout, return 502 with retry suggestion

**Acceptance criteria:**
- [ ] Setup token exchange works end-to-end
- [ ] Account mapping CRUD works
- [ ] Manual sync triggers and returns results
- [ ] Disconnect removes stored credentials
- [ ] All routes have proper RBAC
- [ ] `npm run build` passes

**Step 1: Commit**

```bash
git add src/app/api/simplefin/
git commit -m "feat: add SimpleFin API routes (connect, sync, map, disconnect)"
```

### Task 7.4: Create transaction sync engine

**Files:**
- Create: `src/lib/services/simplefin-sync.service.ts`

**Step 1: Implement sync logic**

Key function: `syncSimpleFin(connectionId: number, bookGuid: string)`

For each mapped account:
1. Fetch transactions from SimpleFin since `last_sync_at` (using 60-day chunks if the gap is large)
2. **Dedup strategy**: Query existing transactions by date + amount + description on the mapped account. Use `gnucash_web_transaction_meta.simplefin_transaction_id` for exact match (SimpleFin provides unique transaction IDs).
3. For new transactions:
   - **Category guessing**: Query historical transactions on this GnuCash account with similar description (case-insensitive LIKE), pick the most frequent counterpart account. If < 2 matches, use `Imbalance-{currency}` account and mark confidence as 'low'.
   - Create GnuCash transaction + 2 splits:
     - Split 1: mapped bank account (positive amount = debit, negative = credit)
     - Split 2: guessed destination account (opposite sign)
   - Insert `gnucash_web_transaction_meta` with `source='simplefin'`, `reviewed=false`, `simplefin_transaction_id={id}`
4. Update `last_sync_at` on the account map row and connection

**60-day chunking:**
```typescript
function* dateChunks(startDate: Date, endDate: Date, maxDays = 60): Generator<{ start: number; end: number }> {
  const msPerDay = 86400000;
  let current = startDate.getTime();
  const end = endDate.getTime();

  while (current < end) {
    const chunkEnd = Math.min(current + maxDays * msPerDay, end);
    yield {
      start: Math.floor(current / 1000),
      end: Math.floor(chunkEnd / 1000),
    };
    current = chunkEnd;
  }
}
```

**Pending transactions:** SimpleFin marks some transactions as `pending: true`. Strategy: import them but add a note in the transaction memo. On next sync, if the transaction ID still exists but is no longer pending, update the memo.

**Return value:**
```typescript
interface SyncResult {
  accountsProcessed: number;
  transactionsImported: number;
  transactionsSkipped: number; // dedup
  errors: { account: string; error: string }[];
}
```

**Acceptance criteria:**
- [ ] Sync imports new transactions correctly
- [ ] Dedup prevents duplicate imports (by SimpleFin transaction ID)
- [ ] Category guessing picks most frequent counterpart account
- [ ] Low-confidence guesses use Imbalance account
- [ ] 60-day chunking works for large gaps
- [ ] `gnucash_web_transaction_meta` populated for all imports
- [ ] `npm run build` passes

**Step 2: Commit**

```bash
git add src/lib/services/simplefin-sync.service.ts
git commit -m "feat: add SimpleFin transaction sync engine with category guessing"
```

### Task 7.5: Create Connections settings page

**Files:**
- Create: `src/app/(main)/settings/connections/page.tsx`
- Modify: `src/components/Layout.tsx` (add nav link under Settings if needed)

**Step 1: Build the connections UI**

Before connection (no stored connection for active book):
- Explanation of SimpleFin Bridge, link to simplefin.org/bridge
- Setup steps (numbered list)
- Token input + "Connect" button

After connection (connection exists):
- Status card: Connected, last sync time
- "Manage bank connections on SimpleFin" link (external, `target="_blank"`, `rel="noopener"`)
- Account mapping table:
  - Column 1: SimpleFin account (institution + name + last 4)
  - Column 2: GnuCash account dropdown (using `AccountSelector`)
  - Column 3: Last synced time
  - Column 4: Status (mapped/unmapped)
- "Sync Now" button (with loading spinner)
- "Disconnect" button (with confirmation dialog)

**Step 2: Handle sync progress**

The "Sync Now" button calls `POST /api/simplefin/sync` and displays results:
- "Imported 5 transactions, skipped 12 duplicates"
- Any errors displayed in a collapsible error list

**Acceptance criteria:**
- [ ] Can enter setup token and connect
- [ ] Shows connected status with last sync time
- [ ] Account mapping table shows all SimpleFin accounts
- [ ] Can map SimpleFin accounts to GnuCash accounts
- [ ] Manual sync works and shows results
- [ ] Can disconnect (with confirmation)
- [ ] `npm run build` passes

**Step 3: Commit**

```bash
git add src/app/\(main\)/settings/connections/
git commit -m "feat: add SimpleFin connections settings page with account mapping"
```

### Task 7.6: Integrate SimpleFin sync into scheduled jobs

**Files:**
- Modify: `src/app/(main)/settings/page.tsx` (add checkbox)
- Modify: `worker.ts` (add `sync-simplefin` job handler)
- Modify: `src/lib/queue/queues.ts` (add scheduling function)
- Modify: `src/app/api/settings/schedules/run-now/route.ts` (trigger sync after prices)

**IMPORTANT: Worker process and auth**

The worker process (`worker.ts`) runs as a separate Node.js process via BullMQ. It does NOT go through Next.js middleware and has no concept of user sessions. For SimpleFin sync in the worker:
- The connection and access URL are stored in the database
- The worker reads the connection directly from the database (no auth check needed -- it's a trusted process)
- The sync function accepts `connectionId` and `bookGuid` directly

**Step 1: Add SimpleFin sync toggle to settings page**

Add a checkbox in the schedule settings section of `src/app/(main)/settings/page.tsx`:
```tsx
<label className="flex items-center gap-2 text-sm text-foreground">
  <input
    type="checkbox"
    checked={simplefinSyncEnabled}
    onChange={(e) => updateSimplefinSync(e.target.checked)}
    className="rounded border-border"
  />
  Sync SimpleFin transactions with each refresh
</label>
```

**Step 2: Add worker job handler**

In `worker.ts`, add a new case:
```typescript
case 'sync-simplefin': {
  const { syncAllConnections } = await import('./src/lib/services/simplefin-sync.service');
  const result = await syncAllConnections();
  console.log('SimpleFin sync results:', result);
  break;
}
```

**Step 3: Trigger sync after price refresh**

In `src/app/api/settings/schedules/run-now/route.ts`, after the price refresh job, check if SimpleFin sync is enabled and enqueue a `sync-simplefin` job.

**Acceptance criteria:**
- [ ] Settings page has SimpleFin sync toggle
- [ ] Worker can process `sync-simplefin` jobs
- [ ] Manual "Run Now" triggers both price refresh and SimpleFin sync (if enabled)
- [ ] Worker process handles sync without Next.js middleware auth
- [ ] `npm run build` passes

**Step 4: Commit**

```bash
git add src/app/\(main\)/settings/page.tsx src/app/api/settings/schedules/run-now/route.ts worker.ts src/lib/queue/
git commit -m "feat: integrate SimpleFin sync into scheduled jobs and worker"
```

---

## Phase 8: Invitation System

Depends on Phase 3 (RBAC tables -- invitations table already created in Task 3.1).

### Task 8.1: Create invitation API routes

**Files:**
- Create: `src/app/api/books/[guid]/invitations/route.ts` -- GET (list), POST (create)
- Create: `src/app/api/invitations/[code]/route.ts` -- GET (view invitation details), PUT (accept), DELETE (revoke)
- Create: `src/app/api/invitations/[code]/accept/route.ts` -- POST (accept invitation)

**Step 1: Implement invitation routes**

`POST /api/books/{guid}/invitations` (admin only):
- Accepts `{ role: 'readonly' | 'edit', expiresInHours: number, maxUses: number }`
- Generates cryptographically random 64-char code
- Stores in `gnucash_web_invitations`
- Returns `{ code, link: '/invite/{code}' }`

`GET /api/books/{guid}/invitations` (admin only):
- Lists all invitations for the book
- Includes: code, role, created_at, expires_at, use_count, max_uses, is_revoked

`GET /api/invitations/{code}` (authenticated, any role):
- Returns invitation details (book name, role, expiry) without accepting
- Used to show the "You've been invited" page

`POST /api/invitations/{code}/accept` (authenticated):
- Validates: not expired, not revoked, use_count < max_uses
- Calls `grantRole(userId, bookGuid, role, createdBy)`
- Increments `use_count`, sets `used_by` and `used_at`
- Returns `{ bookGuid, role }`

`DELETE /api/invitations/{code}` (admin of the book):
- Sets `is_revoked = true`, `revoked_by`, `revoked_at`

**Security:**
- Invitation codes are generated with `crypto.randomBytes(32).toString('hex')` (64 hex chars)
- Expired invitations return 410 Gone
- Revoked invitations return 410 Gone
- Max uses exceeded returns 410 Gone
- Admin cannot be granted via invitation (max role is 'edit')

**Acceptance criteria:**
- [ ] Create invitation returns unique code
- [ ] Accept invitation grants role and increments use count
- [ ] Expired/revoked invitations return 410
- [ ] Cannot grant admin via invitation
- [ ] All routes have proper RBAC
- [ ] `npm run build` passes

**Step 2: Commit**

```bash
git add src/app/api/books/ src/app/api/invitations/
git commit -m "feat: add invitation system API (create, list, accept, revoke)"
```

### Task 8.2: Create invitation management UI

**Files:**
- Create: `src/app/(main)/settings/users/page.tsx`
- Create: `src/components/InvitationManager.tsx`
- Create: `src/app/(main)/invite/[code]/page.tsx` (public-ish invite acceptance page)

**Step 1: Admin-only user management page**

`src/app/(main)/settings/users/page.tsx`:
- Current users with roles for the active book (table)
- Role change dropdown per user (admin only)
- Remove user button
- Create invitation form:
  - Role picker (readonly / edit)
  - Expiry (24h, 7d, 30d, never)
  - Max uses (1, 5, unlimited)
- Active invitations list:
  - Code (truncated), role, created, expires, uses, status
  - "Copy Link" button
  - "Revoke" button

**Step 2: Invite acceptance page**

`src/app/(main)/invite/[code]/page.tsx`:
- Fetches invitation details from `GET /api/invitations/{code}`
- Shows: book name, role being granted, who invited, expiry
- "Accept Invitation" button
- On accept: calls `POST /api/invitations/{code}/accept`, then `refreshBooks()` + `switchBook(bookGuid)` + redirect to `/accounts`

**NOTE:** The invite acceptance page is inside `(main)` route group, so the user must be authenticated. If they're not logged in, the middleware redirects to `/login?redirect=/invite/{code}`, and after login they'll be redirected back to accept.

**Acceptance criteria:**
- [ ] Admin can see current users and their roles
- [ ] Admin can create invitations with role/expiry/max-uses
- [ ] Copy link button works
- [ ] Revoke button works
- [ ] Invite acceptance page shows invitation details
- [ ] Accepting invitation grants access and redirects to accounts
- [ ] Non-admin users see "Access Denied" on the user management page
- [ ] `npm run build` passes

**Step 3: Commit**

```bash
git add src/app/\(main\)/settings/users/ src/components/InvitationManager.tsx src/app/\(main\)/invite/
git commit -m "feat: add invitation management UI for book admins"
```

---

## Cross-Cutting Concerns

### Database Backup Considerations

Before running Phase 3 (RBAC schema changes), the implementer should:
1. Document that `CREATE TABLE IF NOT EXISTS` and `ON CONFLICT DO NOTHING` make the migration idempotent
2. No existing tables are modified (only new tables added)
3. The backfill query uses `ON CONFLICT DO NOTHING` so it's safe to run multiple times

### CORS

The middleware does not add CORS headers. If the app is accessed cross-origin (e.g., embedded in an iframe), CORS would need to be added. For now, this is NOT needed since the app is a standalone SPA.

### Rollback Strategy

All new tables use `CREATE TABLE IF NOT EXISTS`. To rollback:
1. Drop new tables: `DROP TABLE IF EXISTS gnucash_web_invitations, gnucash_web_book_permissions, gnucash_web_roles, gnucash_web_simplefin_account_map, gnucash_web_simplefin_connections, gnucash_web_transaction_meta CASCADE;`
2. Remove `src/middleware.ts`
3. Revert route handler changes

### Error Handling Patterns

All new API routes should follow the existing pattern:
```typescript
try {
  // ... handler logic
} catch (error) {
  console.error('Descriptive error message:', error);
  return NextResponse.json({ error: 'User-facing error message' }, { status: 500 });
}
```

---

## Verification Checklist

After all phases:

**Phase 1 (Tax Fix):**
- [ ] Tax rate input allows typing "6.75" without cursor jumping
- [ ] Help text shows "T" key (not "Ctrl + T")

**Phase 2 (Middleware):**
- [ ] Unauthenticated requests to `/api/accounts` return 401
- [ ] Unauthenticated visits to `/accounts` redirect to `/login?redirect=/accounts`
- [ ] After login, user redirected back to original page
- [ ] `/` (landing page) is accessible without auth
- [ ] `/login` is accessible without auth
- [ ] Session config is in shared file (`src/lib/session-config.ts`), NOT duplicated

**Phase 3 (RBAC):**
- [ ] `readonly` user can view but not edit
- [ ] `edit` user can create/edit/delete transactions
- [ ] `admin` user can manage books and settings
- [ ] Existing users have admin on all existing books
- [ ] Book-related endpoints use `requireAuth()` (not `requireRole`) where appropriate
- [ ] `GET /api/books` returns empty array for users with no permissions (not 403)

**Phase 4 (Landing):**
- [ ] Landing page shows feature cards and login CTA

**Phase 5 (Onboarding):**
- [ ] New user with no books sees onboarding page
- [ ] Book creation from template works (personal, business, non-profit)
- [ ] Creating user gets admin on the new book
- [ ] Template listing API uses `requireAuth()` (not `requireRole`)

**Phase 6 (Inline Edit):**
- [ ] Account ledger supports Up/Down/Enter/Escape keyboard navigation
- [ ] Delete/Backspace opens confirmation dialog
- [ ] Enter on a simple row opens inline edit
- [ ] Enter on a multi-split row opens modal (not inline edit)
- [ ] Tab moves between fields in inline edit
- [ ] Date shortcuts (+/-/t) work in inline edit
- [ ] `r` key toggles reviewed status (added in Task 6.3, not 6.1)
- [ ] Optimistic locking prevents lost concurrent edits (409 on conflict)

**Phase 7 (SimpleFin):**
- [ ] SimpleFin setup token can be claimed and stored
- [ ] SimpleFin account mapping works
- [ ] Manual sync imports transactions with review flags
- [ ] Category guessing assigns counterpart accounts
- [ ] 60-day chunking works for large sync gaps
- [ ] Worker process can run SimpleFin sync
- [ ] Encryption uses random salt (format: `salt:iv:authTag:encrypted`)

**Phase 8 (Invitations):**
- [ ] Invitation links can be created with role/expiry
- [ ] Invitation links can be accepted by authenticated users
- [ ] Invitations can be revoked by admins
- [ ] Cannot grant admin role via invitation

**Global:**
- [ ] `npm run build` passes with zero errors
- [ ] `npm run lint` passes
- [ ] No regressions in existing functionality
