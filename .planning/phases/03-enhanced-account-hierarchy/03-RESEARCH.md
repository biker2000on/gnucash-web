# Phase 03: Enhanced Account Hierarchy - Research

**Researched:** 2026-01-24
**Domain:** Account CRUD, Drag-Drop Hierarchy, Account Type Aggregations
**Confidence:** HIGH

## Summary

This phase focuses on extending the account hierarchy from read-only viewing to full CRUD operations with drag-drop reorganization. The GnuCash schema stores accounts in a flat table with parent_guid references, making hierarchy manipulation straightforward. Key challenges include maintaining data integrity (no circular references), handling account type constraints, and implementing smooth drag-drop UX.

**Primary recommendation:** Use React DnD or @dnd-kit for drag-drop functionality, implement server-side validation for hierarchy changes, and add summary cards using aggregated account type queries.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@dnd-kit/core` | ^6.x | Drag-drop | Modern, accessible, touch-friendly DnD library |
| `@dnd-kit/sortable` | ^8.x | Tree sorting | Built-in tree/list sorting capabilities |
| Prisma | ^6.x | ORM | Type-safe DB operations |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@dnd-kit/utilities` | ^3.x | DnD helpers | CSS transform utilities |
| `zod` | ^3.x | Validation | Account form validation |

**Installation:**
```bash
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities zod
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── app/api/
│   └── accounts/
│       ├── route.ts           # GET list, POST create
│       └── [guid]/
│           ├── route.ts       # GET/PUT/DELETE single
│           └── move/route.ts  # PUT to change parent
├── components/
│   ├── AccountHierarchy/
│   │   ├── DraggableNode.tsx  # DnD-enabled account node
│   │   └── DropZone.tsx       # Valid drop targets
│   ├── AccountForm/
│   │   ├── AccountForm.tsx    # Create/edit form
│   │   └── AccountTypeSelect.tsx
│   └── AccountSummary/
│       └── SummaryCards.tsx   # Type aggregations
```

### Pattern 1: Account CRUD with Validation
```typescript
// Create account with GnuCash-compatible GUID
const createAccount = async (data: CreateAccountInput) => {
  const guid = generateGnucashGuid();
  return prisma.account.create({
    data: {
      guid,
      name: data.name,
      account_type: data.accountType,
      parent_guid: data.parentGuid,
      commodity_guid: data.commodityGuid,
      commodity_scu: 100,
      non_std_scu: 0,
      code: data.code || '',
      description: data.description || '',
      hidden: data.hidden ? 1 : 0,
      placeholder: data.placeholder ? 1 : 0,
    }
  });
};
```

### Pattern 2: Safe Hierarchy Moves
```typescript
// Validate no circular reference before move
const canMoveAccount = async (accountGuid: string, newParentGuid: string) => {
  // Check if newParent is a descendant of account
  let current = newParentGuid;
  while (current) {
    if (current === accountGuid) return false; // Circular!
    const parent = await prisma.account.findUnique({
      where: { guid: current },
      select: { parent_guid: true }
    });
    current = parent?.parent_guid;
  }
  return true;
};
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Drag-drop | Custom mouse events | @dnd-kit | Accessibility, touch support, keyboard nav |
| Form validation | Manual checks | Zod schemas | Type inference, reusable, composable |
| Tree rendering | Custom recursion | Existing AccountNode | Already handles expansion, filtering |

## Common Pitfalls

### Pitfall 1: Circular Parent References
**What goes wrong:** Account becomes unreachable in tree.
**Why it happens:** Moving account to be child of its own descendant.
**How to avoid:** Server-side validation checking full ancestor chain.

### Pitfall 2: Orphaned Transactions
**What goes wrong:** Deleting account leaves transactions without valid account.
**Why it happens:** Splits reference account_guid with no cascade.
**How to avoid:** Require account to have zero transactions before deletion, or offer merge option.

### Pitfall 3: Account Type Constraints
**What goes wrong:** Moving INCOME account under ASSET.
**Why it happens:** GnuCash has logical account type hierarchies.
**How to avoid:** Validate parent account type compatibility (same root type or Root parent).

## Code Examples

### Account Type Aggregation Query
```typescript
const getAccountTypeSummaries = async (startDate: Date, endDate: Date) => {
  return prisma.$queryRaw`
    SELECT
      a.account_type,
      COUNT(DISTINCT a.guid) as account_count,
      COALESCE(SUM(s.value_num::decimal / s.value_denom::decimal), 0) as total_value
    FROM accounts a
    LEFT JOIN splits s ON s.account_guid = a.guid
    LEFT JOIN transactions t ON t.guid = s.tx_guid
    WHERE t.post_date BETWEEN ${startDate} AND ${endDate}
       OR t.guid IS NULL
    GROUP BY a.account_type
  `;
};
```

## Sources

### Primary (HIGH confidence)
- [GnuCash Wiki: SQL](https://wiki.gnucash.org/wiki/SQL) - Account table structure
- [@dnd-kit Documentation](https://docs.dndkit.com/) - Drag-drop patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH
- Architecture: HIGH
- Pitfalls: HIGH

**Research date:** 2026-01-24
**Valid until:** 2026-02-24
