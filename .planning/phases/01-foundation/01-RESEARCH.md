# Phase 01: Foundation - Research

**Researched:** 2026-01-24
**Domain:** Prisma ORM & Testing Infrastructure
**Confidence:** HIGH

## Summary

This research focuses on migrating GnuCash Web from direct `pg` queries to Prisma ORM and establishing a robust testing infrastructure using Vitest and React Testing Library. 

The GnuCash PostgreSQL schema is a legacy schema that uses GUIDs (strings) for primary keys and represents numeric values as fractions (numerator/denominator pairs). Prisma's introspection capabilities are well-suited for this, though some manual configuration will be required to maintain clean naming conventions and handle specific numeric logic.

Testing in Next.js 16 with React 19 is best served by Vitest, which offers high compatibility with the App Router and modern React features.

**Primary recommendation:** Use Prisma Client with a custom extension to handle the conversion of GnuCash fraction-based numeric fields to decimals automatically, and implement Vitest for both unit and API route testing.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `prisma` | ^6.0.0 | ORM | Industry standard for TypeScript; excellent introspection for existing schemas. |
| `@prisma/client` | ^6.0.0 | DB Client | Type-safe database access generated from the schema. |
| `vitest` | ^3.0.0 | Test Runner | Faster and more modern alternative to Jest; native ESM support. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@testing-library/react` | ^16.0.0 | UI Testing | Testing React components in a DOM-like environment. |
| `jest-mock-extended` | ^4.0.0 | Mocking | Mocking the Prisma Client for isolated unit tests. |
| `jsdom` | ^25.0.0 | Test Env | Required by Vitest for UI testing. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `prisma` | `drizzle-orm` | Drizzle is closer to SQL but Prisma's introspection is more mature for legacy schemas like GnuCash. |
| `vitest` | `jest` | Jest requires more configuration for ESM and Next.js App Router. |

**Installation:**
```bash
npm install prisma --save-dev
npm install @prisma/client
npm install vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/dom vite-tsconfig-paths --save-dev
```

## Architecture Patterns

### Recommended Project Structure
```
prisma/
├── schema.prisma    # Introspected GnuCash schema
src/
├── lib/
│   ├── prisma.ts    # Singleton Prisma Client
├── __tests__/       # Global tests
│   ├── unit/        # Logic tests
│   ├── api/         # Route handler tests
└── components/
    └── __tests__/   # Colocated component tests
```

### Pattern 1: Prisma Singleton with Extensions
Use a singleton pattern to prevent exhausting database connections and use Prisma Extensions to automate the fraction-to-decimal conversion.

**Example:**
```typescript
// Source: https://www.prisma.io/docs/orm/prisma-client/client-extensions
import { PrismaClient } from '@prisma/client'

const prismaClientSingleton = () => {
  return new PrismaClient().$extends({
    result: {
      split: {
        value_decimal: {
          needs: { value_num: true, value_denom: true },
          compute(split) {
            // Re-use current toDecimal logic here
            return toDecimal(split.value_num, split.value_denom)
          },
        },
      },
    },
  })
}

// Global variable handling for HMR in Next.js
declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>
}

const prisma = globalThis.prisma ?? prismaClientSingleton()
export default prisma
if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma
```

### Pattern 2: API Route Testing
Import the route handler and mock the `NextRequest`.

**Example:**
```typescript
// Source: https://nextjs.org/docs/app/building-your-application/testing/vitest
import { GET } from '@/app/api/accounts/route'
import { NextRequest } from 'next/server'

test('GET /api/accounts returns status 200', async () => {
  const req = new NextRequest('http://localhost/api/accounts')
  const res = await GET(req)
  expect(res.status).toBe(200)
})
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Mocking DB | Custom mocks | `jest-mock-extended` | Correctly types deeply nested Prisma methods. |
| Type Generation | Manual interfaces | Prisma Client | Automatically syncs with DB schema changes. |
| GUID Gen | `uuid` library | Prisma `@default(uuid())` | Built-in support for standard patterns. |

## Common Pitfalls

### Pitfall 1: BigInt Serialization
**What goes wrong:** `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`.
**Why it happens:** GnuCash uses `INT8` (BigInt) for many fields.
**How to avoid:** Use a global middleware or custom transformer to convert BigInts to strings in API responses.

### Pitfall 2: Database Views
**What goes wrong:** `prisma db pull` does not introspect views by default (except for specific versions/configs).
**Why it happens:** GnuCash-Web relies on a custom `account_hierarchy` view.
**How to avoid:** Keep `db-init.ts` for view creation or use Prisma's `views` preview feature if supported.

### Pitfall 3: Case Sensitivity
**What goes wrong:** Prisma might generate model names in PascalCase that don't match GnuCash's snake_case table names.
**Why it happens:** Prisma convention.
**How to avoid:** Always verify `@@map` attributes after introspection.

## Code Examples

### Custom BigInt Serialization
```typescript
// Add to a global layout or utility
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `pg` queries | Prisma ORM | Phase 01 | Type-safety, easier relations, less boilerplate. |
| Jest | Vitest | Phase 01 | Faster execution, better Vite/Next integration. |

## Sources

### Primary (HIGH confidence)
- [Prisma Docs - Introspection](https://www.prisma.io/docs/orm/prisma-schema/introspection)
- [Next.js Docs - Testing with Vitest](https://nextjs.org/docs/app/building-your-application/testing/vitest)
- [Prisma Docs - Unit Testing](https://www.prisma.io/docs/orm/prisma-client/testing/unit-testing)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Standard Next.js/Prisma setup.
- Architecture: HIGH - Proven patterns for Next.js App Router.
- Pitfalls: MEDIUM - GnuCash specific schema quirks are known but need validation during `db pull`.

**Research date:** 2026-01-24
**Valid until:** 2026-02-24
