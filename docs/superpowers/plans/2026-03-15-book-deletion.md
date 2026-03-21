# Book Deletion UI — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add book deletion UI to the BookEditorModal with confirmation dialog, remove the last-book guard from the API, and handle the empty-database redirect to CreateBookWizard.

**Architecture:** Add a delete button and confirmation panel to `BookEditorModal.tsx`. Modify the DELETE API to return remaining book count. Handle post-deletion routing in the parent component.

**Tech Stack:** React 19, TypeScript, Next.js API routes, Prisma

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/app/api/books/[guid]/route.ts` | Remove last-book guard, return remaining count |
| Modify | `src/components/BookEditorModal.tsx` | Add delete button, confirmation, onDeleted callback |

---

### Task 1: Update DELETE API

**Files:**
- Modify: `src/app/api/books/[guid]/route.ts:143-150`

- [ ] **Step 1: Remove the last-book guard and return remaining count**

In the DELETE handler, remove the book count check that returns 400. Instead, after the deletion transaction, query the remaining book count and return it in the response.

Find and remove this block (~lines 143-150):
```typescript
const bookCount = await prisma.books.count();
if (bookCount <= 1) {
    return NextResponse.json(
        { error: 'Cannot delete the last book' },
        { status: 400 }
    );
}
```

Restructure the `prisma.$transaction(...)` block to return the remaining count from within the transaction. The transaction currently has no return value — change it to:

```typescript
const remainingBooks = await prisma.$transaction(async (tx) => {
  // ... existing cascade delete operations using tx instead of prisma ...

  // Query remaining count inside the transaction for concurrency safety
  const count = await tx.books.count();
  return count;
});
```

Update the success response to include:
```typescript
return NextResponse.json({
  success: true,
  remainingBooks,
});
```

- [ ] **Step 2: Verify the API compiles**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/books/[guid]/route.ts
git commit -m "feat: remove last-book deletion guard and return remaining count"
```

---

### Task 2: Add Delete UI to BookEditorModal

**Files:**
- Modify: `src/components/BookEditorModal.tsx`

- [ ] **Step 1: Add onDeleted prop to the interface**

Add `onDeleted` to the existing props interface (~line 12-17). Keep the existing `Book` type for the `book` prop — do not change its type:
```typescript
onDeleted: (remainingBooks: number) => void;  // Add this line to existing interface
```

- [ ] **Step 2: Add delete confirmation state and handler**

After the existing state variables (~line 20-23), add:
```typescript
const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
const [deleting, setDeleting] = useState(false);
```

Add delete handler after the save handler:
```typescript
const handleDelete = async () => {
  if (!book) return;
  setDeleting(true);
  try {
    const res = await fetch(`/api/books/${book.guid}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to delete book');
    }
    const data = await res.json();
    onDeleted(data.remainingBooks);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to delete book');
    setDeleting(false);
    setShowDeleteConfirm(false);
  }
};
```

- [ ] **Step 3: Reset delete state when modal opens**

In the existing sync effect (~line 25-29), add:
```typescript
setShowDeleteConfirm(false);
setDeleting(false);
```

- [ ] **Step 4: Add delete button and confirmation panel to the modal**

In the modal footer area (after the Save button, ~line 118), add the delete button on the left side. Restructure the footer to have a left-aligned delete and right-aligned Cancel/Save:

```tsx
{/* Footer */}
<div className="flex items-center justify-between mt-6 pt-4 border-t border-zinc-700">
  <button
    type="button"
    onClick={() => setShowDeleteConfirm(true)}
    className="px-3 py-2 text-sm text-rose-400 border border-rose-500/30 rounded-md hover:bg-rose-500/10"
    disabled={loading || deleting}
  >
    Delete Book
  </button>
  <div className="flex gap-2">
    <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 text-sm font-medium text-zinc-300 bg-zinc-800 border border-zinc-600 rounded-lg hover:bg-zinc-700">Cancel</button>
    <button type="submit" className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50" disabled={loading}>
      {loading ? 'Saving...' : 'Save'}
    </button>
  </div>
</div>

{/* Delete Confirmation */}
{showDeleteConfirm && (
  <div className="mt-4 p-4 bg-rose-950/50 border border-rose-500/30 rounded-lg">
    <p className="text-rose-300 font-semibold mb-1">
      Delete &ldquo;{book?.name}&rdquo;?
    </p>
    <p className="text-rose-400/80 text-sm mb-3">
      This will permanently delete all accounts, transactions, and data in this book. This cannot be undone.
    </p>
    <div className="flex gap-2">
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="px-3 py-1.5 text-sm bg-rose-600 text-white rounded-md hover:bg-rose-700 disabled:opacity-50"
      >
        {deleting ? 'Deleting...' : 'Yes, Delete'}
      </button>
      <button
        onClick={() => setShowDeleteConfirm(false)}
        disabled={deleting}
        className="px-3 py-1.5 text-sm text-zinc-400 border border-zinc-600 rounded-md hover:bg-zinc-800"
      >
        Cancel
      </button>
    </div>
  </div>
)}
```

Note: The confirmation panel must be placed inside the `<div className="p-6 space-y-4">` container to inherit the modal's padding.

- [ ] **Step 5: Update all call sites of BookEditorModal to pass onDeleted**

Search for all usages of `<BookEditorModal` in the codebase and add the `onDeleted` prop. The handler should:
- If `remainingBooks > 0`: call `refreshBooks()` from BookContext to get updated list, then call `switchBook(books[0].guid)` with the first available book
- If `remainingBooks === 0`: set `setWizardOpen(true)` in the BookSwitcher component (or equivalent) to open the CreateBookWizard — do NOT use `router.push('/')`

- [ ] **Step 6: Verify the flow end-to-end**

Run: `npm run dev`
Test:
- Open BookEditorModal → Delete Book → confirmation appears
- Cancel confirmation → returns to normal modal
- Confirm deletion → book is deleted, app routes correctly
- Delete last book → redirects to creation wizard

- [ ] **Step 7: Commit**

```bash
git add src/components/BookEditorModal.tsx
git commit -m "feat: add book deletion UI with confirmation dialog"
```
