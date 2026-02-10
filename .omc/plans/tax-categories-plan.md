# Plan: Fix Tax Categories Display on Dashboard

## Context

### Original Request
Fix the `deriveTaxCategoriesFromTree` function so the "Taxes by Category" pie chart shows the correct tax sub-accounts instead of the aggregated parent "Taxes" node.

### Root Cause
The current implementation at `src/app/(main)/dashboard/page.tsx` lines 92-104 matches any node whose name contains "tax". This:
- **Incorrectly includes** the parent "Taxes" node (aggregated value, no direct transactions)
- **Incorrectly misses** children of "Taxes" that lack "tax" in their name (Federal, Social Security, State, Medicare)
- **Correctly includes** "Property Tax" (a leaf under Home) but its value is also double-counted inside the parent "Taxes" total

### Current Code (lines 92-104)
```typescript
function deriveTaxCategoriesFromTree(expense: SankeyHierarchyNode[]): CategoryData[] {
    const result: CategoryData[] = [];
    function traverse(nodes: SankeyHierarchyNode[]) {
        for (const node of nodes) {
            if (node.name.toLowerCase().includes('tax') && node.value > 0) {
                result.push({ name: node.name, value: node.value });
            }
            traverse(node.children);
        }
    }
    traverse(expense);
    return result.sort((a, b) => b.value - a.value);
}
```

### Data Structure
The Sankey API returns a hierarchy where each node has `{ name, value, children }`. A parent node's `value` equals its own direct splits plus the sum of all descendant values.

```
expense: [
  { name: "Taxes", value: X, children: [
    { name: "Federal", value: ..., children: [] },
    { name: "Social Security", value: ..., children: [] },
    { name: "State", value: ..., children: [] },
    { name: "Medicare", value: ..., children: [] }
  ]},
  { name: "Home", value: ..., children: [
    { name: "Property Tax", value: ..., children: [] },
    ...
  ]},
  ...
]
```

---

## Work Objectives

### Core Objective
Replace the naive name-matching logic with a structure-aware traversal that expands parent "tax" nodes into their children and collects leaf "tax" nodes directly.

### Deliverables
1. Updated `deriveTaxCategoriesFromTree` function in `src/app/(main)/dashboard/page.tsx`

### Definition of Done
- The pie chart shows exactly the leaf-level tax accounts: Federal, Social Security, State, Property Tax, Medicare
- The parent "Taxes" container node does NOT appear
- No hardcoded account names -- logic is purely structural (name match + has-children check)

---

## Guardrails

### Must Have
- When a "tax"-named node HAS children: expand to show children (not the parent)
- When a "tax"-named node is a leaf (no children): show it directly
- For non-"tax" nodes: recurse into children to find "tax"-named descendants
- Filter out nodes with `value <= 0`

### Must NOT Have
- Hardcoded account names (no `name === "Federal"` etc.)
- Changes to any other file
- Changes to the Sankey API or data structure

---

## Task Flow

### Task 1: Rewrite `deriveTaxCategoriesFromTree`

**File:** `src/app/(main)/dashboard/page.tsx` (lines 92-104)

**Logic:**
```
traverse(nodes):
  for each node in nodes:
    if node.name matches "tax" (case-insensitive):
      if node has children:
        // Parent tax node: show children as individual categories
        for each child in node.children:
          if child.value > 0:
            result.push({ name: child.name, value: child.value })
      else:
        // Leaf tax node (e.g., "Property Tax"): show directly
        if node.value > 0:
          result.push({ name: node.name, value: node.value })
    else:
      // Non-tax node: recurse to find tax descendants
      traverse(node.children)
```

**Key behavior:**
- "Taxes" (has children) -> collects Federal, Social Security, State, Medicare as individual entries
- "Property Tax" (leaf under Home) -> collected directly
- "Taxes" parent itself -> skipped (replaced by its children)

**Acceptance Criteria:**
- [ ] Function returns 5 categories for the known dataset: Federal, Social Security, State, Property Tax, Medicare
- [ ] Parent "Taxes" node does not appear in results
- [ ] No hardcoded names in the implementation
- [ ] TypeScript compiles without errors

---

## Commit Strategy

Single commit:
```
fix(dashboard): correct tax categories derivation to expand parent nodes

Replace naive name-matching with structure-aware traversal that expands
parent "tax" nodes into their children and keeps leaf "tax" nodes directly.
Fixes incorrect display showing aggregated "Taxes" parent instead of
individual tax sub-accounts.
```

---

## Verification

1. **Build check:** `npm run build` passes without errors
2. **Manual verification:** Dashboard "Taxes by Category" pie chart with "Last Year" selected shows 5 categories: Federal, Social Security, State, Property Tax, Medicare
3. **Negative check:** Parent "Taxes" node does not appear in the chart
