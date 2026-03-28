# Account Modal Full Field Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the account new/edit modal to include Notes, Tax Related, Retirement settings, reparenting, and read-only display of immutable fields — consolidating all account editing into a single modal.

**Architecture:** Extend `AccountForm.tsx` with new fields and an expanded `AccountFormData` interface. Extend `AccountService` and `UpdateAccountSchema` to handle notes (slots table), tax_related (preferences table), retirement fields (preferences table), and parent_guid changes. Consolidate the retirement UI from the detail page into the modal.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma (raw SQL for slots), Zod validation, PostgreSQL

---

### Task 1: Database Migration — Add `tax_related` Column and `lot_assignment_method` Column

**Files:**
- Modify: `src/lib/db-init.ts:440-446`

- [ ] **Step 1: Add tax_related and lot_assignment_method ALTER statements to db-init.ts**

In `src/lib/db-init.ts`, find the `accountPreferencesRetirementDDL` string (line 440) and add the new columns:

```typescript
    const accountPreferencesRetirementDDL = `
        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS is_retirement BOOLEAN NOT NULL DEFAULT FALSE;

        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS retirement_account_type VARCHAR(20);

        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS tax_related BOOLEAN NOT NULL DEFAULT FALSE;

        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS lot_assignment_method VARCHAR(20);
    `;
```

- [ ] **Step 2: Verify the DDL executes on startup**

Run: `npm run build`
Expected: Build succeeds. The `tax_related` and `lot_assignment_method` columns will be added on next app startup.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add tax_related and lot_assignment_method columns to account preferences"
```

---

### Task 2: Extend AccountService — Update Schema and Service Methods

**Files:**
- Modify: `src/lib/services/account.service.ts`

- [ ] **Step 1: Extend UpdateAccountSchema to accept new fields**

In `src/lib/services/account.service.ts`, replace the `UpdateAccountSchema` (lines 46-52) with:

```typescript
export const UpdateAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048).optional(),
  code: z.string().max(2048).optional(),
  description: z.string().max(2048).optional(),
  hidden: z.number().int().min(0).max(1).optional(),
  placeholder: z.number().int().min(0).max(1).optional(),
  parent_guid: z.string().length(32).nullable().optional(),
  notes: z.string().optional(),
  tax_related: z.boolean().optional(),
  is_retirement: z.boolean().optional(),
  retirement_account_type: z.enum(['401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa', 'brokerage']).nullable().optional(),
});
```

- [ ] **Step 2: Extend CreateAccountSchema to accept new fields**

In `src/lib/services/account.service.ts`, replace the `CreateAccountSchema` (lines 33-44) with:

```typescript
export const CreateAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(2048),
  account_type: z.enum(ACCOUNT_TYPES),
  parent_guid: z.string().length(32, 'Invalid parent GUID').nullable(),
  commodity_guid: z.string().length(32, 'Invalid commodity GUID'),
  code: z.string().max(2048).optional().default(''),
  description: z.string().max(2048).optional().default(''),
  hidden: z.number().int().min(0).max(1).optional().default(0),
  placeholder: z.number().int().min(0).max(1).optional().default(0),
  commodity_scu: z.number().int().optional().default(100),
  non_std_scu: z.number().int().optional().default(0),
  notes: z.string().optional(),
  tax_related: z.boolean().optional(),
  is_retirement: z.boolean().optional(),
  retirement_account_type: z.enum(['401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa', 'brokerage']).nullable().optional(),
});
```

- [ ] **Step 3: Update the `create` method to write notes and preferences after account creation**

In `src/lib/services/account.service.ts`, update the `create` method. After the `prisma.accounts.create` call (after line 108), add:

```typescript
    // Write notes to slots table if provided
    if (data.notes) {
      await prisma.$executeRaw`
        INSERT INTO slots (id, obj_guid, name, slot_type, int64_val, string_val, double_val, timespec_val, guid_val, numeric_val_num, numeric_val_denom, gdate_val)
        VALUES (
          (SELECT COALESCE(MAX(id), 0) + 1 FROM slots),
          ${accountGuid}, 'notes', 4, 0, ${data.notes}, 0, '1970-01-01 00:00:00'::timestamp, NULL, 0, 1, NULL
        )
      `;
    }

    // Write preferences if any preference fields are provided
    if (data.tax_related !== undefined || data.is_retirement !== undefined || data.retirement_account_type !== undefined) {
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_preferences (account_guid, tax_related, is_retirement, retirement_account_type)
        VALUES (
          ${accountGuid},
          ${data.tax_related ?? false},
          ${data.is_retirement ?? false},
          ${data.retirement_account_type ?? null}
        )
        ON CONFLICT (account_guid)
        DO UPDATE SET
          tax_related = ${data.tax_related ?? false},
          is_retirement = ${data.is_retirement ?? false},
          retirement_account_type = ${data.retirement_account_type ?? null}
      `;
    }
```

- [ ] **Step 4: Update the `update` method to handle notes, preferences, and reparenting**

In `src/lib/services/account.service.ts`, update the `update` method. After the `prisma.accounts.update` call (after line 144), add the following. Also add `parent_guid` to the Prisma update data if provided:

Replace the entire `update` method (lines 115-147):

```typescript
  static async update(guid: string, input: UpdateAccountInput) {
    if (!guid || guid.length !== 32) {
      throw new Error('Invalid account GUID');
    }

    const data = UpdateAccountSchema.parse(input);

    // Check account exists
    const existing = await prisma.accounts.findUnique({
      where: { guid },
    });

    if (!existing) {
      throw new Error(`Account not found: ${guid}`);
    }

    // Handle reparenting if parent_guid is provided
    if (data.parent_guid !== undefined) {
      if (data.parent_guid !== null) {
        if (data.parent_guid === guid) {
          throw new Error('Cannot move account to be its own parent');
        }
        const newParent = await prisma.accounts.findUnique({
          where: { guid: data.parent_guid },
        });
        if (!newParent) {
          throw new Error(`New parent account not found: ${data.parent_guid}`);
        }
        // Check for circular reference
        let ancestor = newParent;
        while (ancestor.parent_guid) {
          if (ancestor.parent_guid === guid) {
            throw new Error('Cannot move account: would create circular reference');
          }
          const nextAncestor = await prisma.accounts.findUnique({
            where: { guid: ancestor.parent_guid },
          });
          if (!nextAncestor) break;
          ancestor = nextAncestor;
        }
      }
    }

    const account = await prisma.accounts.update({
      where: { guid },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.code !== undefined && { code: data.code }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.hidden !== undefined && { hidden: data.hidden }),
        ...(data.placeholder !== undefined && { placeholder: data.placeholder }),
        ...(data.parent_guid !== undefined && { parent_guid: data.parent_guid }),
      },
      include: {
        commodity: true,
        parent: true,
      },
    });

    // Upsert notes in slots table
    if (data.notes !== undefined) {
      if (data.notes) {
        // Check if notes slot exists
        const existingSlot = await prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM slots WHERE obj_guid = ${guid} AND name = 'notes'
        `;
        if (existingSlot.length > 0) {
          await prisma.$executeRaw`
            UPDATE slots SET string_val = ${data.notes} WHERE obj_guid = ${guid} AND name = 'notes'
          `;
        } else {
          await prisma.$executeRaw`
            INSERT INTO slots (id, obj_guid, name, slot_type, int64_val, string_val, double_val, timespec_val, guid_val, numeric_val_num, numeric_val_denom, gdate_val)
            VALUES (
              (SELECT COALESCE(MAX(id), 0) + 1 FROM slots),
              ${guid}, 'notes', 4, 0, ${data.notes}, 0, '1970-01-01 00:00:00'::timestamp, NULL, 0, 1, NULL
            )
          `;
        }
      } else {
        // Delete notes slot if cleared
        await prisma.$executeRaw`
          DELETE FROM slots WHERE obj_guid = ${guid} AND name = 'notes'
        `;
      }
    }

    // Upsert preferences if any preference fields are provided
    if (data.tax_related !== undefined || data.is_retirement !== undefined || data.retirement_account_type !== undefined) {
      const taxRelated = data.tax_related;
      const isRetirement = data.is_retirement;
      const retirementType = data.retirement_account_type;
      const hasTaxRelated = data.tax_related !== undefined;
      const hasIsRetirement = data.is_retirement !== undefined;
      const hasRetirementType = data.retirement_account_type !== undefined;

      await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_preferences (account_guid, tax_related, is_retirement, retirement_account_type)
        VALUES (
          ${guid},
          ${taxRelated ?? false},
          ${isRetirement ?? false},
          ${retirementType ?? null}
        )
        ON CONFLICT (account_guid)
        DO UPDATE SET
          tax_related = CASE WHEN ${hasTaxRelated}::boolean THEN ${taxRelated ?? false} ELSE gnucash_web_account_preferences.tax_related END,
          is_retirement = CASE WHEN ${hasIsRetirement}::boolean THEN ${isRetirement ?? false} ELSE gnucash_web_account_preferences.is_retirement END,
          retirement_account_type = CASE WHEN ${hasRetirementType}::boolean THEN ${retirementType ?? null} ELSE gnucash_web_account_preferences.retirement_account_type END
      `;
    }

    return serializeBigInts(account);
  }
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/account.service.ts
git commit -m "feat: extend account service with notes, tax_related, retirement, and reparenting support"
```

---

### Task 3: Extend API Routes — PUT Accepts New Fields, GET Returns Extended Data

**Files:**
- Modify: `src/app/api/accounts/[guid]/route.ts:86-124`

- [ ] **Step 1: Update the PUT route to pass through new fields**

The PUT route at `src/app/api/accounts/[guid]/route.ts` already delegates to `AccountService.update` with `UpdateAccountSchema` validation. Since we extended the schema in Task 2, the route will automatically accept and pass through the new fields. No changes needed to this file.

- [ ] **Step 2: Update the GET single account route to return notes and preferences**

In `src/app/api/accounts/[guid]/route.ts`, update the GET handler to include notes and preferences. Replace the GET function (lines 23-48):

```typescript
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const account = await AccountService.getById(guid);
        if (!account) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        // Fetch notes from slots table
        const notesSlot = await prisma.$queryRaw<{ string_val: string }[]>`
            SELECT string_val FROM slots WHERE obj_guid = ${guid} AND name = 'notes'
        `;

        // Fetch preferences
        const prefs = await prisma.$queryRaw<{ tax_related: boolean; is_retirement: boolean; retirement_account_type: string | null }[]>`
            SELECT tax_related, is_retirement, retirement_account_type
            FROM gnucash_web_account_preferences
            WHERE account_guid = ${guid}
        `;

        return NextResponse.json({
            ...account,
            notes: notesSlot[0]?.string_val ?? '',
            tax_related: prefs[0]?.tax_related ?? false,
            is_retirement: prefs[0]?.is_retirement ?? false,
            retirement_account_type: prefs[0]?.retirement_account_type ?? null,
        });
    } catch (error) {
        console.error('Error fetching account:', error);
        return NextResponse.json({ error: 'Failed to fetch account' }, { status: 500 });
    }
}
```

Add the prisma import at the top of the file:

```typescript
import prisma from '@/lib/prisma';
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/accounts/[guid]/route.ts
git commit -m "feat: return notes, tax_related, and retirement fields from account GET endpoint"
```

---

### Task 4: Extend AccountForm — Add New Fields and Read-Only Edit Mode Display

**Files:**
- Modify: `src/components/AccountForm.tsx`

- [ ] **Step 1: Extend the AccountFormData interface and add new fields to the form**

Replace the entire `src/components/AccountForm.tsx` file with the expanded version. Key changes:
- Extended `AccountFormData` with `notes`, `tax_related`, `is_retirement`, `retirement_account_type`
- In edit mode: Account Type, Currency shown as read-only text; Parent Account is editable
- Notes textarea field
- Tax Related checkbox alongside Hidden and Placeholder
- Retirement section (conditional on account type)

```typescript
'use client';

import { useState, useEffect, useRef } from 'react';
import { useFormKeyboardShortcuts } from '@/lib/hooks/useFormKeyboardShortcuts';

const ACCOUNT_TYPES = [
    { value: 'ASSET', label: 'Asset', group: 'Assets' },
    { value: 'BANK', label: 'Bank Account', group: 'Assets' },
    { value: 'CASH', label: 'Cash', group: 'Assets' },
    { value: 'RECEIVABLE', label: 'Accounts Receivable', group: 'Assets' },
    { value: 'STOCK', label: 'Stock', group: 'Assets' },
    { value: 'MUTUAL', label: 'Mutual Fund', group: 'Assets' },
    { value: 'LIABILITY', label: 'Liability', group: 'Liabilities' },
    { value: 'CREDIT', label: 'Credit Card', group: 'Liabilities' },
    { value: 'PAYABLE', label: 'Accounts Payable', group: 'Liabilities' },
    { value: 'INCOME', label: 'Income', group: 'Income' },
    { value: 'EXPENSE', label: 'Expense', group: 'Expenses' },
    { value: 'EQUITY', label: 'Equity', group: 'Equity' },
    { value: 'TRADING', label: 'Trading', group: 'Other' },
] as const;

const RETIREMENT_TYPES = [
    { value: '401k', label: '401(k)' },
    { value: '403b', label: '403(b)' },
    { value: '457', label: '457' },
    { value: 'traditional_ira', label: 'Traditional IRA' },
    { value: 'roth_ira', label: 'Roth IRA' },
    { value: 'hsa', label: 'HSA' },
    { value: 'brokerage', label: 'Brokerage (taxable)' },
] as const;

const RETIREMENT_ELIGIBLE_TYPES = ['STOCK', 'MUTUAL', 'ASSET', 'BANK'];

export interface AccountFormData {
    name: string;
    account_type: string;
    parent_guid: string | null;
    commodity_guid: string;
    code: string;
    description: string;
    hidden: number;
    placeholder: number;
    notes: string;
    tax_related: boolean;
    is_retirement: boolean;
    retirement_account_type: string | null;
}

interface FlatAccount {
    guid: string;
    name: string;
    fullname: string;
    account_type: string;
    commodity_mnemonic?: string;
}

interface Commodity {
    guid: string;
    mnemonic: string;
    fullname: string | null;
    namespace: string;
}

interface AccountFormProps {
    mode: 'create' | 'edit';
    initialData?: Partial<AccountFormData>;
    accountGuid?: string; // Required for edit mode to exclude self from parent picker
    parentGuid?: string | null; // Pre-selected parent for "New Child" action
    onSave: (data: AccountFormData) => Promise<void>;
    onCancel: () => void;
}

export function AccountForm({ mode, initialData, accountGuid, parentGuid, onSave, onCancel }: AccountFormProps) {
    const [formData, setFormData] = useState<AccountFormData>({
        name: initialData?.name || '',
        account_type: initialData?.account_type || 'ASSET',
        parent_guid: parentGuid ?? initialData?.parent_guid ?? null,
        commodity_guid: initialData?.commodity_guid || '',
        code: initialData?.code || '',
        description: initialData?.description || '',
        hidden: initialData?.hidden ?? 0,
        placeholder: initialData?.placeholder ?? 0,
        notes: initialData?.notes ?? '',
        tax_related: initialData?.tax_related ?? false,
        is_retirement: initialData?.is_retirement ?? false,
        retirement_account_type: initialData?.retirement_account_type ?? null,
    });

    const [accounts, setAccounts] = useState<FlatAccount[]>([]);
    const [commodities, setCommodities] = useState<Commodity[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const formRef = useRef<HTMLFormElement>(null);

    // Fetch accounts and commodities for dropdowns
    useEffect(() => {
        async function fetchData() {
            setLoading(true);
            try {
                const [accountsRes, commoditiesRes] = await Promise.all([
                    fetch('/api/accounts?flat=true'),
                    fetch('/api/commodities'),
                ]);

                if (accountsRes.ok) {
                    const accs = await accountsRes.json();
                    setAccounts(accs);
                }

                if (commoditiesRes.ok) {
                    const allComms = await commoditiesRes.json();
                    // Filter to currencies only for the selector
                    const comms = allComms.filter((c: Commodity) =>
                        c.namespace === 'CURRENCY' || c.namespace === 'ISO4217'
                    );
                    setCommodities(comms);
                    // Set default commodity if not set
                    setFormData(prev => {
                        if (prev.commodity_guid || comms.length === 0) {
                            return prev;
                        }

                        const usd = comms.find((c: Commodity) => c.mnemonic === 'USD');
                        return {
                            ...prev,
                            commodity_guid: usd?.guid || comms[0].guid,
                        };
                    });
                }
            } catch (err) {
                console.error('Error fetching form data:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchData();
    }, []);

    // Update commodity when parent changes (inherit from parent) — create mode only
    useEffect(() => {
        if (mode === 'create' && formData.parent_guid) {
            const parent = accounts.find(a => a.guid === formData.parent_guid);
            if (parent?.commodity_mnemonic) {
                const parentComm = commodities.find(c => c.mnemonic === parent.commodity_mnemonic);
                if (parentComm) {
                    setFormData(prev => ({ ...prev, commodity_guid: parentComm.guid }));
                }
            }
        }
    }, [formData.parent_guid, accounts, commodities, mode]);

    const validateForm = (): { valid: boolean; error: string | null; fieldErrors: Record<string, string> } => {
        const fieldErrors: Record<string, string> = {};

        if (!formData.name?.trim()) {
            fieldErrors.name = 'Required';
        }
        if (mode === 'create' && !formData.commodity_guid) {
            fieldErrors.commodity_guid = 'Required';
        }
        if (formData.is_retirement && !formData.retirement_account_type) {
            fieldErrors.retirement_account_type = 'Required when retirement is enabled';
        }

        const hasErrors = Object.keys(fieldErrors).length > 0;
        return {
            valid: !hasErrors,
            error: hasErrors ? 'Please fix the validation errors' : null,
            fieldErrors
        };
    };

    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();

        const validation = validateForm();
        setFieldErrors(validation.fieldErrors);
        setError(validation.error);

        if (!validation.valid) {
            // Focus first invalid field
            const firstErrorField = Object.keys(validation.fieldErrors)[0];
            if (firstErrorField) {
                const element = document.querySelector(`[data-field="${firstErrorField}"]`) as HTMLElement;
                element?.focus();
            }
            return;
        }

        setSaving(true);

        try {
            await onSave(formData);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save account');
        } finally {
            setSaving(false);
        }
    };

    // Setup keyboard shortcut
    useFormKeyboardShortcuts(formRef, () => handleSubmit(), {
        validate: () => validateForm().valid
    });

    const groupedAccountTypes = ACCOUNT_TYPES.reduce((acc, type) => {
        if (!acc[type.group]) acc[type.group] = [];
        acc[type.group].push(type);
        return acc;
    }, {} as Record<string, typeof ACCOUNT_TYPES[number][]>);

    // For edit mode read-only display
    const accountTypeLabel = ACCOUNT_TYPES.find(t => t.value === formData.account_type)?.label || formData.account_type;
    const commodityLabel = commodities.find(c => c.guid === formData.commodity_guid);
    const commodityDisplayText = commodityLabel
        ? `${commodityLabel.mnemonic} - ${commodityLabel.fullname || commodityLabel.mnemonic}`
        : initialData?.commodity_guid || 'Unknown';

    // Filter accounts for parent picker (exclude self and descendants in edit mode)
    const availableParentAccounts = accounts.filter(a => {
        if (mode === 'edit' && accountGuid) {
            // Exclude self
            if (a.guid === accountGuid) return false;
            // Note: full descendant exclusion would require tree traversal;
            // the server-side circular reference check in AccountService.update handles this
        }
        return true;
    });

    const showRetirementSection = RETIREMENT_ELIGIBLE_TYPES.includes(formData.account_type);

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
            {error && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-rose-400 text-sm">
                    {error}
                </div>
            )}

            {/* Name */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Account Name <span className="text-rose-400">*</span>
                </label>
                <input
                    type="text"
                    required
                    data-field="name"
                    value={formData.name}
                    onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className={`w-full bg-input-bg border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-emerald-500/50 transition-all ${
                        fieldErrors.name ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-border'
                    }`}
                    placeholder="e.g., Checking Account"
                />
                {fieldErrors.name && (
                    <p className="mt-1 text-xs text-rose-400">{fieldErrors.name}</p>
                )}
            </div>

            {/* Account Type */}
            {mode === 'create' ? (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Account Type <span className="text-rose-400">*</span>
                    </label>
                    <select
                        required
                        value={formData.account_type}
                        onChange={e => setFormData(prev => ({ ...prev, account_type: e.target.value }))}
                        className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer"
                    >
                        {Object.entries(groupedAccountTypes).map(([group, types]) => (
                            <optgroup key={group} label={group}>
                                {types.map(type => (
                                    <option key={type.value} value={type.value}>
                                        {type.label}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </div>
            ) : (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Account Type
                    </label>
                    <div className="w-full bg-input-bg/50 border border-border rounded-xl px-4 py-3 text-foreground-secondary">
                        {accountTypeLabel}
                    </div>
                </div>
            )}

            {/* Parent Account */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Parent Account
                </label>
                <select
                    value={formData.parent_guid || ''}
                    onChange={e => setFormData(prev => ({ ...prev, parent_guid: e.target.value || null }))}
                    className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer"
                >
                    <option value="">(Top Level)</option>
                    {availableParentAccounts.map(acc => (
                        <option key={acc.guid} value={acc.guid}>
                            {acc.fullname}
                        </option>
                    ))}
                </select>
                <p className="mt-1 text-xs text-foreground-muted">
                    {mode === 'create'
                        ? 'Select a parent to create a sub-account, or leave empty for top-level.'
                        : 'Change the parent to move this account in the hierarchy.'}
                </p>
            </div>

            {/* Currency/Commodity */}
            {mode === 'create' ? (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Currency <span className="text-rose-400">*</span>
                    </label>
                    <select
                        required
                        data-field="commodity_guid"
                        value={formData.commodity_guid}
                        onChange={e => setFormData(prev => ({ ...prev, commodity_guid: e.target.value }))}
                        className={`w-full bg-input-bg border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer ${
                            fieldErrors.commodity_guid ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-border'
                        }`}
                    >
                        {commodities.map(comm => (
                            <option key={comm.guid} value={comm.guid}>
                                {comm.mnemonic} - {comm.fullname || comm.mnemonic}
                            </option>
                        ))}
                    </select>
                    {fieldErrors.commodity_guid && (
                        <p className="mt-1 text-xs text-rose-400">{fieldErrors.commodity_guid}</p>
                    )}
                </div>
            ) : (
                <div>
                    <label className="block text-sm font-medium text-foreground-secondary mb-2">
                        Currency
                    </label>
                    <div className="w-full bg-input-bg/50 border border-border rounded-xl px-4 py-3 text-foreground-secondary">
                        {commodityDisplayText}
                    </div>
                </div>
            )}

            {/* Account Code */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Account Code
                </label>
                <input
                    type="text"
                    value={formData.code}
                    onChange={e => setFormData(prev => ({ ...prev, code: e.target.value }))}
                    className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-emerald-500/50 transition-all"
                    placeholder="e.g., 1010"
                />
                <p className="mt-1 text-xs text-foreground-muted">
                    Optional code for organization (e.g., chart of accounts number).
                </p>
            </div>

            {/* Description */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Description
                </label>
                <textarea
                    value={formData.description}
                    onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    rows={2}
                    className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-emerald-500/50 transition-all resize-none"
                    placeholder="Optional description..."
                />
            </div>

            {/* Notes */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Notes
                </label>
                <textarea
                    value={formData.notes}
                    onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                    rows={3}
                    className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-emerald-500/50 transition-all resize-none"
                    placeholder="Optional notes (stored in GnuCash slots)..."
                />
            </div>

            {/* Flags */}
            <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={formData.hidden === 1}
                        onChange={e => setFormData(prev => ({ ...prev, hidden: e.target.checked ? 1 : 0 }))}
                        className="w-5 h-5 rounded border-border-hover bg-background text-emerald-500 focus:ring-emerald-500/50"
                    />
                    <span className="text-sm text-foreground-secondary">Hidden</span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={formData.placeholder === 1}
                        onChange={e => setFormData(prev => ({ ...prev, placeholder: e.target.checked ? 1 : 0 }))}
                        className="w-5 h-5 rounded border-border-hover bg-background text-emerald-500 focus:ring-emerald-500/50"
                    />
                    <span className="text-sm text-foreground-secondary">Placeholder</span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={formData.tax_related}
                        onChange={e => setFormData(prev => ({ ...prev, tax_related: e.target.checked }))}
                        className="w-5 h-5 rounded border-border-hover bg-background text-emerald-500 focus:ring-emerald-500/50"
                    />
                    <span className="text-sm text-foreground-secondary">Tax Related</span>
                </label>
            </div>

            <p className="text-xs text-foreground-muted">
                Placeholder accounts are used for organization and cannot hold transactions directly.
            </p>

            {/* Retirement Section */}
            {showRetirementSection && (
                <div className="bg-background-secondary/30 border border-border rounded-xl p-4 space-y-3">
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={formData.is_retirement}
                            onChange={e => setFormData(prev => ({
                                ...prev,
                                is_retirement: e.target.checked,
                                retirement_account_type: e.target.checked ? prev.retirement_account_type : null,
                            }))}
                            className="w-5 h-5 rounded border-border-hover bg-background text-emerald-500 focus:ring-emerald-500/50"
                        />
                        <span className="text-sm text-foreground">Retirement Account</span>
                        <span className="text-xs text-foreground-tertiary">
                            (enables IRS contribution limit tracking)
                        </span>
                    </label>
                    {formData.is_retirement && (
                        <div className="ml-8">
                            <label className="text-xs text-foreground-secondary block mb-1">Retirement Account Type</label>
                            <select
                                data-field="retirement_account_type"
                                value={formData.retirement_account_type ?? ''}
                                onChange={e => setFormData(prev => ({
                                    ...prev,
                                    retirement_account_type: e.target.value || null,
                                }))}
                                className={`w-full bg-input-bg border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer ${
                                    fieldErrors.retirement_account_type ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-border'
                                }`}
                            >
                                <option value="">Select type...</option>
                                {RETIREMENT_TYPES.map(type => (
                                    <option key={type.value} value={type.value}>
                                        {type.label}
                                    </option>
                                ))}
                            </select>
                            {fieldErrors.retirement_account_type && (
                                <p className="mt-1 text-xs text-rose-400">{fieldErrors.retirement_account_type}</p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Actions */}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-between sm:items-center gap-3 pt-4 border-t border-border">
                <span className="hidden sm:inline text-xs text-foreground-muted">
                    Press <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Ctrl</kbd> + <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover">Enter</kbd> to save
                </span>
                <div className="flex flex-wrap gap-3 justify-end">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={saving || !formData.name || (mode === 'create' && !formData.commodity_guid)}
                        className="px-6 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                    >
                        {saving ? 'Saving...' : mode === 'create' ? 'Create Account' : 'Save Changes'}
                    </button>
                </div>
            </div>
        </form>
    );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountForm.tsx
git commit -m "feat: expand account form with notes, tax related, retirement, read-only fields, and reparenting"
```

---

### Task 5: Update AccountHierarchy — Pass Extended Data and Fetch Full Account for Edit

**Files:**
- Modify: `src/components/AccountHierarchy.tsx`

- [ ] **Step 1: Update handleEdit to fetch full account data including notes/preferences**

In `src/components/AccountHierarchy.tsx`, update the `handleEdit` callback (around line 541) to fetch full account data from the GET endpoint before opening the modal:

```typescript
    const handleEdit = useCallback(async (account: AccountWithChildren) => {
        // Fetch full account data including notes and preferences
        try {
            const res = await fetch(`/api/accounts/${account.guid}`);
            if (res.ok) {
                const fullAccount = await res.json();
                setSelectedAccount({
                    ...account,
                    ...fullAccount,
                });
            } else {
                setSelectedAccount(account);
            }
        } catch {
            setSelectedAccount(account);
        }
        setParentGuid(null);
        setModalMode('edit');
        setModalOpen(true);
    }, []);
```

- [ ] **Step 2: Update the initialData and handleSave to include new fields**

In the `handleSave` callback (around line 579), update the type signature to include the new fields:

```typescript
    const handleSave = useCallback(async (data: {
        name: string;
        account_type: string;
        parent_guid: string | null;
        commodity_guid: string;
        code: string;
        description: string;
        hidden: number;
        placeholder: number;
        notes: string;
        tax_related: boolean;
        is_retirement: boolean;
        retirement_account_type: string | null;
    }) => {
        const url = modalMode === 'create'
            ? '/api/accounts'
            : `/api/accounts/${selectedAccount?.guid}`;
        const method = modalMode === 'create' ? 'POST' : 'PUT';

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        if (!res.ok) {
            const errorData = await res.json();
            throw new Error(errorData.error || errorData.errors?.[0]?.message || 'Failed to save account');
        }

        setModalOpen(false);
        invalidateAccounts();
        onRefresh?.();
    }, [modalMode, selectedAccount, invalidateAccounts, onRefresh]);
```

- [ ] **Step 3: Update the Modal's AccountForm to pass accountGuid and extended initialData**

In the Modal rendering (around line 1212), update the AccountForm props:

```typescript
                    <AccountForm
                        mode={modalMode}
                        accountGuid={selectedAccount?.guid}
                        initialData={selectedAccount ? {
                            name: selectedAccount.name,
                            account_type: selectedAccount.account_type,
                            parent_guid: selectedAccount.parent_guid,
                            commodity_guid: selectedAccount.commodity_guid,
                            code: selectedAccount.code,
                            description: selectedAccount.description,
                            hidden: selectedAccount.hidden,
                            placeholder: selectedAccount.placeholder,
                            notes: (selectedAccount as any).notes ?? '',
                            tax_related: (selectedAccount as any).tax_related ?? false,
                            is_retirement: (selectedAccount as any).is_retirement ?? false,
                            retirement_account_type: (selectedAccount as any).retirement_account_type ?? null,
                        } : undefined}
                        parentGuid={parentGuid}
                        onSave={handleSave}
                        onCancel={() => setModalOpen(false)}
                    />
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/AccountHierarchy.tsx
git commit -m "feat: fetch full account data for edit modal with notes and preferences"
```

---

### Task 6: Remove Retirement Section from Account Detail Page

**Files:**
- Modify: `src/app/(main)/accounts/[guid]/page.tsx`

- [ ] **Step 1: Remove the retirement toggle section from the detail page**

In `src/app/(main)/accounts/[guid]/page.tsx`, remove the retirement account toggle section (lines 180-231 — the entire block starting with `{/* Retirement Account Toggle */}` and ending with the closing `</div>` and `)}` of that conditional block).

Also remove the related state variables (`isRetirement`, `retirementType`, `setIsRetirement`, `setRetirementType`) and the useEffect that fetches preferences for the retirement toggle, if they exist.

Search for these state declarations and remove them:
- `const [isRetirement, setIsRetirement] = useState(false);`
- `const [retirementType, setRetirementType] = useState<string | null>(null);`
- The useEffect that calls `/api/accounts/${guid}/preferences` to populate these values

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/(main)/accounts/[guid]/page.tsx
git commit -m "refactor: remove retirement toggle from detail page (moved to account modal)"
```

---

### Task 7: Manual Smoke Test

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Test creating a new account**

1. Navigate to the accounts page
2. Click "New Account"
3. Verify all fields are present: Name, Account Type (dropdown), Parent Account (dropdown), Currency (dropdown), Code, Description, Notes, Hidden/Placeholder/Tax Related checkboxes
4. Select STOCK or BANK as account type — verify the Retirement section appears
5. Toggle retirement on — verify the type dropdown appears
6. Fill in all fields and save
7. Verify the account appears in the hierarchy

- [ ] **Step 3: Test editing an existing account**

1. Click edit on an existing account
2. Verify Account Type and Currency show as read-only text
3. Verify Parent Account is editable (dropdown)
4. Verify Notes, Tax Related, and retirement fields are populated from saved data
5. Change the parent account and save — verify the account moves in the hierarchy
6. Edit notes and save — verify notes persist on re-edit

- [ ] **Step 4: Verify retirement section is removed from detail page**

1. Navigate to an investment account's detail page
2. Verify the retirement toggle section is no longer present
