# Retirement & Brokerage Contribution Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a report that surfaces total contributions to retirement and brokerage accounts over configurable time periods, with IRS limit tracking, tax-year attribution, and contribution vs. transfer classification.

**Architecture:** Extends existing report framework (`ReportType` enum + API route + report page). Adds `is_retirement` and `retirement_account_type` columns to `gnucash_web_account_preferences` table. Creates a new `gnucash_web_contribution_limits` table for editable IRS limits. Classification logic lives in a pure-function service that categorizes splits by source account type with hierarchy-aware retirement flag inheritance. Tax-year overrides stored in `gnucash_web_account_preferences`-style pattern via a new `gnucash_web_contribution_tax_year` table keyed by split GUID.

**Tech Stack:** Next.js 16 App Router, React 19, PostgreSQL, Prisma, Vitest, TypeScript

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/reports/types.ts` | Modify | Add `CONTRIBUTION_SUMMARY` to `ReportType` enum, add `ContributionReportData` interfaces |
| `src/lib/reports/contribution-summary.ts` | Create | Core report generator: classify contributions, aggregate by account+period, IRS limits |
| `src/lib/reports/contribution-classifier.ts` | Create | Pure functions: `classifyContribution()`, `getRetirementAccounts()`, `resolveContributionTaxYear()` |
| `src/lib/reports/irs-limits.ts` | Create | IRS limit defaults, DB lookup, catch-up calculation using birth date |
| `src/app/api/reports/contribution-summary/route.ts` | Create | GET endpoint for report data |
| `src/app/api/accounts/[guid]/preferences/route.ts` | Modify | Add `is_retirement` and `retirement_account_type` to PATCH handler |
| `src/app/api/contribution-limits/route.ts` | Create | GET/PUT for IRS contribution limits |
| `src/app/api/contributions/[splitGuid]/tax-year/route.ts` | Create | PUT endpoint for tax-year override per split |
| `src/app/(main)/reports/contribution_summary/page.tsx` | Create | Report page UI with summary cards, per-account table, progress bars |
| `src/components/reports/ContributionTable.tsx` | Create | Table component for contribution data with drill-down |
| `src/components/reports/ContributionLimitBar.tsx` | Create | Progress bar component for IRS limit tracking |
| `src/lib/db-init.ts` | Modify | Add `is_retirement`/`retirement_account_type` columns, create `gnucash_web_contribution_limits` and `gnucash_web_contribution_tax_year` tables |
| `prisma/schema.prisma` | Modify | Add new columns and models |
| `scripts/backfill-tax-year.ts` | Create | One-time script to parse descriptions and set tax-year overrides |
| `src/lib/__tests__/contribution-classifier.test.ts` | Create | Unit tests for classification logic |
| `src/lib/__tests__/contribution-summary.test.ts` | Create | Unit tests for report generator |
| `src/lib/__tests__/irs-limits.test.ts` | Create | Unit tests for IRS limit lookup + catch-up |

---

## Task 1: Schema Changes — Database Tables and Prisma Model

**Files:**
- Modify: `src/lib/db-init.ts`
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add columns to `gnucash_web_account_preferences` in `db-init.ts`**

Find the `accountPreferencesTableDDL` block and add an ALTER TABLE after it. Find the section where other ALTER TABLEs are executed (around line 370-410) and add:

```typescript
// Add after the accountPreferencesTableDDL execution
const accountPreferencesRetirementDDL = `
    ALTER TABLE gnucash_web_account_preferences
    ADD COLUMN IF NOT EXISTS is_retirement BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE gnucash_web_account_preferences
    ADD COLUMN IF NOT EXISTS retirement_account_type VARCHAR(20);
`;
```

The `retirement_account_type` column stores: `'401k'`, `'403b'`, `'457'`, `'traditional_ira'`, `'roth_ira'`, `'hsa'`, `'brokerage'`, or `null`.

- [ ] **Step 2: Create `gnucash_web_contribution_limits` table DDL**

Add a new DDL constant in `db-init.ts` near the other table definitions:

```typescript
const contributionLimitsTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_contribution_limits (
        id SERIAL PRIMARY KEY,
        tax_year INTEGER NOT NULL,
        account_type VARCHAR(20) NOT NULL,
        base_limit DECIMAL(12,2) NOT NULL,
        catch_up_limit DECIMAL(12,2) NOT NULL DEFAULT 0,
        catch_up_age INTEGER NOT NULL DEFAULT 50,
        notes VARCHAR(255),
        UNIQUE(tax_year, account_type)
    );
`;
```

- [ ] **Step 3: Create `gnucash_web_contribution_tax_year` table DDL**

```typescript
const contributionTaxYearTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_contribution_tax_year (
        split_guid VARCHAR(32) PRIMARY KEY,
        tax_year INTEGER NOT NULL
    );
`;
```

- [ ] **Step 4: Execute the new DDLs in `initializeDatabase()`**

Find the `initializeDatabase()` function where DDLs are executed sequentially. Add:

```typescript
await prisma.$executeRawUnsafe(accountPreferencesRetirementDDL);
await prisma.$executeRawUnsafe(contributionLimitsTableDDL);
await prisma.$executeRawUnsafe(contributionTaxYearTableDDL);
```

- [ ] **Step 5: Update Prisma schema**

In `prisma/schema.prisma`, update the `gnucash_web_account_preferences` model:

```prisma
model gnucash_web_account_preferences {
  account_guid          String   @id @db.VarChar(32)
  cost_basis_method     String?  @db.VarChar(20)
  lot_assignment_method String?  @db.VarChar(20)
  is_retirement         Boolean  @default(false)
  retirement_account_type String? @db.VarChar(20)

  @@map("gnucash_web_account_preferences")
}
```

Add new models:

```prisma
model gnucash_web_contribution_limits {
  id             Int      @id @default(autoincrement())
  tax_year       Int
  account_type   String   @db.VarChar(20)
  base_limit     Decimal  @db.Decimal(12, 2)
  catch_up_limit Decimal  @default(0) @db.Decimal(12, 2)
  catch_up_age   Int      @default(50)
  notes          String?  @db.VarChar(255)

  @@unique([tax_year, account_type])
  @@map("gnucash_web_contribution_limits")
}

model gnucash_web_contribution_tax_year {
  split_guid String @id @db.VarChar(32)
  tax_year   Int

  @@map("gnucash_web_contribution_tax_year")
}
```

- [ ] **Step 6: Generate Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client"

- [ ] **Step 7: Commit**

```bash
git add src/lib/db-init.ts prisma/schema.prisma
git commit -m "feat: add schema for contribution reports — retirement flag, IRS limits, tax-year overrides"
```

---

## Task 2: IRS Contribution Limits — Defaults and Lookup Service

**Files:**
- Create: `src/lib/reports/irs-limits.ts`
- Create: `src/lib/__tests__/irs-limits.test.ts`

- [ ] **Step 1: Write failing tests for IRS limits**

Create `src/lib/__tests__/irs-limits.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
const mockContributionLimitsFindFirst = vi.fn();
const mockContributionLimitsFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    gnucash_web_contribution_limits: {
      findFirst: (...args: unknown[]) => mockContributionLimitsFindFirst(...args),
      findMany: (...args: unknown[]) => mockContributionLimitsFindMany(...args),
    },
  },
}));

import { getContributionLimit, getDefaultLimits, calculateAge, RETIREMENT_ACCOUNT_TYPES } from '../reports/irs-limits';

describe('IRS Contribution Limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('RETIREMENT_ACCOUNT_TYPES', () => {
    it('should include all standard retirement account types', () => {
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('401k');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('traditional_ira');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('roth_ira');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('hsa');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('403b');
      expect(RETIREMENT_ACCOUNT_TYPES).toContain('457');
    });
  });

  describe('calculateAge', () => {
    it('should calculate age from birthday string', () => {
      // Person born 1980-06-15, checked on 2026-03-27
      const age = calculateAge('1980-06-15', new Date('2026-03-27'));
      expect(age).toBe(45);
    });

    it('should handle birthday not yet passed this year', () => {
      const age = calculateAge('1975-12-25', new Date('2026-03-27'));
      expect(age).toBe(50);
    });

    it('should handle birthday already passed this year', () => {
      const age = calculateAge('1975-01-01', new Date('2026-03-27'));
      expect(age).toBe(51);
    });

    it('should return null for invalid birthday', () => {
      const age = calculateAge('', new Date('2026-03-27'));
      expect(age).toBeNull();
    });
  });

  describe('getDefaultLimits', () => {
    it('should return known limits for 2025', () => {
      const limits = getDefaultLimits(2025);
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: '401k', base_limit: 23500, catch_up_limit: 7500 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000 })
      );
      expect(limits).toContainEqual(
        expect.objectContaining({ account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000 })
      );
    });

    it('should return empty array for unknown year', () => {
      const limits = getDefaultLimits(2010);
      expect(limits).toEqual([]);
    });
  });

  describe('getContributionLimit', () => {
    it('should return DB override when available', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue({
        tax_year: 2025,
        account_type: '401k',
        base_limit: 24000, // User customized
        catch_up_limit: 8000,
        catch_up_age: 50,
      });

      const limit = await getContributionLimit(2025, '401k', null);
      expect(limit).toEqual({ base: 24000, catchUp: 8000, total: 24000, catchUpAge: 50 });
    });

    it('should fall back to defaults when no DB override', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, '401k', null);
      expect(limit).toEqual({ base: 23500, catchUp: 7500, total: 23500, catchUpAge: 50 });
    });

    it('should include catch-up amount when user is over catch-up age', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      // User born 1970, checking 2025 => age 55 => over 50
      const limit = await getContributionLimit(2025, '401k', '1970-06-15');
      expect(limit).toEqual({ base: 23500, catchUp: 7500, total: 31000, catchUpAge: 50 });
    });

    it('should not include catch-up when user is under catch-up age', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      // User born 1990, checking 2025 => age 35 => under 50
      const limit = await getContributionLimit(2025, '401k', '1990-06-15');
      expect(limit).toEqual({ base: 23500, catchUp: 7500, total: 23500, catchUpAge: 50 });
    });

    it('should return null for brokerage accounts (no IRS limit)', async () => {
      mockContributionLimitsFindFirst.mockResolvedValue(null);

      const limit = await getContributionLimit(2025, 'brokerage', null);
      expect(limit).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/irs-limits.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement IRS limits service**

Create `src/lib/reports/irs-limits.ts`:

```typescript
import prisma from '@/lib/prisma';

export const RETIREMENT_ACCOUNT_TYPES = [
  '401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa',
] as const;

export type RetirementAccountType = typeof RETIREMENT_ACCOUNT_TYPES[number] | 'brokerage';

interface LimitDefaults {
  account_type: string;
  base_limit: number;
  catch_up_limit: number;
  catch_up_age: number;
}

// IRS contribution limits by year — used as fallback when no DB override exists
const DEFAULT_LIMITS: Record<number, LimitDefaults[]> = {
  2024: [
    { account_type: '401k', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '403b', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '457', base_limit: 23000, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4150, catch_up_limit: 1000, catch_up_age: 55 },
  ],
  2025: [
    { account_type: '401k', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '403b', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '457', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4300, catch_up_limit: 1000, catch_up_age: 55 },
  ],
  2026: [
    { account_type: '401k', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '403b', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: '457', base_limit: 23500, catch_up_limit: 7500, catch_up_age: 50 },
    { account_type: 'traditional_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'roth_ira', base_limit: 7000, catch_up_limit: 1000, catch_up_age: 50 },
    { account_type: 'hsa', base_limit: 4300, catch_up_limit: 1000, catch_up_age: 55 },
  ],
};

export function getDefaultLimits(year: number): LimitDefaults[] {
  return DEFAULT_LIMITS[year] ?? [];
}

export function calculateAge(birthday: string, asOfDate: Date): number | null {
  if (!birthday) return null;
  const birth = new Date(birthday);
  if (isNaN(birth.getTime())) return null;

  let age = asOfDate.getFullYear() - birth.getFullYear();
  const monthDiff = asOfDate.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOfDate.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

export interface ContributionLimitResult {
  base: number;
  catchUp: number;
  total: number;
  catchUpAge: number;
}

/**
 * Get the contribution limit for a given year and account type.
 * Checks DB for user overrides first, falls back to hardcoded defaults.
 * If birthday is provided and user is over catch-up age, total includes catch-up.
 */
export async function getContributionLimit(
  taxYear: number,
  accountType: string,
  birthday: string | null,
): Promise<ContributionLimitResult | null> {
  // Brokerage accounts have no IRS limit
  if (accountType === 'brokerage') return null;

  // Check DB for user override
  const dbLimit = await prisma.gnucash_web_contribution_limits.findFirst({
    where: { tax_year: taxYear, account_type: accountType },
  });

  let base: number;
  let catchUp: number;
  let catchUpAge: number;

  if (dbLimit) {
    base = Number(dbLimit.base_limit);
    catchUp = Number(dbLimit.catch_up_limit);
    catchUpAge = dbLimit.catch_up_age;
  } else {
    const defaults = getDefaultLimits(taxYear);
    const match = defaults.find(d => d.account_type === accountType);
    if (!match) return null;
    base = match.base_limit;
    catchUp = match.catch_up_limit;
    catchUpAge = match.catch_up_age;
  }

  // Calculate total with catch-up if applicable
  let total = base;
  if (birthday) {
    // Use end of tax year to determine age
    const ageAtYearEnd = calculateAge(birthday, new Date(`${taxYear}-12-31`));
    if (ageAtYearEnd !== null && ageAtYearEnd >= catchUpAge) {
      total = base + catchUp;
    }
  }

  return { base, catchUp, total, catchUpAge };
}

/**
 * Get all contribution limits for a year (for the settings UI).
 * Returns DB overrides merged with defaults.
 */
export async function getAllLimitsForYear(taxYear: number): Promise<Array<LimitDefaults & { isOverride: boolean }>> {
  const dbLimits = await prisma.gnucash_web_contribution_limits.findMany({
    where: { tax_year: taxYear },
  });

  const defaults = getDefaultLimits(taxYear);
  const result: Array<LimitDefaults & { isOverride: boolean }> = [];

  for (const def of defaults) {
    const override = dbLimits.find(d => d.account_type === def.account_type);
    if (override) {
      result.push({
        account_type: override.account_type,
        base_limit: Number(override.base_limit),
        catch_up_limit: Number(override.catch_up_limit),
        catch_up_age: override.catch_up_age,
        isOverride: true,
      });
    } else {
      result.push({ ...def, isOverride: false });
    }
  }

  // Add any DB-only types not in defaults
  for (const dbLimit of dbLimits) {
    if (!defaults.find(d => d.account_type === dbLimit.account_type)) {
      result.push({
        account_type: dbLimit.account_type,
        base_limit: Number(dbLimit.base_limit),
        catch_up_limit: Number(dbLimit.catch_up_limit),
        catch_up_age: dbLimit.catch_up_age,
        isOverride: true,
      });
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/irs-limits.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/irs-limits.ts src/lib/__tests__/irs-limits.test.ts
git commit -m "feat: add IRS contribution limits service with defaults and DB overrides"
```

---

## Task 3: Contribution Classifier — Pure Functions

**Files:**
- Create: `src/lib/reports/contribution-classifier.ts`
- Create: `src/lib/__tests__/contribution-classifier.test.ts`

- [ ] **Step 1: Write failing tests for contribution classification**

Create `src/lib/__tests__/contribution-classifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountsFindMany = vi.fn();
const mockAccountPreferencesFindMany = vi.fn();
const mockTaxYearFindFirst = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
    },
    gnucash_web_account_preferences: {
      findMany: (...args: unknown[]) => mockAccountPreferencesFindMany(...args),
    },
    gnucash_web_contribution_tax_year: {
      findFirst: (...args: unknown[]) => mockTaxYearFindFirst(...args),
    },
  },
}));

import {
  classifyContribution,
  ContributionType,
  getRetirementAccountGuids,
  resolveContributionTaxYear,
} from '../reports/contribution-classifier';

// Helper to build mock split objects
function mockSplit(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'split-1',
    account_guid: 'acct-retirement',
    value_num: 650000n,
    value_denom: 100n,
    quantity_num: 650000n,
    quantity_denom: 100n,
    ...overrides,
  };
}

function mockOtherSplit(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'split-2',
    account_guid: 'acct-checking',
    value_num: -650000n,
    value_denom: 100n,
    quantity_num: -650000n,
    quantity_denom: 100n,
    account: {
      account_type: 'BANK',
      commodity_guid: 'usd-guid',
      name: 'Checking Account',
    },
    ...overrides,
  };
}

describe('Contribution Classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('classifyContribution', () => {
    const retirementGuids = new Set(['acct-retirement', 'acct-retirement-cash', 'acct-401k']);

    it('should classify cash from BANK as CONTRIBUTION', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit()];

      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.CONTRIBUTION);
    });

    it('should classify cash from another retirement account as TRANSFER', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit({
        account_guid: 'acct-401k',
        account: { account_type: 'ASSET', commodity_guid: 'usd-guid', name: '401k Cash' },
      })];

      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.TRANSFER);
    });

    it('should classify cash from INCOME as EMPLOYER_MATCH when description matches', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit({
        account: { account_type: 'INCOME', commodity_guid: 'usd-guid', name: 'Employer Match' },
      })];

      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.EMPLOYER_MATCH);
    });

    it('should classify cash from INCOME (non-match) as INCOME_CONTRIBUTION', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit({
        account: { account_type: 'INCOME', commodity_guid: 'usd-guid', name: 'Salary' },
      })];

      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.INCOME_CONTRIBUTION);
    });

    it('should classify cash from EXPENSE as FEE', () => {
      const split = mockSplit();
      const otherSplits = [mockOtherSplit({
        account: { account_type: 'EXPENSE', commodity_guid: 'usd-guid', name: 'Investment Fees' },
      })];

      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.FEE);
    });

    it('should classify negative value as WITHDRAWAL', () => {
      const split = mockSplit({ value_num: -650000n });
      const otherSplits = [mockOtherSplit({ value_num: 650000n })];

      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.WITHDRAWAL);
    });

    it('should classify share transfer (same commodity, different investment accounts) as TRANSFER', () => {
      const split = mockSplit({
        quantity_num: 100000n,
        quantity_denom: 10000n,
        value_num: 0n,
      });
      const otherSplits = [mockOtherSplit({
        account_guid: 'acct-other-brokerage',
        quantity_num: -100000n,
        quantity_denom: 10000n,
        value_num: 0n,
        account: { account_type: 'STOCK', commodity_guid: 'aapl-guid', name: 'Old Brokerage:AAPL' },
      })];

      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.TRANSFER);
    });

    it('should handle multi-split with mixed sources (primary source wins)', () => {
      const split = mockSplit({ value_num: 1000000n }); // $10,000 total
      const otherSplits = [
        mockOtherSplit({ value_num: -800000n }), // $8,000 from checking (BANK)
        mockOtherSplit({
          guid: 'split-3',
          account_guid: 'acct-fee',
          value_num: -200000n,
          account: { account_type: 'EXPENSE', commodity_guid: 'usd-guid', name: 'Fee' },
        }),
      ];

      // Largest non-fee source is BANK => CONTRIBUTION
      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.CONTRIBUTION);
    });

    it('should classify zero-value split as OTHER', () => {
      const split = mockSplit({ value_num: 0n, quantity_num: 0n });
      const otherSplits = [mockOtherSplit({ value_num: 0n })];

      const result = classifyContribution(split, otherSplits, retirementGuids);
      expect(result).toBe(ContributionType.OTHER);
    });
  });

  describe('getRetirementAccountGuids', () => {
    it('should return guids of accounts flagged as retirement', async () => {
      mockAccountPreferencesFindMany.mockResolvedValue([
        { account_guid: 'guid-1', is_retirement: true },
        { account_guid: 'guid-2', is_retirement: true },
      ]);

      // Also return child accounts that are under retirement parents
      mockAccountsFindMany.mockResolvedValue([
        { guid: 'guid-1', parent_guid: 'root' },
        { guid: 'guid-1a', parent_guid: 'guid-1' }, // child of retirement
        { guid: 'guid-2', parent_guid: 'root' },
        { guid: 'guid-3', parent_guid: 'root' }, // not retirement
      ]);

      const result = await getRetirementAccountGuids(['guid-1', 'guid-1a', 'guid-2', 'guid-3']);
      expect(result).toContain('guid-1');
      expect(result).toContain('guid-1a'); // inherited from parent
      expect(result).toContain('guid-2');
      expect(result).not.toContain('guid-3');
    });

    it('should return empty set when no accounts are flagged', async () => {
      mockAccountPreferencesFindMany.mockResolvedValue([]);
      mockAccountsFindMany.mockResolvedValue([]);

      const result = await getRetirementAccountGuids([]);
      expect(result.size).toBe(0);
    });
  });

  describe('resolveContributionTaxYear', () => {
    it('should return override tax year when set', async () => {
      mockTaxYearFindFirst.mockResolvedValue({ split_guid: 'split-1', tax_year: 2024 });

      const year = await resolveContributionTaxYear('split-1', new Date('2025-02-15'));
      expect(year).toBe(2024);
    });

    it('should return calendar year from post_date when no override', async () => {
      mockTaxYearFindFirst.mockResolvedValue(null);

      const year = await resolveContributionTaxYear('split-1', new Date('2025-07-20'));
      expect(year).toBe(2025);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/contribution-classifier.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement contribution classifier**

Create `src/lib/reports/contribution-classifier.ts`:

```typescript
import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';

export enum ContributionType {
  CONTRIBUTION = 'contribution',           // Cash from non-retirement source
  INCOME_CONTRIBUTION = 'income_contribution', // Cash from income account (payroll)
  EMPLOYER_MATCH = 'employer_match',       // Employer match (from income account with "match" keyword)
  TRANSFER = 'transfer',                   // Between retirement/investment accounts (rollover, ACAT)
  FEE = 'fee',                             // From expense account
  WITHDRAWAL = 'withdrawal',               // Negative value (money out)
  DIVIDEND = 'dividend',                   // Dividend/distribution
  OTHER = 'other',                         // Unclassifiable
}

interface SplitLike {
  guid: string;
  account_guid: string;
  value_num: bigint;
  value_denom: bigint;
  quantity_num: bigint;
  quantity_denom: bigint;
}

interface OtherSplitLike extends SplitLike {
  account?: {
    account_type?: string | null;
    commodity_guid?: string | null;
    name?: string | null;
  } | null;
}

const MATCH_KEYWORDS = ['match', 'employer'];
const DIVIDEND_KEYWORDS = ['dividend', 'distribution', 'interest'];

/**
 * Classify a split in a retirement/brokerage account as a contribution type.
 * Uses the source account type to determine classification.
 */
export function classifyContribution(
  split: SplitLike,
  otherSplits: OtherSplitLike[],
  retirementGuids: Set<string>,
): ContributionType {
  const value = toDecimalNumber(split.value_num, split.value_denom);
  const quantity = toDecimalNumber(split.quantity_num, split.quantity_denom);

  // Zero value and zero quantity — not meaningful
  if (value === 0 && quantity === 0) return ContributionType.OTHER;

  // Negative value — money flowing OUT of the account
  if (value < 0) return ContributionType.WITHDRAWAL;

  // Check if this is a share transfer (quantity moves, value may be 0 or minimal)
  // Another investment account sending the same shares
  const shareTransferSource = otherSplits.find(s => {
    const otherQty = toDecimalNumber(s.quantity_num, s.quantity_denom);
    const acctType = s.account?.account_type;
    return otherQty < 0 && (acctType === 'STOCK' || acctType === 'MUTUAL');
  });
  if (shareTransferSource) return ContributionType.TRANSFER;

  // Find the primary cash source (largest absolute value among other splits)
  const cashSources = otherSplits
    .filter(s => {
      const v = toDecimalNumber(s.value_num, s.value_denom);
      return v < 0; // Money flowing out of source = into our account
    })
    .sort((a, b) => {
      const va = Math.abs(toDecimalNumber(a.value_num, a.value_denom));
      const vb = Math.abs(toDecimalNumber(b.value_num, b.value_denom));
      return vb - va; // Largest first
    });

  if (cashSources.length === 0) return ContributionType.OTHER;

  const primarySource = cashSources[0];
  const sourceType = primarySource.account?.account_type ?? '';
  const sourceName = (primarySource.account?.name ?? '').toLowerCase();

  // Source is another retirement account → TRANSFER (rollover)
  if (retirementGuids.has(primarySource.account_guid)) {
    return ContributionType.TRANSFER;
  }

  // Source is INCOME account
  if (sourceType === 'INCOME') {
    // Check for employer match keywords
    if (MATCH_KEYWORDS.some(kw => sourceName.includes(kw))) {
      return ContributionType.EMPLOYER_MATCH;
    }
    // Check for dividend keywords
    if (DIVIDEND_KEYWORDS.some(kw => sourceName.includes(kw))) {
      return ContributionType.DIVIDEND;
    }
    // Other income (e.g., payroll deduction)
    return ContributionType.INCOME_CONTRIBUTION;
  }

  // Source is EXPENSE account → FEE (rare: fee reversal credited to account)
  if (sourceType === 'EXPENSE') {
    return ContributionType.FEE;
  }

  // Source is BANK, ASSET, CASH, or other non-investment, non-retirement
  if (['BANK', 'ASSET', 'CASH', 'RECEIVABLE'].includes(sourceType)) {
    return ContributionType.CONTRIBUTION;
  }

  // Source is another STOCK/MUTUAL (non-retirement) — brokerage transfer
  if (['STOCK', 'MUTUAL'].includes(sourceType)) {
    return ContributionType.TRANSFER;
  }

  return ContributionType.OTHER;
}

/**
 * Get the set of all retirement account GUIDs, including children of retirement-flagged parents.
 * Walks the account hierarchy: if a parent is flagged is_retirement, all descendants inherit.
 */
export async function getRetirementAccountGuids(
  bookAccountGuids: string[],
): Promise<Set<string>> {
  if (bookAccountGuids.length === 0) return new Set();

  // Get directly flagged accounts
  const flaggedPrefs = await prisma.gnucash_web_account_preferences.findMany({
    where: { is_retirement: true },
    select: { account_guid: true },
  });
  const flaggedGuids = new Set(flaggedPrefs.map(p => p.account_guid));

  if (flaggedGuids.size === 0) return new Set();

  // Get all accounts in book with parent info for hierarchy walking
  const allAccounts = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids } },
    select: { guid: true, parent_guid: true },
  });

  // Build parent->children map
  const childrenOf = new Map<string, string[]>();
  for (const acct of allAccounts) {
    if (acct.parent_guid) {
      const children = childrenOf.get(acct.parent_guid) ?? [];
      children.push(acct.guid);
      childrenOf.set(acct.parent_guid, children);
    }
  }

  // BFS from each flagged account to include all descendants
  const retirementGuids = new Set<string>();
  const queue = [...flaggedGuids];
  while (queue.length > 0) {
    const guid = queue.pop()!;
    if (!bookAccountGuids.includes(guid)) continue; // Only book accounts
    retirementGuids.add(guid);
    const children = childrenOf.get(guid) ?? [];
    for (const child of children) {
      if (!retirementGuids.has(child)) {
        queue.push(child);
      }
    }
  }

  return retirementGuids;
}

/**
 * Get the retirement_account_type for a given account GUID.
 * Walks up the hierarchy to find the nearest flagged ancestor's type.
 */
export async function getRetirementAccountType(
  accountGuid: string,
  bookAccountGuids: string[],
): Promise<string | null> {
  // Check direct preference
  const directPref = await prisma.gnucash_web_account_preferences.findFirst({
    where: { account_guid: accountGuid, is_retirement: true },
    select: { retirement_account_type: true },
  });
  if (directPref?.retirement_account_type) return directPref.retirement_account_type;

  // Walk up hierarchy
  const allAccounts = await prisma.accounts.findMany({
    where: { guid: { in: bookAccountGuids } },
    select: { guid: true, parent_guid: true },
  });
  const parentOf = new Map(allAccounts.map(a => [a.guid, a.parent_guid]));

  let current = parentOf.get(accountGuid);
  while (current) {
    const pref = await prisma.gnucash_web_account_preferences.findFirst({
      where: { account_guid: current, is_retirement: true },
      select: { retirement_account_type: true },
    });
    if (pref?.retirement_account_type) return pref.retirement_account_type;
    current = parentOf.get(current) ?? null;
  }

  return null;
}

/**
 * Resolve the tax year for a contribution.
 * Checks for a manual override first, falls back to calendar year from post_date.
 */
export async function resolveContributionTaxYear(
  splitGuid: string,
  postDate: Date,
): Promise<number> {
  const override = await prisma.gnucash_web_contribution_tax_year.findFirst({
    where: { split_guid: splitGuid },
  });

  if (override) return override.tax_year;

  return postDate.getFullYear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/contribution-classifier.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/contribution-classifier.ts src/lib/__tests__/contribution-classifier.test.ts
git commit -m "feat: add contribution classifier with source-type classification and hierarchy inheritance"
```

---

## Task 4: Report Generator — Aggregate Contributions

**Files:**
- Create: `src/lib/reports/contribution-summary.ts`
- Create: `src/lib/__tests__/contribution-summary.test.ts`
- Modify: `src/lib/reports/types.ts`

- [ ] **Step 1: Add types to `src/lib/reports/types.ts`**

Add `CONTRIBUTION_SUMMARY` to the `ReportType` enum:

```typescript
// Add to ReportType enum
CONTRIBUTION_SUMMARY = 'contribution_summary',
```

Add to the `REPORTS` array:

```typescript
{
  type: ReportType.CONTRIBUTION_SUMMARY,
  name: 'Contribution Summary',
  description: 'Retirement and brokerage account contributions with IRS limit tracking',
  icon: 'trending',
  category: 'investment',
},
```

Add these interfaces at the end of the file (before the closing exports):

```typescript
export interface ContributionLineItem {
  splitGuid: string;
  date: string;
  description: string;
  amount: number;
  type: string; // ContributionType value
  taxYear: number;
  sourceAccountName: string;
}

export interface AccountContributionSummary {
  accountGuid: string;
  accountName: string;
  accountPath: string;
  retirementAccountType: string | null;
  contributions: number;
  employerMatch: number;
  incomeContributions: number;
  transfers: number;
  withdrawals: number;
  netContributions: number;
  irsLimit: {
    base: number;
    catchUp: number;
    total: number;
    percentUsed: number;
  } | null;
  transactions: ContributionLineItem[];
}

export interface ContributionSummaryData extends ReportDataBase {
  type: ReportType.CONTRIBUTION_SUMMARY;
  groupBy: 'tax_year' | 'calendar_year';
  periods: Array<{
    year: number;
    accounts: AccountContributionSummary[];
    totalContributions: number;
    totalEmployerMatch: number;
    totalTransfers: number;
    totalWithdrawals: number;
    totalNetContributions: number;
  }>;
  grandTotalContributions: number;
  grandTotalEmployerMatch: number;
  grandTotalNetContributions: number;
}
```

- [ ] **Step 2: Write failing test for report generator**

Create `src/lib/__tests__/contribution-summary.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSplitsFindMany = vi.fn();
const mockAccountsFindMany = vi.fn();
const mockAccountPreferencesFindMany = vi.fn();
const mockAccountPreferencesFindFirst = vi.fn();
const mockContributionLimitsFindFirst = vi.fn();
const mockContributionLimitsFindMany = vi.fn();
const mockTaxYearFindFirst = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    splits: {
      findMany: (...args: unknown[]) => mockSplitsFindMany(...args),
    },
    accounts: {
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
    },
    gnucash_web_account_preferences: {
      findMany: (...args: unknown[]) => mockAccountPreferencesFindMany(...args),
      findFirst: (...args: unknown[]) => mockAccountPreferencesFindFirst(...args),
    },
    gnucash_web_contribution_limits: {
      findFirst: (...args: unknown[]) => mockContributionLimitsFindFirst(...args),
      findMany: (...args: unknown[]) => mockContributionLimitsFindMany(...args),
    },
    gnucash_web_contribution_tax_year: {
      findFirst: (...args: unknown[]) => mockTaxYearFindFirst(...args),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

// Mock user preferences for birthday
vi.mock('../../app/api/user/preferences/route', () => ({}));

import { generateContributionSummary } from '../reports/contribution-summary';
import { ReportType } from '../reports/types';

describe('Contribution Summary Generator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContributionLimitsFindFirst.mockResolvedValue(null);
    mockContributionLimitsFindMany.mockResolvedValue([]);
    mockTaxYearFindFirst.mockResolvedValue(null);
  });

  it('should generate empty report when no retirement accounts exist', async () => {
    mockAccountPreferencesFindMany.mockResolvedValue([]);
    mockAccountsFindMany.mockResolvedValue([]);

    const result = await generateContributionSummary({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      bookAccountGuids: ['acct-1'],
    }, 'calendar_year', null);

    expect(result.type).toBe(ReportType.CONTRIBUTION_SUMMARY);
    expect(result.periods).toEqual([]);
    expect(result.grandTotalContributions).toBe(0);
  });

  it('should aggregate contributions by calendar year', async () => {
    // Setup: one retirement account with two contributions
    mockAccountPreferencesFindMany.mockResolvedValue([
      { account_guid: 'roth-ira', is_retirement: true, retirement_account_type: 'roth_ira' },
    ]);
    mockAccountsFindMany.mockResolvedValue([
      { guid: 'roth-ira', parent_guid: 'root', name: 'Roth IRA', commodity_guid: 'usd' },
    ]);
    mockAccountPreferencesFindFirst.mockResolvedValue({
      account_guid: 'roth-ira',
      is_retirement: true,
      retirement_account_type: 'roth_ira',
    });

    // Mock the batch query for splits with source account info
    mockQueryRaw.mockResolvedValue([
      {
        split_guid: 'split-1',
        account_guid: 'roth-ira',
        value_num: 350000n,
        value_denom: 100n,
        quantity_num: 350000n,
        quantity_denom: 100n,
        post_date: new Date('2025-03-15'),
        description: 'Roth IRA Contribution',
        other_split_guid: 'split-1b',
        other_account_guid: 'checking',
        other_value_num: -350000n,
        other_value_denom: 100n,
        other_quantity_num: -350000n,
        other_quantity_denom: 100n,
        other_account_type: 'BANK',
        other_account_name: 'Checking',
        other_commodity_guid: 'usd',
      },
      {
        split_guid: 'split-2',
        account_guid: 'roth-ira',
        value_num: 350000n,
        value_denom: 100n,
        quantity_num: 350000n,
        quantity_denom: 100n,
        post_date: new Date('2025-09-15'),
        description: 'Roth IRA Contribution',
        other_split_guid: 'split-2b',
        other_account_guid: 'checking',
        other_value_num: -350000n,
        other_value_denom: 100n,
        other_quantity_num: -350000n,
        other_quantity_denom: 100n,
        other_account_type: 'BANK',
        other_account_name: 'Checking',
        other_commodity_guid: 'usd',
      },
    ]);

    // Mock account_hierarchy for fullname
    mockAccountsFindMany.mockResolvedValue([
      { guid: 'roth-ira', parent_guid: 'root', name: 'Roth IRA' },
    ]);

    const result = await generateContributionSummary({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      bookAccountGuids: ['roth-ira', 'checking'],
    }, 'calendar_year', null);

    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].year).toBe(2025);
    expect(result.periods[0].totalContributions).toBe(7000); // 3500 + 3500
    expect(result.grandTotalContributions).toBe(7000);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/contribution-summary.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement report generator**

Create `src/lib/reports/contribution-summary.ts`:

```typescript
import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import {
  ReportType,
  ReportFilters,
  ContributionSummaryData,
  AccountContributionSummary,
  ContributionLineItem,
} from './types';
import {
  classifyContribution,
  ContributionType,
  getRetirementAccountGuids,
  getRetirementAccountType,
  resolveContributionTaxYear,
} from './contribution-classifier';
import { getContributionLimit } from './irs-limits';

interface RawContributionRow {
  split_guid: string;
  account_guid: string;
  value_num: bigint;
  value_denom: bigint;
  quantity_num: bigint;
  quantity_denom: bigint;
  post_date: Date;
  description: string;
  other_split_guid: string;
  other_account_guid: string;
  other_value_num: bigint;
  other_value_denom: bigint;
  other_quantity_num: bigint;
  other_quantity_denom: bigint;
  other_account_type: string;
  other_account_name: string;
  other_commodity_guid: string;
}

/**
 * Generate the Contribution Summary report.
 *
 * Batch-loads all splits for retirement accounts in the date range with a single query,
 * classifies each as contribution/transfer/match/etc., groups by account and period.
 */
export async function generateContributionSummary(
  filters: ReportFilters,
  groupBy: 'tax_year' | 'calendar_year',
  birthday: string | null,
): Promise<ContributionSummaryData> {
  const bookAccountGuids = filters.bookAccountGuids ?? [];

  // 1. Get all retirement account GUIDs (including inherited children)
  const retirementGuids = await getRetirementAccountGuids(bookAccountGuids);

  if (retirementGuids.size === 0) {
    return emptyReport(filters, groupBy);
  }

  const retirementGuidArray = [...retirementGuids];

  // 2. Build date range
  const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : null;
  const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

  // 3. Batch query: all splits in retirement accounts with their counterpart splits
  // This is the single batch query that avoids N+1
  const dateFilter = startDate
    ? `AND t.post_date >= '${startDate.toISOString()}' AND t.post_date <= '${endDate.toISOString()}'`
    : `AND t.post_date <= '${endDate.toISOString()}'`;

  const guidList = retirementGuidArray.map(g => `'${g}'`).join(',');

  const rows: RawContributionRow[] = await prisma.$queryRaw`
    SELECT
      s.guid as split_guid,
      s.account_guid,
      s.value_num, s.value_denom,
      s.quantity_num, s.quantity_denom,
      t.post_date, t.description,
      s2.guid as other_split_guid,
      s2.account_guid as other_account_guid,
      s2.value_num as other_value_num, s2.value_denom as other_value_denom,
      s2.quantity_num as other_quantity_num, s2.quantity_denom as other_quantity_denom,
      a2.account_type as other_account_type,
      a2.name as other_account_name,
      a2.commodity_guid as other_commodity_guid
    FROM splits s
    JOIN transactions t ON s.tx_guid = t.guid
    JOIN splits s2 ON s2.tx_guid = t.guid AND s2.guid != s.guid
    JOIN accounts a2 ON s2.account_guid = a2.guid
    WHERE s.account_guid = ANY(${retirementGuidArray})
      AND t.post_date >= ${startDate ?? new Date('1970-01-01')}
      AND t.post_date <= ${endDate}
    ORDER BY t.post_date ASC
  `;

  // 4. Group rows by split_guid (a single split may have multiple other splits)
  const splitMap = new Map<string, {
    split: RawContributionRow;
    otherSplits: RawContributionRow[];
  }>();

  for (const row of rows) {
    const existing = splitMap.get(row.split_guid);
    if (existing) {
      existing.otherSplits.push(row);
    } else {
      splitMap.set(row.split_guid, { split: row, otherSplits: [row] });
    }
  }

  // 5. Classify each split and resolve tax year
  const classifiedItems: Array<{
    accountGuid: string;
    item: ContributionLineItem;
    type: ContributionType;
  }> = [];

  for (const [, { split, otherSplits }] of splitMap) {
    const splitObj = {
      guid: split.split_guid,
      account_guid: split.account_guid,
      value_num: split.value_num,
      value_denom: split.value_denom,
      quantity_num: split.quantity_num,
      quantity_denom: split.quantity_denom,
    };

    const otherSplitObjs = otherSplits.map(os => ({
      guid: os.other_split_guid,
      account_guid: os.other_account_guid,
      value_num: os.other_value_num,
      value_denom: os.other_value_denom,
      quantity_num: os.other_quantity_num,
      quantity_denom: os.other_quantity_denom,
      account: {
        account_type: os.other_account_type,
        commodity_guid: os.other_commodity_guid,
        name: os.other_account_name,
      },
    }));

    const type = classifyContribution(splitObj, otherSplitObjs, retirementGuids);
    const taxYear = groupBy === 'tax_year'
      ? await resolveContributionTaxYear(split.split_guid, split.post_date)
      : split.post_date.getFullYear();

    const amount = toDecimalNumber(split.value_num, split.value_denom);

    classifiedItems.push({
      accountGuid: split.account_guid,
      type,
      item: {
        splitGuid: split.split_guid,
        date: split.post_date.toISOString().split('T')[0],
        description: split.description,
        amount,
        type,
        taxYear,
        sourceAccountName: otherSplits[0]?.other_account_name ?? 'Unknown',
      },
    });
  }

  // 6. Get account names via account_hierarchy
  const accountNames = await prisma.accounts.findMany({
    where: { guid: { in: retirementGuidArray } },
    select: { guid: true, name: true },
  });
  const accountNameMap = new Map(accountNames.map(a => [a.guid, a.name]));

  // Get account paths from hierarchy view
  const accountPaths: Array<{ guid: string; fullname: string }> = await prisma.$queryRaw`
    SELECT guid, fullname FROM account_hierarchy WHERE guid = ANY(${retirementGuidArray})
  `;
  const accountPathMap = new Map(accountPaths.map(a => [a.guid, a.fullname]));

  // 7. Group by year and account
  const yearAccountMap = new Map<number, Map<string, ContributionLineItem[]>>();

  for (const { accountGuid, item } of classifiedItems) {
    const year = item.taxYear;
    if (!yearAccountMap.has(year)) yearAccountMap.set(year, new Map());
    const accountMap = yearAccountMap.get(year)!;
    if (!accountMap.has(accountGuid)) accountMap.set(accountGuid, []);
    accountMap.get(accountGuid)!.push(item);
  }

  // 8. Build period summaries with IRS limits
  const periods: ContributionSummaryData['periods'] = [];

  for (const [year, accountMap] of [...yearAccountMap.entries()].sort((a, b) => b[0] - a[0])) {
    const accounts: AccountContributionSummary[] = [];

    for (const [accountGuid, items] of accountMap) {
      const retirementType = await getRetirementAccountType(accountGuid, bookAccountGuids);

      const contributions = items
        .filter(i => i.type === ContributionType.CONTRIBUTION)
        .reduce((sum, i) => sum + i.amount, 0);
      const employerMatch = items
        .filter(i => i.type === ContributionType.EMPLOYER_MATCH)
        .reduce((sum, i) => sum + i.amount, 0);
      const incomeContributions = items
        .filter(i => i.type === ContributionType.INCOME_CONTRIBUTION)
        .reduce((sum, i) => sum + i.amount, 0);
      const transfers = items
        .filter(i => i.type === ContributionType.TRANSFER)
        .reduce((sum, i) => sum + i.amount, 0);
      const withdrawals = items
        .filter(i => i.type === ContributionType.WITHDRAWAL)
        .reduce((sum, i) => sum + i.amount, 0);

      const netContributions = contributions + incomeContributions + employerMatch;

      // IRS limit check
      let irsLimit: AccountContributionSummary['irsLimit'] = null;
      if (retirementType) {
        const limit = await getContributionLimit(year, retirementType, birthday);
        if (limit) {
          // Employee contributions only (not employer match) count toward IRS limit
          const employeeContributions = contributions + incomeContributions;
          irsLimit = {
            base: limit.base,
            catchUp: limit.catchUp,
            total: limit.total,
            percentUsed: limit.total > 0 ? Math.round((employeeContributions / limit.total) * 100) : 0,
          };
        }
      }

      accounts.push({
        accountGuid,
        accountName: accountNameMap.get(accountGuid) ?? 'Unknown',
        accountPath: accountPathMap.get(accountGuid) ?? accountNameMap.get(accountGuid) ?? 'Unknown',
        retirementAccountType: retirementType,
        contributions,
        employerMatch,
        incomeContributions,
        transfers,
        withdrawals,
        netContributions,
        irsLimit,
        transactions: items.sort((a, b) => a.date.localeCompare(b.date)),
      });
    }

    accounts.sort((a, b) => a.accountPath.localeCompare(b.accountPath));

    periods.push({
      year,
      accounts,
      totalContributions: accounts.reduce((s, a) => s + a.contributions + a.incomeContributions, 0),
      totalEmployerMatch: accounts.reduce((s, a) => s + a.employerMatch, 0),
      totalTransfers: accounts.reduce((s, a) => s + a.transfers, 0),
      totalWithdrawals: accounts.reduce((s, a) => s + a.withdrawals, 0),
      totalNetContributions: accounts.reduce((s, a) => s + a.netContributions, 0),
    });
  }

  return {
    type: ReportType.CONTRIBUTION_SUMMARY,
    title: 'Contribution Summary',
    generatedAt: new Date().toISOString(),
    filters,
    groupBy,
    periods,
    grandTotalContributions: periods.reduce((s, p) => s + p.totalContributions, 0),
    grandTotalEmployerMatch: periods.reduce((s, p) => s + p.totalEmployerMatch, 0),
    grandTotalNetContributions: periods.reduce((s, p) => s + p.totalNetContributions, 0),
  };
}

function emptyReport(filters: ReportFilters, groupBy: 'tax_year' | 'calendar_year'): ContributionSummaryData {
  return {
    type: ReportType.CONTRIBUTION_SUMMARY,
    title: 'Contribution Summary',
    generatedAt: new Date().toISOString(),
    filters,
    groupBy,
    periods: [],
    grandTotalContributions: 0,
    grandTotalEmployerMatch: 0,
    grandTotalNetContributions: 0,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/contribution-summary.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/types.ts src/lib/reports/contribution-summary.ts src/lib/__tests__/contribution-summary.test.ts
git commit -m "feat: add contribution summary report generator with classification, aggregation, and IRS limits"
```

---

## Task 5: API Routes

**Files:**
- Create: `src/app/api/reports/contribution-summary/route.ts`
- Create: `src/app/api/contribution-limits/route.ts`
- Create: `src/app/api/contributions/[splitGuid]/tax-year/route.ts`
- Modify: `src/app/api/accounts/[guid]/preferences/route.ts`

- [ ] **Step 1: Create contribution summary API route**

Create `src/app/api/reports/contribution-summary/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generateContributionSummary } from '@/lib/reports/contribution-summary';
import { ReportFilters } from '@/lib/reports/types';

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const bookAccountGuids = await getBookAccountGuids();

    const filters: ReportFilters = {
      startDate: searchParams.get('startDate'),
      endDate: searchParams.get('endDate'),
      bookAccountGuids,
    };

    const groupBy = (searchParams.get('groupBy') === 'tax_year' ? 'tax_year' : 'calendar_year') as 'tax_year' | 'calendar_year';
    const birthday = searchParams.get('birthday') || null;

    const report = await generateContributionSummary(filters, groupBy, birthday);

    return NextResponse.json(report);
  } catch (error) {
    console.error('Error generating contribution summary:', error);
    return NextResponse.json(
      { error: 'Failed to generate contribution summary' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Create contribution limits API route**

Create `src/app/api/contribution-limits/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getAllLimitsForYear } from '@/lib/reports/irs-limits';

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString());

    if (isNaN(year)) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }

    const limits = await getAllLimitsForYear(year);
    return NextResponse.json({ year, limits });
  } catch (error) {
    console.error('Error fetching contribution limits:', error);
    return NextResponse.json({ error: 'Failed to fetch contribution limits' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { tax_year, account_type, base_limit, catch_up_limit, catch_up_age, notes } = body;

    if (!tax_year || !account_type || base_limit === undefined) {
      return NextResponse.json({ error: 'Missing required fields: tax_year, account_type, base_limit' }, { status: 400 });
    }

    await prisma.$executeRaw`
      INSERT INTO gnucash_web_contribution_limits (tax_year, account_type, base_limit, catch_up_limit, catch_up_age, notes)
      VALUES (${tax_year}, ${account_type}, ${base_limit}, ${catch_up_limit ?? 0}, ${catch_up_age ?? 50}, ${notes ?? null})
      ON CONFLICT (tax_year, account_type)
      DO UPDATE SET
        base_limit = ${base_limit},
        catch_up_limit = ${catch_up_limit ?? 0},
        catch_up_age = ${catch_up_age ?? 50},
        notes = ${notes ?? null}
    `;

    const limits = await getAllLimitsForYear(tax_year);
    return NextResponse.json({ year: tax_year, limits });
  } catch (error) {
    console.error('Error updating contribution limit:', error);
    return NextResponse.json({ error: 'Failed to update contribution limit' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create tax-year override API route**

Create `src/app/api/contributions/[splitGuid]/tax-year/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ splitGuid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { splitGuid } = await params;
    const body = await request.json();
    const { taxYear } = body;

    if (!taxYear || typeof taxYear !== 'number') {
      return NextResponse.json({ error: 'Invalid taxYear' }, { status: 400 });
    }

    // Verify split exists
    const split = await prisma.splits.findUnique({ where: { guid: splitGuid } });
    if (!split) {
      return NextResponse.json({ error: 'Split not found' }, { status: 404 });
    }

    await prisma.$executeRaw`
      INSERT INTO gnucash_web_contribution_tax_year (split_guid, tax_year)
      VALUES (${splitGuid}, ${taxYear})
      ON CONFLICT (split_guid)
      DO UPDATE SET tax_year = ${taxYear}
    `;

    return NextResponse.json({ splitGuid, taxYear });
  } catch (error) {
    console.error('Error updating tax year override:', error);
    return NextResponse.json({ error: 'Failed to update tax year' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ splitGuid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { splitGuid } = await params;

    await prisma.$executeRaw`
      DELETE FROM gnucash_web_contribution_tax_year WHERE split_guid = ${splitGuid}
    `;

    return NextResponse.json({ splitGuid, taxYear: null });
  } catch (error) {
    console.error('Error removing tax year override:', error);
    return NextResponse.json({ error: 'Failed to remove tax year override' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Update account preferences route to support retirement flag**

In `src/app/api/accounts/[guid]/preferences/route.ts`, update the GET handler to include the new columns. Find the SELECT query and update it:

Replace the existing `SELECT account_guid, cost_basis_method, lot_assignment_method` query with:

```typescript
const rows = await prisma.$queryRaw<{ account_guid: string; cost_basis_method: string | null; lot_assignment_method: string | null; is_retirement: boolean; retirement_account_type: string | null }[]>`
  SELECT account_guid, cost_basis_method, lot_assignment_method, is_retirement, retirement_account_type
  FROM gnucash_web_account_preferences
  WHERE account_guid = ${guid}
`;

if (rows.length === 0) {
  return NextResponse.json({ account_guid: guid, cost_basis_method: null, lot_assignment_method: null, is_retirement: false, retirement_account_type: null });
}
```

Add validation for the new fields in the PATCH handler. After the `lot_assignment_method` validation block, add:

```typescript
const VALID_RETIREMENT_TYPES = ['401k', '403b', '457', 'traditional_ira', 'roth_ira', 'hsa', 'brokerage'];

if ('retirement_account_type' in body) {
  const { retirement_account_type } = body;
  if (retirement_account_type !== null && retirement_account_type !== undefined &&
      !VALID_RETIREMENT_TYPES.includes(retirement_account_type)) {
    return NextResponse.json(
      { error: `Invalid retirement_account_type. Must be one of: ${VALID_RETIREMENT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }
}
```

Update the INSERT/UPDATE queries to include the new columns. The simplest approach: add a new branch for when `is_retirement` or `retirement_account_type` is in the body. After all existing branches, add handling for the retirement fields:

```typescript
const hasRetirement = 'is_retirement' in body;
const hasRetirementType = 'retirement_account_type' in body;

if (hasRetirement || hasRetirementType) {
  const isRetirement = hasRetirement ? (body.is_retirement ?? false) : undefined;
  const retirementType = hasRetirementType ? (body.retirement_account_type ?? null) : undefined;

  // Use raw query for upsert with all fields
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_account_preferences (account_guid, is_retirement, retirement_account_type)
    VALUES (${guid}, ${isRetirement ?? false}, ${retirementType ?? null})
    ON CONFLICT (account_guid)
    DO UPDATE SET
      is_retirement = COALESCE(${isRetirement}, gnucash_web_account_preferences.is_retirement),
      retirement_account_type = COALESCE(${retirementType}, gnucash_web_account_preferences.retirement_account_type)
  `;
}
```

Update the return query to include the new columns:

```typescript
const rows = await prisma.$queryRaw<{ account_guid: string; cost_basis_method: string | null; lot_assignment_method: string | null; is_retirement: boolean; retirement_account_type: string | null }[]>`
  SELECT account_guid, cost_basis_method, lot_assignment_method, is_retirement, retirement_account_type
  FROM gnucash_web_account_preferences
  WHERE account_guid = ${guid}
`;

return NextResponse.json(rows[0] ?? { account_guid: guid, cost_basis_method: null, lot_assignment_method: null, is_retirement: false, retirement_account_type: null });
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/reports/contribution-summary/route.ts src/app/api/contribution-limits/route.ts src/app/api/contributions/ src/app/api/accounts/[guid]/preferences/route.ts
git commit -m "feat: add API routes for contribution summary, IRS limits, tax-year overrides, and retirement flag"
```

---

## Task 6: Report Page UI

**Files:**
- Create: `src/app/(main)/reports/contribution_summary/page.tsx`
- Create: `src/components/reports/ContributionTable.tsx`
- Create: `src/components/reports/ContributionLimitBar.tsx`

- [ ] **Step 1: Create the progress bar component**

Create `src/components/reports/ContributionLimitBar.tsx`:

```typescript
'use client';

import { formatCurrency } from '@/lib/format';

interface ContributionLimitBarProps {
  current: number;
  limit: number;
  label: string;
  catchUp?: number;
}

export function ContributionLimitBar({ current, limit, label, catchUp }: ContributionLimitBarProps) {
  const percent = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
  const isOver = current > limit;

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-foreground-secondary">{label}</span>
        <span className={isOver ? 'text-red-400 font-medium' : 'text-foreground-secondary'}>
          {formatCurrency(current)} / {formatCurrency(limit)}
          {catchUp ? ` (incl. ${formatCurrency(catchUp)} catch-up)` : ''}
        </span>
      </div>
      <div className="h-2 bg-background-tertiary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            isOver ? 'bg-red-500' : percent >= 90 ? 'bg-yellow-500' : 'bg-cyan-500'
          }`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <div className="text-right text-xs text-foreground-tertiary">
        {percent}% of limit
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the contribution table component**

Create `src/components/reports/ContributionTable.tsx`:

```typescript
'use client';

import { useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { ContributionLimitBar } from './ContributionLimitBar';
import { AccountContributionSummary, ContributionLineItem } from '@/lib/reports/types';

interface ContributionTableProps {
  accounts: AccountContributionSummary[];
  year: number;
  onTaxYearChange?: (splitGuid: string, newYear: number) => void;
}

const TYPE_LABELS: Record<string, string> = {
  contribution: 'Contribution',
  income_contribution: 'Payroll',
  employer_match: 'Employer Match',
  transfer: 'Transfer/Rollover',
  fee: 'Fee',
  withdrawal: 'Withdrawal',
  dividend: 'Dividend',
  other: 'Other',
};

const TYPE_COLORS: Record<string, string> = {
  contribution: 'text-green-400',
  income_contribution: 'text-green-400',
  employer_match: 'text-cyan-400',
  transfer: 'text-foreground-secondary',
  fee: 'text-red-400',
  withdrawal: 'text-red-400',
  dividend: 'text-yellow-400',
  other: 'text-foreground-tertiary',
};

export function ContributionTable({ accounts, year, onTaxYearChange }: ContributionTableProps) {
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {accounts.map((account) => (
        <div key={account.accountGuid} className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
          {/* Account header — clickable to expand */}
          <button
            onClick={() => setExpandedAccount(expandedAccount === account.accountGuid ? null : account.accountGuid)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-background-tertiary/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <svg
                className={`w-4 h-4 text-foreground-tertiary transition-transform ${expandedAccount === account.accountGuid ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <div className="text-left">
                <div className="text-sm font-medium text-foreground">{account.accountName}</div>
                <div className="text-xs text-foreground-tertiary">{account.accountPath}</div>
              </div>
              {account.retirementAccountType && (
                <span className="px-2 py-0.5 text-xs rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                  {account.retirementAccountType.replace('_', ' ').toUpperCase()}
                </span>
              )}
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-foreground">
                {formatCurrency(account.netContributions)}
              </div>
              <div className="text-xs text-foreground-tertiary">
                {account.transactions.length} transactions
              </div>
            </div>
          </button>

          {/* IRS limit progress bar */}
          {account.irsLimit && (
            <div className="px-4 pb-3 border-t border-border/50">
              <ContributionLimitBar
                current={account.contributions + account.incomeContributions}
                limit={account.irsLimit.total}
                label={`${year} ${account.retirementAccountType?.replace('_', ' ').toUpperCase() ?? ''} Limit`}
                catchUp={account.irsLimit.catchUp > 0 && account.irsLimit.total > account.irsLimit.base ? account.irsLimit.catchUp : undefined}
              />
            </div>
          )}

          {/* Summary row */}
          <div className="px-4 py-2 border-t border-border/50 grid grid-cols-4 gap-2 text-xs">
            <div>
              <span className="text-foreground-tertiary">Contributions: </span>
              <span className="text-green-400">{formatCurrency(account.contributions + account.incomeContributions)}</span>
            </div>
            <div>
              <span className="text-foreground-tertiary">Employer Match: </span>
              <span className="text-cyan-400">{formatCurrency(account.employerMatch)}</span>
            </div>
            <div>
              <span className="text-foreground-tertiary">Transfers: </span>
              <span className="text-foreground-secondary">{formatCurrency(account.transfers)}</span>
            </div>
            <div>
              <span className="text-foreground-tertiary">Withdrawals: </span>
              <span className="text-red-400">{formatCurrency(account.withdrawals)}</span>
            </div>
          </div>

          {/* Expanded transaction detail */}
          {expandedAccount === account.accountGuid && (
            <div className="border-t border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-foreground-tertiary text-xs border-b border-border/50">
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-4 py-2 text-left font-medium">Description</th>
                    <th className="px-4 py-2 text-left font-medium">Type</th>
                    <th className="px-4 py-2 text-left font-medium">Source</th>
                    <th className="px-4 py-2 text-left font-medium">Tax Year</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {account.transactions.map((tx) => (
                    <TransactionRow
                      key={tx.splitGuid}
                      tx={tx}
                      onTaxYearChange={onTaxYearChange}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TransactionRow({ tx, onTaxYearChange }: { tx: ContributionLineItem; onTaxYearChange?: (splitGuid: string, year: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [editYear, setEditYear] = useState(tx.taxYear);

  const handleSave = () => {
    if (onTaxYearChange && editYear !== tx.taxYear) {
      onTaxYearChange(tx.splitGuid, editYear);
    }
    setEditing(false);
  };

  return (
    <tr className="border-b border-border/30 hover:bg-background-tertiary/30">
      <td className="px-4 py-2 text-foreground-secondary">{tx.date}</td>
      <td className="px-4 py-2 text-foreground">{tx.description}</td>
      <td className="px-4 py-2">
        <span className={TYPE_COLORS[tx.type] ?? 'text-foreground-tertiary'}>
          {TYPE_LABELS[tx.type] ?? tx.type}
        </span>
      </td>
      <td className="px-4 py-2 text-foreground-secondary">{tx.sourceAccountName}</td>
      <td className="px-4 py-2">
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={editYear}
              onChange={(e) => setEditYear(parseInt(e.target.value))}
              className="w-16 bg-input-bg border border-border rounded px-1 py-0.5 text-xs"
              min={2000}
              max={2099}
            />
            <button onClick={handleSave} className="text-xs text-cyan-400 hover:text-cyan-300">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-foreground-tertiary hover:text-foreground-secondary">Cancel</button>
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="text-foreground-secondary hover:text-foreground cursor-pointer"
            title="Click to change tax year"
          >
            {tx.taxYear}
          </button>
        )}
      </td>
      <td className={`px-4 py-2 text-right font-mono ${tx.amount < 0 ? 'text-red-400' : 'text-foreground'}`}>
        {formatCurrency(tx.amount)}
      </td>
    </tr>
  );
}
```

- [ ] **Step 3: Create the report page**

Create `src/app/(main)/reports/contribution_summary/page.tsx`:

```typescript
'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, ContributionSummaryData } from '@/lib/reports/types';
import { ContributionTable } from '@/components/reports/ContributionTable';
import { formatCurrency } from '@/lib/format';

function getDefaultFilters(): ReportFilters {
  const now = new Date();
  return {
    startDate: `${now.getFullYear()}-01-01`,
    endDate: now.toISOString().split('T')[0],
    compareToPrevious: false,
  };
}

function ContributionSummaryContent() {
  const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
  const [reportData, setReportData] = useState<ContributionSummaryData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<'calendar_year' | 'tax_year'>('calendar_year');
  const [birthday, setBirthday] = useState<string | null>(null);

  // Fetch birthday from user preferences
  useEffect(() => {
    fetch('/api/user/preferences?key=birthday')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.preferences?.birthday) {
          setBirthday(data.preferences.birthday);
        }
      })
      .catch(() => {});
  }, []);

  const fetchReport = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (filters.startDate) params.set('startDate', filters.startDate);
      if (filters.endDate) params.set('endDate', filters.endDate);
      params.set('groupBy', groupBy);
      if (birthday) params.set('birthday', birthday);

      const res = await fetch(`/api/reports/contribution-summary?${params}`);
      if (!res.ok) throw new Error('Failed to fetch report');

      const data: ContributionSummaryData = await res.json();
      setReportData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  }, [filters, groupBy, birthday]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleTaxYearChange = async (splitGuid: string, newYear: number) => {
    try {
      const res = await fetch(`/api/contributions/${splitGuid}/tax-year`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taxYear: newYear }),
      });
      if (!res.ok) throw new Error('Failed to update tax year');
      // Refetch report to reflect change
      fetchReport();
    } catch (err) {
      console.error('Failed to update tax year:', err);
    }
  };

  const hasNoRetirementAccounts = reportData && reportData.periods.length === 0;

  return (
    <div className="space-y-6">
      {/* Group-by toggle */}
      <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4 flex items-center gap-4">
        <span className="text-sm text-foreground-secondary">Group by:</span>
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setGroupBy('calendar_year')}
            className={`px-3 py-1.5 text-sm transition-colors ${
              groupBy === 'calendar_year'
                ? 'bg-cyan-600 text-white'
                : 'bg-background-tertiary text-foreground-secondary hover:text-foreground'
            }`}
          >
            Calendar Year
          </button>
          <button
            onClick={() => setGroupBy('tax_year')}
            className={`px-3 py-1.5 text-sm transition-colors ${
              groupBy === 'tax_year'
                ? 'bg-cyan-600 text-white'
                : 'bg-background-tertiary text-foreground-secondary hover:text-foreground'
            }`}
          >
            Tax Year
          </button>
        </div>
      </div>

      <ReportViewer
        title="Contribution Summary"
        description="Retirement and brokerage account contributions with IRS limit tracking"
        filters={filters}
        onFilterChange={setFilters}
        isLoading={isLoading}
        error={error}
        showCompare={false}
      >
        {hasNoRetirementAccounts && (
          <div className="p-8 text-center">
            <div className="text-foreground-secondary mb-2">No retirement accounts configured</div>
            <p className="text-sm text-foreground-tertiary max-w-md mx-auto">
              To use this report, go to an investment account&apos;s settings and enable the
              &quot;Retirement Account&quot; toggle. This tells the report which accounts to track
              contributions for and which IRS limits apply.
            </p>
          </div>
        )}

        {reportData && reportData.periods.length > 0 && (
          <div className="space-y-8">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-4 p-4">
              <div className="bg-background-tertiary/50 rounded-lg p-4">
                <div className="text-xs text-foreground-tertiary mb-1">Total Contributions</div>
                <div className="text-xl font-semibold text-green-400">
                  {formatCurrency(reportData.grandTotalContributions)}
                </div>
              </div>
              <div className="bg-background-tertiary/50 rounded-lg p-4">
                <div className="text-xs text-foreground-tertiary mb-1">Employer Match</div>
                <div className="text-xl font-semibold text-cyan-400">
                  {formatCurrency(reportData.grandTotalEmployerMatch)}
                </div>
              </div>
              <div className="bg-background-tertiary/50 rounded-lg p-4">
                <div className="text-xs text-foreground-tertiary mb-1">Net Contributions</div>
                <div className="text-xl font-semibold text-foreground">
                  {formatCurrency(reportData.grandTotalNetContributions)}
                </div>
              </div>
            </div>

            {/* Per-year sections */}
            {reportData.periods.map((period) => (
              <div key={period.year} className="space-y-4">
                <div className="flex items-center justify-between px-4">
                  <h3 className="text-lg font-semibold text-foreground">{period.year}</h3>
                  <div className="text-sm text-foreground-secondary">
                    Net: {formatCurrency(period.totalNetContributions)}
                  </div>
                </div>
                <ContributionTable
                  accounts={period.accounts}
                  year={period.year}
                  onTaxYearChange={groupBy === 'tax_year' ? handleTaxYearChange : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </ReportViewer>
    </div>
  );
}

export default function ContributionSummaryPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-foreground-secondary">Loading...</div>}>
      <ContributionSummaryContent />
    </Suspense>
  );
}
```

- [ ] **Step 4: Verify build compiles**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds or only has unrelated warnings.

- [ ] **Step 5: Commit**

```bash
git add src/app/(main)/reports/contribution_summary/ src/components/reports/ContributionTable.tsx src/components/reports/ContributionLimitBar.tsx
git commit -m "feat: add contribution summary report page with IRS limit progress bars and tax-year editing"
```

---

## Task 7: Retirement Account Toggle in Account Preferences

**Files:**
- Modify: `src/app/(main)/accounts/[guid]/page.tsx`

- [ ] **Step 1: Add retirement toggle to account detail page**

Read the account detail page to find where account settings/preferences are displayed. Look for the section where cost basis method or lot assignment method is shown. Add a retirement account toggle nearby.

Find the section in the account page that displays account preferences (look for `preferences` or `cost_basis_method`). Add a retirement account section that:

1. Fetches `is_retirement` and `retirement_account_type` from `/api/accounts/{guid}/preferences`
2. Shows a toggle for "Retirement Account" (only visible for investment account types: STOCK, MUTUAL, ASSET)
3. Shows a dropdown for retirement account type when toggled on
4. Saves via PATCH to `/api/accounts/{guid}/preferences`

The UI should look like:

```tsx
{/* Retirement Account toggle — only show for investment-type accounts */}
{account && ['STOCK', 'MUTUAL', 'ASSET', 'BANK'].includes(account.account_type ?? '') && (
  <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4 space-y-3">
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={isRetirement}
        onChange={async (e) => {
          const newVal = e.target.checked;
          setIsRetirement(newVal);
          await fetch(`/api/accounts/${guid}/preferences`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_retirement: newVal }),
          });
        }}
        className="w-4 h-4 rounded border-border bg-input-bg text-cyan-500 focus:ring-cyan-500/30 focus:ring-offset-0"
      />
      <span className="text-sm text-foreground">Retirement Account</span>
      <span className="text-xs text-foreground-tertiary">
        (enables IRS contribution limit tracking)
      </span>
    </label>
    {isRetirement && (
      <div className="ml-7">
        <label className="text-xs text-foreground-secondary block mb-1">Account Type</label>
        <select
          value={retirementType ?? ''}
          onChange={async (e) => {
            const newType = e.target.value || null;
            setRetirementType(newType);
            await fetch(`/api/accounts/${guid}/preferences`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ retirement_account_type: newType }),
            });
          }}
          className="bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">Select type...</option>
          <option value="401k">401(k)</option>
          <option value="403b">403(b)</option>
          <option value="457">457</option>
          <option value="traditional_ira">Traditional IRA</option>
          <option value="roth_ira">Roth IRA</option>
          <option value="hsa">HSA</option>
          <option value="brokerage">Brokerage (taxable)</option>
        </select>
      </div>
    )}
  </div>
)}
```

Add state variables at the top of the component:

```typescript
const [isRetirement, setIsRetirement] = useState(false);
const [retirementType, setRetirementType] = useState<string | null>(null);
```

Fetch retirement status in the existing preferences fetch (or add one if not present):

```typescript
useEffect(() => {
  if (!guid) return;
  fetch(`/api/accounts/${guid}/preferences`)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (data) {
        setIsRetirement(data.is_retirement ?? false);
        setRetirementType(data.retirement_account_type ?? null);
      }
    })
    .catch(() => {});
}, [guid]);
```

- [ ] **Step 2: Verify the toggle works**

Run: `npm run dev`
Navigate to an investment account, verify the retirement toggle appears and saves.

- [ ] **Step 3: Commit**

```bash
git add src/app/(main)/accounts/[guid]/page.tsx
git commit -m "feat: add retirement account toggle to account detail page"
```

---

## Task 8: Tax-Year Backfill Script

**Files:**
- Create: `scripts/backfill-tax-year.ts`

- [ ] **Step 1: Create the backfill script**

Create `scripts/backfill-tax-year.ts`:

```typescript
/**
 * Backfill tax-year overrides for historical contribution transactions.
 *
 * Scans transaction descriptions for year indicators and sets tax_year
 * overrides in gnucash_web_contribution_tax_year for matches.
 *
 * Usage:
 *   npx tsx scripts/backfill-tax-year.ts --dry-run    # Preview changes
 *   npx tsx scripts/backfill-tax-year.ts              # Apply changes
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Patterns that indicate a tax year in description
// Matches: "2025 Roth IRA", "Contribution for 2024", "TY2025", "Tax Year 2024"
const TAX_YEAR_PATTERNS = [
  /\b(20\d{2})\s+(?:Roth|Traditional|IRA|HSA|401k|403b|457)/i,
  /(?:Contribution|Deposit|Payment)\s+(?:for|to)\s+(20\d{2})/i,
  /\bTY\s*(20\d{2})\b/i,
  /\bTax\s+Year\s+(20\d{2})\b/i,
  /\b(20\d{2})\s+(?:Contribution|Deposit)\b/i,
];

// Patterns that look like years but are NOT tax years (dates, reference numbers)
const FALSE_POSITIVE_PATTERNS = [
  /\b20\d{2}-\d{2}-\d{2}\b/, // Date: 2025-01-15
  /\b20\d{2}\/\d{2}\/\d{2}\b/, // Date: 2025/01/15
  /\b#\d+\b/, // Reference number
];

function extractTaxYear(description: string, postDate: Date): number | null {
  // Check for false positives first
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (fp.test(description)) {
      // Remove the false positive and try again
      description = description.replace(fp, '');
    }
  }

  for (const pattern of TAX_YEAR_PATTERNS) {
    const match = description.match(pattern);
    if (match?.[1]) {
      const year = parseInt(match[1]);
      const postYear = postDate.getFullYear();
      // Sanity: tax year should be postYear or postYear-1
      // (prior year contributions allowed until filing deadline ~April)
      if (year === postYear || year === postYear - 1) {
        return year;
      }
    }
  }

  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Backfill tax-year overrides ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('---');

  // Get all retirement account GUIDs
  const retirementPrefs = await prisma.gnucash_web_account_preferences.findMany({
    where: { is_retirement: true },
    select: { account_guid: true },
  });

  if (retirementPrefs.length === 0) {
    console.log('No retirement accounts flagged. Flag accounts first, then re-run.');
    return;
  }

  const retirementGuids = retirementPrefs.map(p => p.account_guid);
  console.log(`Found ${retirementGuids.length} retirement accounts`);

  // Get all child accounts too
  const allAccounts = await prisma.accounts.findMany({
    select: { guid: true, parent_guid: true },
  });
  const childrenOf = new Map<string, string[]>();
  for (const acct of allAccounts) {
    if (acct.parent_guid) {
      const children = childrenOf.get(acct.parent_guid) ?? [];
      children.push(acct.guid);
      childrenOf.set(acct.parent_guid, children);
    }
  }

  // BFS to include children
  const allRetirementGuids = new Set(retirementGuids);
  const queue = [...retirementGuids];
  while (queue.length > 0) {
    const guid = queue.pop()!;
    for (const child of childrenOf.get(guid) ?? []) {
      if (!allRetirementGuids.has(child)) {
        allRetirementGuids.add(child);
        queue.push(child);
      }
    }
  }

  console.log(`Including children: ${allRetirementGuids.size} total accounts`);

  // Get all splits in retirement accounts with transaction descriptions
  const splits = await prisma.splits.findMany({
    where: {
      account_guid: { in: [...allRetirementGuids] },
    },
    select: {
      guid: true,
      account_guid: true,
      transaction: {
        select: {
          description: true,
          post_date: true,
        },
      },
    },
  });

  console.log(`Scanning ${splits.length} splits...`);

  // Check existing overrides to avoid duplicates
  const existingOverrides = await prisma.gnucash_web_contribution_tax_year.findMany({
    select: { split_guid: true },
  });
  const existingSet = new Set(existingOverrides.map(o => o.split_guid));

  let found = 0;
  let skipped = 0;
  let created = 0;

  for (const split of splits) {
    if (!split.transaction) continue;

    const taxYear = extractTaxYear(
      split.transaction.description,
      split.transaction.post_date,
    );

    if (taxYear === null) continue;

    const postYear = split.transaction.post_date.getFullYear();
    if (taxYear === postYear) continue; // No override needed — matches calendar year

    found++;

    if (existingSet.has(split.guid)) {
      skipped++;
      continue;
    }

    console.log(`  ${split.transaction.post_date.toISOString().split('T')[0]} | "${split.transaction.description}" → tax year ${taxYear} (post year ${postYear})`);

    if (!dryRun) {
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_contribution_tax_year (split_guid, tax_year)
        VALUES (${split.guid}, ${taxYear})
        ON CONFLICT (split_guid) DO NOTHING
      `;
      created++;
    }
  }

  console.log('---');
  console.log(`Found: ${found} splits with tax year != calendar year`);
  console.log(`Skipped: ${skipped} (already have overrides)`);
  console.log(`${dryRun ? 'Would create' : 'Created'}: ${found - skipped} overrides`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
```

- [ ] **Step 2: Test with dry run**

Run: `npx tsx scripts/backfill-tax-year.ts --dry-run`
Expected: Lists any transactions with prior-year tax year indicators. If no retirement accounts are flagged yet, prints "No retirement accounts flagged."

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-tax-year.ts
git commit -m "feat: add tax-year backfill script for historical contribution descriptions"
```

---

## Task 9: Run All Tests and Final Verification

- [ ] **Step 1: Run all new tests**

Run: `npx vitest run src/lib/__tests__/irs-limits.test.ts src/lib/__tests__/contribution-classifier.test.ts src/lib/__tests__/contribution-summary.test.ts`
Expected: All tests PASS

- [ ] **Step 2: Run full test suite for regressions**

Run: `npx vitest run`
Expected: All tests PASS (no regressions)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit any fixes**

If any test/lint/build fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: address test/lint/build issues in contribution reports"
```

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 7 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — ready to implement.
