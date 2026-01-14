# Coding Conventions

**Analysis Date:** 2026-01-14

## Naming Patterns

**Files:**
- PascalCase.tsx for React components (`AccountHierarchy.tsx`, `TransactionModal.tsx`)
- camelCase.ts for utilities and non-component modules (`db.ts`, `format.ts`, `validation.ts`)
- route.ts for Next.js API handlers
- page.tsx, layout.tsx for Next.js pages/layouts

**Functions:**
- camelCase for all functions (`fetchMoreTransactions`, `handleRowClick`)
- No special prefix for async functions
- handle{Event} for event handlers (`handleToggle`, `handleFinish`, `handleCloseModal`)
- get{Thing} for getters (`getReconcileIcon`, `getAggregatedBalances`)

**Variables:**
- camelCase for variables (`transactions`, `filterText`, `expandedNodes`)
- UPPER_SNAKE_CASE for constants (none observed in codebase)
- No underscore prefix for private members

**Types:**
- PascalCase for interfaces, no I prefix (`Account`, `Transaction`, `Split`)
- PascalCase for type aliases (`SortKey`, `TransactionFilters`)
- Props interfaces: `{ComponentName}Props` (`AccountLedgerProps`, `TransactionModalProps`)

## Code Style

**Formatting:**
- No Prettier configuration (uses default ESLint formatting)
- 4-space indentation in most files
- Single quotes for strings in JSX
- Semicolons required

**Linting:**
- ESLint 9.x with flat config (`eslint.config.mjs`)
- Extends: `eslint-config-next/core-web-vitals`, `eslint-config-next/typescript`
- Run: `npm run lint`

## Import Organization

**Order:**
1. React imports (`'react'`, hooks from react)
2. Next.js imports (`'next/link'`, `'next/navigation'`)
3. External packages (none heavily used beyond React/Next)
4. Internal modules (`@/lib/*`, `@/components/*`)
5. Relative imports (within same directory)

**Grouping:**
- No enforced blank lines between groups
- Type imports mixed with value imports

**Path Aliases:**
- `@/*` maps to `./src/*` (configured in `tsconfig.json`)
- Used consistently: `@/lib/types`, `@/components/Layout`, `@/lib/format`

## Error Handling

**Patterns:**
- Try/catch wrapping async operations
- console.error for logging errors in catch blocks
- Return error responses from API routes with status codes

**Error Types:**
- Throw Error with message in library code
- Return `{ error: string }` with status from API routes
- Set local `error` state in components

**API Error Responses:**
```typescript
return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 });
return NextResponse.json({ errors: validation.errors }, { status: 400 });
```

## Logging

**Framework:**
- console.log, console.error (no structured logging)

**Patterns:**
- console.log for success messages in db-init.ts
- console.error for all errors across codebase
- No log levels beyond log/error

**When Logged:**
- Database initialization events
- API request errors
- Client-side fetch errors

## Comments

**When to Comment:**
- JSDoc `@openapi` annotations for Swagger documentation
- Inline comments for complex SQL queries
- Minimal comments elsewhere

**JSDoc/TSDoc:**
- OpenAPI annotations on API route handlers
- Type documentation via interfaces
- Function documentation sparse

**TODO Comments:**
- None found in codebase (clean)

## Function Design

**Size:**
- Components can be large (AccountHierarchy 350 lines)
- Helper functions extracted within component files
- API handlers are self-contained

**Parameters:**
- Object destructuring for props in components
- Options objects for API query parameters
- Array destructuring for hooks (`const [state, setState]`)

**Return Values:**
- Explicit returns in non-void functions
- JSX returned from components
- NextResponse.json() from API routes

## Module Design

**Exports:**
- Default export for React components (`export default function Component`)
- Named exports for utilities (`export function formatCurrency`, `export const query`)
- Named exports for types (`export interface Account`)

**Barrel Files:**
- `src/components/filters/index.ts` re-exports filter components
- No other barrel files

**Component Pattern:**
```tsx
"use client";  // Client directive when needed

import { ... } from 'react';
import { ... } from '@/lib/...';

interface Props { ... }

export default function ComponentName({ ...props }: Props) {
    // hooks
    // handlers
    // render
    return (...);
}
```

## React Patterns

**State Management:**
- useState for local component state
- useCallback for memoized handlers
- useMemo for computed values
- useRef for DOM refs and stable references
- useEffect for side effects and subscriptions

**Props:**
- Destructuring in function signature
- Optional props with `?` in interface
- Default values via `= defaultValue` in destructuring

**Client Components:**
- `"use client"` directive at top of file
- Used for interactive components with hooks/state

---

*Convention analysis: 2026-01-14*
*Update when patterns change*
