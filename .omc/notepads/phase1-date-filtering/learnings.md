# Learnings: Phase 1 - Date Filtering Enhancement

## Feature 4: Ctrl+Enter Form Submission with Validation

### Pattern: Custom Keyboard Shortcut Hook
Created a reusable `useFormKeyboardShortcuts` hook for form keyboard handling:

```typescript
useFormKeyboardShortcuts(formRef, () => handleSubmit(), {
  validate: () => validateForm().valid
});
```

**Key Learnings:**
- Hook listens to global window events, not just form-specific
- Must handle both Ctrl (Windows/Linux) and Cmd/Meta (Mac)
- Validation callback is optional but recommended
- Always cleanup event listeners on unmount
- ESLint exhaustive-deps warning expected (options object reference changes)

### Pattern: Field-Level Validation Feedback
Implemented per-field error tracking separate from error summary:

```typescript
const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

const validateForm = () => {
  const errors: string[] = [];
  const fieldErrors: Record<string, string> = {};

  if (!formData.name) {
    errors.push('Name is required');
    fieldErrors.name = 'Required';
  }

  return { valid: errors.length === 0, errors, fieldErrors };
};
```

**Key Learnings:**
- Separate arrays (summary) from field-specific messages
- Field errors should be concise ("Required", "Must be > 0")
- Summary errors can be verbose ("Description is required")
- Use `data-field` attributes for focus management

### Pattern: Error Styling with Tailwind
Consistent error visual feedback across forms:

```typescript
className={`base-classes ${
  fieldErrors.fieldName ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-neutral-800'
}`}
```

**Key Learnings:**
- Red border + subtle glow effect provides clear feedback
- Conditional className keeps styling maintainable
- Inline error text in `text-rose-400` matches border color
- Position error text with `mt-1` for consistent spacing

### Pattern: Focus Management on Validation Failure
Auto-focus first invalid field:

```typescript
const firstErrorField = Object.keys(validation.fieldErrors)[0];
if (firstErrorField) {
  const element = document.querySelector(`[data-field="${firstErrorField}"]`) as HTMLElement;
  element?.focus();
}
```

**Key Learnings:**
- Use `data-field` attributes instead of IDs (more flexible)
- querySelector works with attribute selectors
- Optional chaining prevents errors if element not found
- Focus happens AFTER state update (field errors set)

### Pattern: Extending UI Components with Error Props
Added error state to existing AccountSelector:

```typescript
interface AccountSelectorProps {
  // ... existing props
  hasError?: boolean;
}

// Usage:
<AccountSelector value={guid} onChange={handleChange} hasError={!!fieldErrors.field} />
```

**Key Learnings:**
- Optional props maintain backward compatibility
- Boolean coercion with `!!` converts truthy values
- Component handles its own error styling internally
- Keeps error styling consistent across component types

### Pattern: Keyboard Shortcut Hints
Visual hint for keyboard shortcuts:

```tsx
<kbd className="px-1.5 py-0.5 bg-neutral-800 rounded border border-neutral-700">
  Ctrl
</kbd>
```

**Key Learnings:**
- Use semantic `<kbd>` element for keyboard keys
- Small padding and border creates button-like appearance
- Keep hint subtle (neutral-500 text)
- Position in form footer near action buttons

## Build & Verification
- Always run `tsc --noEmit` before claiming completion
- Production build catches issues missed in dev mode
- ESLint warnings may need suppression with inline comments
- Hook dependencies can cause false positives (use judgment)

## Reusable Patterns
1. **Validation Function Pattern**: Return object with `{ valid, errors, fieldErrors }`
2. **Error Display Pattern**: Summary at top + inline messages at field level
3. **Focus Pattern**: `data-field` + querySelector for keyboard navigation
4. **Keyboard Hook Pattern**: Global event listener with validation guard
5. **Error Styling Pattern**: Red border + ring + inline message trio
