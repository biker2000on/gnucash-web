# Phase 02: Enhanced Transaction Journal - Research

**Researched:** 2026-01-24
**Domain:** GnuCash Transactions, Splits, Prisma Mapping, Double-Entry Logic
**Confidence:** HIGH

## Summary

This phase focuses on upgrading the transaction journal from a read-only list to a full CRUD-capable component with advanced filtering and reconciliation support. Research focused on the GnuCash SQL schema for `transactions` and `splits`, ensuring double-entry integrity, and mapping these to Prisma ORM.

**Primary recommendation:** Use Prisma's `@map` and `@@map` attributes to bridge the gap between GnuCash's snake_case database and the application's camelCase TypeScript environment, and implement all transaction writes within Prisma `$transaction` blocks to ensure splits always balance.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Prisma | 6.x | ORM | Type-safe DB access for complex relationships |
| React | 19.x | UI Library | Current project standard |
| Next.js | 16.x | Framework | Current project standard |
| PostgreSQL | 14+ | Database | GnuCash's standard SQL backend |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `date-fns` | 4.x | Date manipulation | Filtering transactions by period |
| `crypto` | Built-in | GUID generation | Generating 32-char hex GUIDs |
| `BigInt` | Native | Numeric handling | Safe handling of GnuCash fractions |

**Installation:**
```bash
npm install @prisma/client date-fns
npm install -D prisma
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── app/api/
│   ├── transactions/      # CRUD for transaction headers
│   └── splits/            # Split-specific updates (reconciliation)
├── lib/
│   ├── gnucash/
│   │   ├── guid.ts        # GUID generation utility
│   │   ├── math.ts        # Fraction/BigInt arithmetic
│   │   └── schema.ts      # Shared validation schemas (Zod)
└── components/
    ├── TransactionForm/   # Multi-split entry form
    └── Reconciliation/    # Account reconciliation tools
```

### Pattern 1: Prisma Mapping for GnuCash GUIDs
GnuCash uses 32-character hex strings for GUIDs. Prisma should map these as `String` with `@db.Char(32)`.

```prisma
model Transaction {
  guid         String   @id @map("guid") @db.Char(32)
  currencyGuid String   @map("currency_guid") @db.Char(32)
  num          String   @map("num")
  postDate     DateTime @map("post_date")
  enterDate    DateTime @map("enter_date")
  description  String?  @map("description")
  splits       Split[]

  @@map("transactions")
}

model Split {
  guid           String      @id @map("guid") @db.Char(32)
  txGuid         String      @map("tx_guid") @db.Char(32)
  accountGuid    String      @map("account_guid") @db.Char(32)
  memo           String      @map("memo")
  action         String      @map("action")
  reconcileState String      @map("reconcile_state") @db.Char(1)
  reconcileDate  DateTime    @map("reconcile_date")
  valueNum       BigInt      @map("value_num")
  valueDenom     BigInt      @map("value_denom")
  quantityNum    BigInt      @map("quantity_num")
  quantityDenom  BigInt      @map("quantity_denom")
  transaction    Transaction @relation(fields: [txGuid], references: [guid], onDelete: Cascade)

  @@map("splits")
}
```

### Pattern 2: Atomic Transaction Updates
Never update splits individually via separate API calls. Always wrap transaction and split updates in a single database transaction.

```typescript
// Source: GnuCash API Pattern
const result = await prisma.$transaction(async (tx) => {
  // 1. Update/Delete existing splits
  // 2. Add new splits
  // 3. Update transaction header
  // 4. Validate that sum(splits) == 0
});
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| UUIDs | `uuid` v4 | `crypto.randomBytes(16).toString('hex')` | GnuCash requires 32-char hex strings without hyphens. |
| Decimal Math | Floating point | `BigInt` or `decimal.js` | GnuCash stores values as fractions; float math causes penny errors. |
| GUID format | Custom regex | GnuCash-compatible hex | Ensure interoperability with GnuCash Desktop. |

## Common Pitfalls

### Pitfall 1: Incorrect GUID Format
**What goes wrong:** GnuCash Desktop fails to open the file or ignores entries.
**Why it happens:** GnuCash expects lowercase 32-character hex strings. standard UUIDs (with hyphens) are rejected.
**How to avoid:** Use a dedicated `generateGuid()` utility that produces exactly 32 hex characters.

### Pitfall 2: Split Imbalance
**What goes wrong:** Database becomes "corrupt" from a bookkeeping perspective.
**Why it happens:** Updating one side of a double-entry transaction without updating the other.
**How to avoid:** Enforce zero-sum validation in the `prisma.$transaction` block and on the frontend.

### Pitfall 3: Reconcile States
**What goes wrong:** Transactions accidentally unreconciled.
**Why it happens:** Misunderstanding 'n', 'c', 'y' states.
**How to avoid:** 'y' (reconciled) transactions should be "locked" in the UI; changing them requires explicit unlocking/unreconciling.

## Code Examples

### GUID Generation
```typescript
import crypto from 'crypto';

export function generateGnucashGuid(): string {
  return crypto.randomBytes(16).toString('hex');
}
```

### Fraction-to-Decimal Conversion
```typescript
export function toDecimal(num: bigint, denom: bigint): number {
  return Number(num) / Number(denom);
}

export function fromDecimal(val: number, denom: number = 100): { num: bigint; denom: bigint } {
  return {
    num: BigInt(Math.round(val * denom)),
    denom: BigInt(denom)
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct SQL with `pg` | Prisma ORM | Phase 1 | Type-safety and easier relation management |
| Hardcoded Dates | Dynamic filtering | Phase 2 | User-configurable reporting periods |

## Open Questions

1. **Denominators:** While most accounts use 100, some (investments) use 10000 or more. How should the UI determine the "standard" denominator for a new transaction?
   - *Recommendation:* Fetch the `fraction` from the `commodities` table for the transaction's currency or the account's commodity.
2. **Reconciliation Date:** GnuCash Desktop sets this to the date the reconciliation was *completed*. Should we allow manual entry?
   - *Recommendation:* Default to current timestamp when marking as 'y'.

## Sources

### Primary (HIGH confidence)
- [GnuCash Wiki: SQL](https://wiki.gnucash.org/wiki/SQL) - Table definitions and logic.
- [Prisma Documentation: Models](https://www.prisma.io/docs/orm/prisma-schema/data-model/models) - Mapping attributes.

### Secondary (MEDIUM confidence)
- [GnuCash Source (guid.c)](https://github.com/Gnucash/gnucash/blob/master/libgnucash/common/guid.c) - GUID implementation details.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH
- Architecture: HIGH
- Pitfalls: HIGH

**Research date:** 2026-01-24
**Valid until:** 2026-02-23
