# Payslip Employer Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make payslip extraction work without AI by introducing employer templates (saved line item structures) and regex-based amount extraction, with a 3-tier fallback pipeline: AI → template+regex → regex-only with manual entry.

**Architecture:** A new `gnucash_web_payslip_templates` table stores reusable line item structures per employer. The extraction job tries AI first, falls back to applying an existing template with regex amount matching, and finally falls back to regex-only field extraction with manual line item entry. Templates are auto-saved when a payslip is posted. The UI adds editable employer name, add/remove line item rows, and auto-generates normalized labels from labels.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma 7, PostgreSQL, BullMQ, regex

**Spec:** `docs/superpowers/specs/2026-04-12-payslip-employer-templates-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/payslip-regex.ts` | Regex extraction: top-level fields (employer, dates, gross/net) and per-label amount matching |
| `src/lib/__tests__/payslip-regex.test.ts` | Tests for regex extraction functions |

### Modified Files

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `gnucash_web_payslip_templates` model |
| `src/lib/db-init.ts` | Add DDL for templates table |
| `src/lib/payslips.ts` | Add template CRUD functions (getTemplate, upsertTemplate) |
| `src/lib/__tests__/payslips.test.ts` | Add tests for template CRUD |
| `src/lib/queue/jobs/extract-payslip.ts` | Rewrite to 3-tier pipeline (AI → template+regex → regex-only) |
| `src/lib/services/payslip-post.service.ts` | Auto-save template on post |
| `src/components/payslips/PayslipLineItemTable.tsx` | Add/remove line item rows |
| `src/components/payslips/PayslipDetailPanel.tsx` | Editable employer name, add line item button, save line items to server |

---

## Task 1: Prisma Model & DDL for Templates

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/db-init.ts`

- [ ] **Step 1: Add Prisma model**

Add after the `gnucash_web_payslip_mappings` model in `prisma/schema.prisma`:

```prisma
model gnucash_web_payslip_templates {
  id            Int      @id @default(autoincrement())
  book_guid     String   @db.VarChar(32)
  employer_name String   @db.VarChar(255)
  line_items    Json     @db.JsonB
  created_at    DateTime @default(now())
  updated_at    DateTime @default(now())

  @@unique([book_guid, employer_name])
  @@index([book_guid])
  @@map("gnucash_web_payslip_templates")
}
```

- [ ] **Step 2: Add DDL to db-init.ts**

Find the payslips DDL block in `src/lib/db-init.ts` (the `payslipsTableDDL` string). Append to the end of that string, before the closing backtick:

```sql
    CREATE TABLE IF NOT EXISTS gnucash_web_payslip_templates (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        employer_name VARCHAR(255) NOT NULL,
        line_items JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_guid, employer_name)
    );
    CREATE INDEX IF NOT EXISTS idx_payslip_templates_book ON gnucash_web_payslip_templates(book_guid);
```

- [ ] **Step 3: Generate Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma src/lib/db-init.ts
git commit -m "feat(payslips): add Prisma model and DDL for employer templates"
```

---

## Task 2: Template CRUD Functions

**Files:**
- Modify: `src/lib/payslips.ts`
- Modify: `src/lib/__tests__/payslips.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/lib/__tests__/payslips.test.ts`. First, add `gnucash_web_payslip_templates` to the mock at the top:

```typescript
// Add to the mockPrisma object (inside vi.hoisted):
gnucash_web_payslip_templates: {
  findUnique: vi.fn(),
  upsert: vi.fn(),
},
```

Then add the import of the new functions alongside the existing imports:

```typescript
import {
  listPayslips,
  getPayslip,
  createPayslip,
  updatePayslipStatus,
  updatePayslipLineItems,
  getMappingsForEmployer,
  upsertMapping,
  getTemplate,
  upsertTemplate,
} from '../payslips';
```

Add these test suites:

```typescript
describe('getTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns template for employer', async () => {
    const template = {
      id: 1,
      book_guid: 'book123',
      employer_name: 'Acme',
      line_items: [{ category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay' }],
    };
    mockPrisma.gnucash_web_payslip_templates.findUnique.mockResolvedValue(template);

    const result = await getTemplate('book123', 'Acme');

    expect(mockPrisma.gnucash_web_payslip_templates.findUnique).toHaveBeenCalledWith({
      where: {
        book_guid_employer_name: { book_guid: 'book123', employer_name: 'Acme' },
      },
    });
    expect(result?.employer_name).toBe('Acme');
  });

  it('returns null when no template exists', async () => {
    mockPrisma.gnucash_web_payslip_templates.findUnique.mockResolvedValue(null);

    const result = await getTemplate('book123', 'Unknown');
    expect(result).toBeNull();
  });
});

describe('upsertTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts template by composite key', async () => {
    mockPrisma.gnucash_web_payslip_templates.upsert.mockResolvedValue({ id: 1 });

    const lineItems = [
      { category: 'earnings' as const, label: 'Regular Pay', normalized_label: 'regular_pay' },
      { category: 'tax' as const, label: 'Federal Tax', normalized_label: 'federal_income_tax' },
    ];

    await upsertTemplate('book123', 'Acme', lineItems);

    expect(mockPrisma.gnucash_web_payslip_templates.upsert).toHaveBeenCalledWith({
      where: {
        book_guid_employer_name: { book_guid: 'book123', employer_name: 'Acme' },
      },
      create: {
        book_guid: 'book123',
        employer_name: 'Acme',
        line_items: lineItems,
      },
      update: {
        line_items: lineItems,
        updated_at: expect.any(Date),
      },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/payslips.test.ts 2>&1 | tail -20`
Expected: FAIL — `getTemplate` and `upsertTemplate` not found

- [ ] **Step 3: Implement template CRUD in `src/lib/payslips.ts`**

Add a new interface and two functions at the end of the file:

```typescript
export interface TemplateLineItem {
  category: string;
  label: string;
  normalized_label: string;
}

/**
 * Get the saved template for an employer within a book.
 */
export async function getTemplate(bookGuid: string, employerName: string) {
  return prisma.gnucash_web_payslip_templates.findUnique({
    where: {
      book_guid_employer_name: { book_guid: bookGuid, employer_name: employerName },
    },
  });
}

/**
 * Upsert a template for an employer. Stores line item structure (labels + categories, no amounts).
 */
export async function upsertTemplate(
  bookGuid: string,
  employerName: string,
  lineItems: TemplateLineItem[]
) {
  return prisma.gnucash_web_payslip_templates.upsert({
    where: {
      book_guid_employer_name: { book_guid: bookGuid, employer_name: employerName },
    },
    create: {
      book_guid: bookGuid,
      employer_name: employerName,
      line_items: lineItems,
    },
    update: {
      line_items: lineItems,
      updated_at: new Date(),
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/payslips.test.ts 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/payslips.ts src/lib/__tests__/payslips.test.ts
git commit -m "feat(payslips): add template CRUD functions"
```

---

## Task 3: Regex Extraction Module

**Files:**
- Create: `src/lib/payslip-regex.ts`
- Test: `src/lib/__tests__/payslip-regex.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/payslip-regex.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  extractAmountForLabel,
  extractPayslipFields,
  applyTemplateWithRegex,
} from '../payslip-regex';

describe('extractAmountForLabel', () => {
  const sampleText = `
    Regular Pay          80.00 hrs    $4,000.00
    Federal Income Tax                  -$600.00
    Social Security                     -$248.00
    401(k)                              -$400.00
    Net Pay                           $2,752.00
  `;

  it('extracts amount for an exact label match', () => {
    const amount = extractAmountForLabel(sampleText, 'Regular Pay');
    expect(amount).toBe(4000.00);
  });

  it('extracts negative amount for tax label', () => {
    const amount = extractAmountForLabel(sampleText, 'Federal Income Tax');
    expect(amount).toBe(-600.00);
  });

  it('extracts amount for label with special chars', () => {
    const amount = extractAmountForLabel(sampleText, '401(k)');
    expect(amount).toBe(-400.00);
  });

  it('returns null for label not found', () => {
    const amount = extractAmountForLabel(sampleText, 'Dental Insurance');
    expect(amount).toBeNull();
  });
});

describe('extractPayslipFields', () => {
  const sampleText = `
    ACME CORPORATION
    Pay Date: 01/15/2026
    Pay Period: 01/01/2026 - 01/15/2026
    Gross Pay: $4,000.00
    Net Pay: $2,752.00
    
    Regular Pay          80.00 hrs    $4,000.00
    Federal Income Tax                  -$600.00
  `;

  it('extracts employer name from first substantive line', () => {
    const fields = extractPayslipFields(sampleText);
    expect(fields.employer_name).toBe('ACME CORPORATION');
  });

  it('extracts pay date', () => {
    const fields = extractPayslipFields(sampleText);
    expect(fields.pay_date).toBe('2026-01-15');
  });

  it('extracts gross pay', () => {
    const fields = extractPayslipFields(sampleText);
    expect(fields.gross_pay).toBe(4000.00);
  });

  it('extracts net pay', () => {
    const fields = extractPayslipFields(sampleText);
    expect(fields.net_pay).toBe(2752.00);
  });
});

describe('applyTemplateWithRegex', () => {
  const template = [
    { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay' },
    { category: 'tax', label: 'Federal Income Tax', normalized_label: 'federal_income_tax' },
    { category: 'deduction', label: '401(k)', normalized_label: '401k' },
  ];

  const ocrText = `
    Regular Pay          80.00 hrs    $4,000.00
    Federal Income Tax                  $600.00
    401(k)                              $400.00
  `;

  it('returns line items with amounts from OCR text', () => {
    const items = applyTemplateWithRegex(template, ocrText);
    expect(items).toHaveLength(3);
    expect(items[0].label).toBe('Regular Pay');
    expect(items[0].amount).toBe(4000.00);
    expect(items[1].label).toBe('Federal Income Tax');
    expect(items[1].amount).toBe(-600.00); // taxes are negated
    expect(items[2].label).toBe('401(k)');
    expect(items[2].amount).toBe(-400.00); // deductions are negated
  });

  it('sets amount to 0 for labels not found in text', () => {
    const extraTemplate = [
      ...template,
      { category: 'deduction', label: 'Dental Insurance', normalized_label: 'dental_insurance' },
    ];
    const items = applyTemplateWithRegex(extraTemplate, ocrText);
    const dental = items.find(i => i.normalized_label === 'dental_insurance');
    expect(dental?.amount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/payslip-regex.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/lib/payslip-regex.ts`**

```typescript
import type { PayslipLineItem, PayslipLineItemCategory } from '@/lib/types';

interface TemplateLineItem {
  category: string;
  label: string;
  normalized_label: string;
}

interface ExtractedFields {
  employer_name: string | null;
  pay_date: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
  gross_pay: number | null;
  net_pay: number | null;
}

/**
 * Extract a dollar amount from OCR text near a given label.
 *
 * Searches for the label (case-insensitive, flexible whitespace),
 * then grabs the nearest dollar amount within ~80 chars after it.
 * Returns negative for amounts preceded by a minus sign.
 */
export function extractAmountForLabel(ocrText: string, label: string): number | null {
  // Escape regex special chars in label, allow flexible whitespace
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const labelRegex = new RegExp(escaped, 'i');
  const match = labelRegex.exec(ocrText);
  if (!match) return null;

  // Look for a dollar amount within 80 chars after the label
  const after = ocrText.slice(match.index + match[0].length, match.index + match[0].length + 80);
  const amountMatch = after.match(/(-?\$?\s*[\d,]+\.\d{2})/);
  if (!amountMatch) return null;

  const raw = amountMatch[1].replace(/[$,\s]/g, '');
  const value = parseFloat(raw);
  return isNaN(value) ? null : value;
}

/**
 * Extract a dollar amount near a keyword (for gross/net pay).
 */
function extractAmountNearKeyword(ocrText: string, keywords: string[]): number | null {
  for (const kw of keywords) {
    const amount = extractAmountForLabel(ocrText, kw);
    if (amount !== null) return Math.abs(amount);
  }
  return null;
}

/**
 * Extract a date near a keyword. Returns YYYY-MM-DD or null.
 */
function extractDateNearKeyword(ocrText: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped + '[:\\s]*([\\d/.-]+)', 'i');
    const match = regex.exec(ocrText);
    if (!match) continue;

    const dateStr = match[1].trim();
    const parsed = parseDate(dateStr);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Parse a date string in common formats to YYYY-MM-DD.
 */
function parseDate(dateStr: string): string | null {
  // MM/DD/YYYY or MM-DD-YYYY
  let m = dateStr.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  // YYYY-MM-DD
  m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return dateStr;

  return null;
}

/**
 * Extract top-level payslip fields from OCR text using regex heuristics.
 */
export function extractPayslipFields(ocrText: string): ExtractedFields {
  // Employer name: first substantive non-date, non-number line
  let employer_name: string | null = null;
  const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  for (const line of lines) {
    // Skip lines that are purely numeric, date-like, or common headers
    if (/^\d+$/.test(line)) continue;
    if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(line)) continue;
    if (/^(pay\s|period|date|gross|net|total|hours|rate|ytd|current)/i.test(line)) continue;
    if (/\$[\d,]+\.\d{2}/.test(line) && line.length < 20) continue;
    employer_name = line;
    break;
  }

  // Pay date
  const pay_date = extractDateNearKeyword(ocrText, [
    'Pay Date', 'Check Date', 'Payment Date', 'Date Paid', 'Pay date',
  ]);

  // Pay period
  const pay_period_start = extractDateNearKeyword(ocrText, [
    'Period Start', 'Period Beginning', 'Period Begin', 'Pay Period',
  ]);

  // Look for period end after period start keyword or "to" / "-" separator
  let pay_period_end: string | null = null;
  const periodMatch = ocrText.match(
    /(?:period|pay\s*period)[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{4}\s*[-–to]+\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i
  );
  if (periodMatch) {
    pay_period_end = parseDate(periodMatch[1]) ?? null;
  }

  // Gross and net pay
  const gross_pay = extractAmountNearKeyword(ocrText, [
    'Gross Pay', 'Gross Earnings', 'Total Earnings', 'Gross',
  ]);
  const net_pay = extractAmountNearKeyword(ocrText, [
    'Net Pay', 'Net Amount', 'Net Check', 'Take Home', 'Total Net Pay', 'Net',
  ]);

  return { employer_name, pay_date, pay_period_start, pay_period_end, gross_pay, net_pay };
}

/**
 * Apply a template to OCR text: for each template line item,
 * search the text for the label and extract the amount.
 *
 * Taxes and deductions are ensured negative, earnings positive.
 */
export function applyTemplateWithRegex(
  template: TemplateLineItem[],
  ocrText: string
): PayslipLineItem[] {
  return template.map(item => {
    let amount = extractAmountForLabel(ocrText, item.label);

    // Enforce sign convention: taxes/deductions negative, earnings/reimbursements positive
    if (amount !== null) {
      const shouldBeNegative = item.category === 'tax' || item.category === 'deduction';
      if (shouldBeNegative && amount > 0) amount = -amount;
      const shouldBePositive = item.category === 'earnings' || item.category === 'reimbursement';
      if (shouldBePositive && amount < 0) amount = -amount;
    }

    return {
      category: item.category as PayslipLineItemCategory,
      label: item.label,
      normalized_label: item.normalized_label,
      amount: amount ?? 0,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/payslip-regex.test.ts 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/payslip-regex.ts src/lib/__tests__/payslip-regex.test.ts
git commit -m "feat(payslips): add regex extraction module for template-based amount matching"
```

---

## Task 4: Rewrite Extraction Job to 3-Tier Pipeline

**Files:**
- Modify: `src/lib/queue/jobs/extract-payslip.ts`

- [ ] **Step 1: Rewrite the job handler**

Replace the entire contents of `src/lib/queue/jobs/extract-payslip.ts`:

```typescript
import { Job } from 'bullmq';

export async function handleExtractPayslip(job: Job): Promise<void> {
  const { payslipId, bookGuid } = job.data as { payslipId: number; bookGuid?: string };
  console.log(`[Job ${job.id}] Starting payslip extraction for ${payslipId}`);

  const { updatePayslipStatus, updatePayslipLineItems, getMappingsForEmployer, getTemplate } = await import('@/lib/payslips');

  try {
    await updatePayslipStatus(payslipId, 'processing');

    const prisma = (await import('@/lib/prisma')).default;
    const payslip = await prisma.gnucash_web_payslips.findFirst({ where: { id: payslipId } });

    if (!payslip) {
      console.warn(`[Job ${job.id}] Payslip ${payslipId} not found, skipping`);
      await updatePayslipStatus(payslipId, 'error', { error_message: `Payslip ${payslipId} not found` });
      return;
    }

    if (!payslip.storage_key) {
      await updatePayslipStatus(payslipId, 'error', { error_message: 'No PDF file attached' });
      return;
    }

    // OCR: extract text from PDF
    const { getStorageBackend } = await import('@/lib/storage/storage-backend');
    const storage = await getStorageBackend();
    const buffer = await storage.get(payslip.storage_key);
    const { extractTextFromPdf } = await import('./ocr-receipt');
    const ocrText = await extractTextFromPdf(buffer);

    const resolvedBookGuid = bookGuid ?? payslip.book_guid;

    // Regex: extract top-level fields regardless of tier
    const { extractPayslipFields, applyTemplateWithRegex } = await import('@/lib/payslip-regex');
    const regexFields = extractPayslipFields(ocrText);

    // --- Tier 1: Try AI extraction ---
    const { getAiConfig } = await import('@/lib/ai-config');
    const aiConfig = await getAiConfig(payslip.created_by ?? 0);

    if (aiConfig?.enabled && aiConfig.base_url && aiConfig.model) {
      try {
        console.log(`[Job ${job.id}] Tier 1: AI extraction`);
        const { extractPayslipData } = await import('@/lib/payslip-extraction');
        const extracted = await extractPayslipData(ocrText, aiConfig);

        await updatePayslipLineItems(payslipId, extracted.line_items, { ocrText, tier: 'ai' });
        await updatePayslipStatus(payslipId, 'needs_mapping', {
          employer_name: extracted.employer_name,
          pay_date: extracted.pay_date ? new Date(extracted.pay_date) : undefined,
          pay_period_start: extracted.pay_period_start ? new Date(extracted.pay_period_start) : undefined,
          pay_period_end: extracted.pay_period_end ? new Date(extracted.pay_period_end) : undefined,
          gross_pay: extracted.gross_pay,
          net_pay: extracted.net_pay,
        });

        // Auto-save template from AI extraction
        const { upsertTemplate } = await import('@/lib/payslips');
        const templateItems = extracted.line_items.map(item => ({
          category: item.category,
          label: item.label,
          normalized_label: item.normalized_label,
        }));
        await upsertTemplate(resolvedBookGuid, extracted.employer_name, templateItems);

        console.log(`[Job ${job.id}] AI extraction complete: ${extracted.line_items.length} items, employer="${extracted.employer_name}"`);
        await checkMappingsAndSetReady(payslipId, resolvedBookGuid, extracted.employer_name, extracted.line_items, getMappingsForEmployer);
        return;
      } catch (aiErr) {
        console.warn(`[Job ${job.id}] AI extraction failed, falling back:`, aiErr);
      }
    }

    // --- Tier 2: Try template + regex ---
    const employerName = regexFields.employer_name ?? 'Unknown';

    // Try to find a template for this employer
    let template = await getTemplate(resolvedBookGuid, employerName);

    // If no exact match and employer is "Unknown", check if there's only one template for this book
    if (!template && employerName === 'Unknown') {
      const allTemplates = await prisma.gnucash_web_payslip_templates.findMany({
        where: { book_guid: resolvedBookGuid },
      });
      if (allTemplates.length === 1) {
        template = allTemplates[0];
        console.log(`[Job ${job.id}] Using sole template for book: "${template.employer_name}"`);
      }
    }

    if (template) {
      console.log(`[Job ${job.id}] Tier 2: Template + regex for "${template.employer_name}"`);
      const templateLineItems = template.line_items as Array<{ category: string; label: string; normalized_label: string }>;
      const lineItems = applyTemplateWithRegex(templateLineItems, ocrText);

      await updatePayslipLineItems(payslipId, lineItems, { ocrText, tier: 'template_regex' });
      await updatePayslipStatus(payslipId, 'needs_mapping', {
        employer_name: template.employer_name,
        pay_date: regexFields.pay_date ? new Date(regexFields.pay_date) : undefined,
        pay_period_start: regexFields.pay_period_start ? new Date(regexFields.pay_period_start) : undefined,
        pay_period_end: regexFields.pay_period_end ? new Date(regexFields.pay_period_end) : undefined,
        gross_pay: regexFields.gross_pay,
        net_pay: regexFields.net_pay,
      });

      console.log(`[Job ${job.id}] Template extraction complete: ${lineItems.length} items`);
      await checkMappingsAndSetReady(payslipId, resolvedBookGuid, template.employer_name, lineItems, getMappingsForEmployer);
      return;
    }

    // --- Tier 3: Regex-only (no line items, manual entry) ---
    console.log(`[Job ${job.id}] Tier 3: Regex-only, manual entry required`);
    await updatePayslipLineItems(payslipId, [], { ocrText, tier: 'regex_only' });
    await updatePayslipStatus(payslipId, 'needs_mapping', {
      employer_name: employerName,
      pay_date: regexFields.pay_date ? new Date(regexFields.pay_date) : undefined,
      pay_period_start: regexFields.pay_period_start ? new Date(regexFields.pay_period_start) : undefined,
      pay_period_end: regexFields.pay_period_end ? new Date(regexFields.pay_period_end) : undefined,
      gross_pay: regexFields.gross_pay,
      net_pay: regexFields.net_pay,
    });

    console.log(`[Job ${job.id}] Regex extraction complete: employer="${employerName}", manual line item entry required`);
  } catch (err) {
    console.error(`[Job ${job.id}] Payslip extraction failed:`, err);
    await updatePayslipStatus(payslipId, 'error', {
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Check if all line items have mappings; if so, set status to 'ready'. */
async function checkMappingsAndSetReady(
  payslipId: number,
  bookGuid: string,
  employerName: string,
  lineItems: Array<{ normalized_label: string; category: string }>,
  getMappingsForEmployer: (bookGuid: string, employerName: string) => Promise<Array<{ normalized_label: string; line_item_category: string }>>
) {
  if (lineItems.length === 0) return;

  const { updatePayslipStatus } = await import('@/lib/payslips');
  const mappings = await getMappingsForEmployer(bookGuid, employerName);
  const mappingIndex = new Set(
    mappings.map(m => `${m.normalized_label}::${m.line_item_category}`)
  );

  const allMapped = lineItems.every(item =>
    mappingIndex.has(`${item.normalized_label}::${item.category}`)
  );

  if (allMapped) {
    await updatePayslipStatus(payslipId, 'ready');
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit src/lib/queue/jobs/extract-payslip.ts 2>&1 | head -10`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `npx vitest run 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/lib/queue/jobs/extract-payslip.ts
git commit -m "feat(payslips): rewrite extraction job with 3-tier pipeline (AI → template+regex → manual)"
```

---

## Task 5: Auto-Save Template on Post

**Files:**
- Modify: `src/lib/services/payslip-post.service.ts`

- [ ] **Step 1: Add template auto-save to `postPayslipTransaction`**

In `src/lib/services/payslip-post.service.ts`, add an import at the top:

```typescript
import { upsertTemplate } from '@/lib/payslips';
```

Then inside the `prisma.$transaction` callback, after the payslip update (the `tx.gnucash_web_payslips.update` call), add template auto-save. Insert before the `return transactionGuid;` line:

```typescript
    // Auto-save employer template from posted line items
    const templateItems = lineItems.map(item => ({
      category: item.category,
      label: item.label,
      normalized_label: item.normalized_label,
    }));
    await upsertTemplate(bookGuid, employerName, templateItems);
```

Note: `upsertTemplate` uses the global prisma client (not the transaction `tx`), which is fine because the template is independent of the transaction atomicity — it's a best-effort side effect.

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit src/lib/services/payslip-post.service.ts 2>&1 | head -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/services/payslip-post.service.ts
git commit -m "feat(payslips): auto-save employer template when posting transaction"
```

---

## Task 6: Add/Remove Line Items in Table Component

**Files:**
- Modify: `src/components/payslips/PayslipLineItemTable.tsx`

- [ ] **Step 1: Add new props and add/remove functionality**

Update the props interface to add:

```typescript
interface PayslipLineItemTableProps {
  lineItems: PayslipLineItem[];
  employerName: string;
  mappings: MappingEntry[];
  onMappingChange: (normalized_label: string, category: string, account_guid: string) => void;
  onLineItemEdit?: (index: number, field: string, value: unknown) => void;
  onAddLineItem?: () => void;
  onRemoveLineItem?: (index: number) => void;
  editable?: boolean;
}
```

Add `onAddLineItem` and `onRemoveLineItem` to the destructured props.

Add an "Add Line Item" button after the table closing tag (`</table>`), before the closing `</div>` of the outer container:

```tsx
{editable && onAddLineItem && (
  <button
    onClick={onAddLineItem}
    className="flex items-center gap-1.5 text-xs text-primary hover:text-primary-hover transition-colors mt-2"
  >
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
    </svg>
    Add line item
  </button>
)}
```

Add a delete button (X) as a fifth column in each row, only when editable. Add a new `<th>` to the header:

```tsx
{editable && onRemoveLineItem && <th className="w-8" />}
```

And a new `<td>` at the end of each row:

```tsx
{editable && onRemoveLineItem && (
  <td className="py-2 pl-2">
    <button
      onClick={() => onRemoveLineItem(index)}
      className="text-foreground-muted hover:text-red-400 transition-colors"
      title="Remove line item"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </td>
)}
```

Also make the category column editable when `editable` is true — replace the `<CategoryBadge>` with a select dropdown:

```tsx
<td className="py-2 pr-4">
  {editable && onLineItemEdit ? (
    <select
      value={item.category}
      onChange={e => onLineItemEdit(index, 'category', e.target.value)}
      className="text-xs bg-input-bg border border-border rounded px-1.5 py-1 text-foreground focus:ring-2 focus:ring-primary/40 focus:outline-none"
    >
      <option value="earnings">Earnings</option>
      <option value="tax">Tax</option>
      <option value="deduction">Deduction</option>
      <option value="employer_contribution">Employer</option>
      <option value="reimbursement">Reimbursement</option>
    </select>
  ) : (
    <CategoryBadge category={item.category} />
  )}
</td>
```

And make the label column editable:

```tsx
<td className="py-2 pr-4">
  {editable && onLineItemEdit ? (
    <input
      type="text"
      defaultValue={item.label}
      onChange={e => {
        onLineItemEdit(index, 'label', e.target.value);
        // Auto-generate normalized_label
        const normalized = e.target.value.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_');
        onLineItemEdit(index, 'normalized_label', normalized);
      }}
      placeholder="Line item label"
      className="w-full text-foreground bg-input-bg border border-border rounded px-2 py-1 text-sm focus:ring-2 focus:ring-primary/40 focus:outline-none"
    />
  ) : (
    <div className="flex flex-col">
      <span className="text-foreground">{item.label}</span>
      {item.normalized_label !== item.label && (
        <span className="text-xs text-foreground-muted">{item.normalized_label}</span>
      )}
    </div>
  )}
</td>
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit src/components/payslips/PayslipLineItemTable.tsx 2>&1 | head -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/payslips/PayslipLineItemTable.tsx
git commit -m "feat(payslips): add/remove line items and editable category/label in table"
```

---

## Task 7: Detail Panel — Editable Employer Name, Add Line Items, Save

**Files:**
- Modify: `src/components/payslips/PayslipDetailPanel.tsx`

- [ ] **Step 1: Add employer name editing state**

Add a new state variable after the existing state declarations:

```typescript
const [editableEmployerName, setEditableEmployerName] = useState('');
```

In the `useEffect` that fetches payslip data, after `setPayslip(data)`, add:

```typescript
setEditableEmployerName(data.employer_name || '');
```

- [ ] **Step 2: Add line item management functions**

Add these functions inside the component, after the existing handler functions:

```typescript
const handleAddLineItem = useCallback(() => {
  if (!payslip) return;
  const newItem: PayslipLineItem = {
    category: 'earnings',
    label: '',
    normalized_label: '',
    amount: 0,
  };
  const updated = [...(payslip.line_items ?? []), newItem];
  setPayslip(prev => prev ? { ...prev, line_items: updated } : null);
}, [payslip]);

const handleRemoveLineItem = useCallback((index: number) => {
  if (!payslip) return;
  const updated = (payslip.line_items ?? []).filter((_, i) => i !== index);
  setPayslip(prev => prev ? { ...prev, line_items: updated } : null);
}, [payslip]);

const handleLineItemEdit = useCallback((index: number, field: string, value: unknown) => {
  if (!payslip) return;
  const items = [...(payslip.line_items ?? [])];
  items[index] = { ...items[index], [field]: value };
  setPayslip(prev => prev ? { ...prev, line_items: items } : null);
}, [payslip]);

const handleSaveLineItems = useCallback(async () => {
  if (!payslip) return;
  try {
    await fetch(`/api/payslips/${payslipId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        line_items: payslip.line_items,
        employer_name: editableEmployerName,
      }),
    });
  } catch (err) {
    console.error('Failed to save line items:', err);
  }
}, [payslip, payslipId, editableEmployerName]);
```

- [ ] **Step 3: Replace the header employer name with an editable input**

Find the header section that displays the employer name (look for `payslip.employer_name` in the header area). Replace the static text with:

```tsx
{payslip.status !== 'posted' ? (
  <input
    type="text"
    value={editableEmployerName}
    onChange={e => setEditableEmployerName(e.target.value)}
    onBlur={handleSaveLineItems}
    className="text-lg font-semibold text-foreground bg-transparent border-b border-border focus:border-primary focus:outline-none"
    placeholder="Employer name"
  />
) : (
  <span className="text-lg font-semibold text-foreground">{payslip.employer_name}</span>
)}
```

- [ ] **Step 4: Pass new props to PayslipLineItemTable**

Find the `<PayslipLineItemTable>` usage. Add the new props:

```tsx
<PayslipLineItemTable
  lineItems={lineItems}
  employerName={editableEmployerName}
  mappings={mappings}
  onMappingChange={handleMappingChange}
  onLineItemEdit={handleLineItemEdit}
  onAddLineItem={handleAddLineItem}
  onRemoveLineItem={handleRemoveLineItem}
  editable={payslip.status !== 'posted'}
/>
```

- [ ] **Step 5: Add a "Save" button for line items when modified**

Add a save button after the line item table section, before the deposit account selector:

```tsx
{payslip.status !== 'posted' && lineItems.length > 0 && (
  <button
    onClick={handleSaveLineItems}
    className="text-xs text-primary hover:text-primary-hover transition-colors"
  >
    Save changes
  </button>
)}
```

- [ ] **Step 6: Update the PATCH API route to accept employer_name**

In `src/app/api/payslips/[id]/route.ts`, in the PATCH handler, add employer_name handling. After the existing `body.line_items` check:

```typescript
if (body.employer_name) {
  await updatePayslipStatus(payslipId, payslip.status as PayslipStatus, {
    employer_name: body.employer_name,
  });
}
```

- [ ] **Step 7: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | grep -i payslip | head -10`
Expected: No payslip-related errors

- [ ] **Step 8: Commit**

```bash
git add src/components/payslips/PayslipDetailPanel.tsx src/components/payslips/PayslipLineItemTable.tsx src/app/api/payslips/\[id\]/route.ts
git commit -m "feat(payslips): editable employer name, add/remove line items, save changes"
```

---

## Task 8: Smoke Test

**Files:** None (manual verification)

- [ ] **Step 1: Run tests**

Run: `npx vitest run 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 2: Run lint**

Run: `npm run lint 2>&1 | grep payslip`
Expected: No payslip-related lint errors

- [ ] **Step 3: Verify the extraction job handles all 3 tiers**

Check that `src/lib/queue/jobs/extract-payslip.ts` compiles and the 3-tier logic is correct:
- Tier 1: AI available → extract + auto-save template
- Tier 2: Template exists → apply template + regex amounts
- Tier 3: Neither → regex fields only, empty line items for manual entry

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(payslips): smoke test fixes for employer templates"
```

---

## Self-Review Notes

**Spec coverage:**
- `gnucash_web_payslip_templates` table: Task 1
- Template CRUD (getTemplate, upsertTemplate): Task 2
- Regex extraction (extractAmountForLabel, extractPayslipFields, applyTemplateWithRegex): Task 3
- 3-tier pipeline in extraction job: Task 4
- Template auto-save on post: Task 5
- Add/remove line items in table: Task 6
- Editable employer name in detail panel: Task 7
- Auto-generated normalized_label from label: Task 6 (onChange handler)
- Employer name regex extraction: Task 3 (extractPayslipFields)

**Not in scope (per spec non-goals):**
- Template sharing across books
- Template import/export
- Template editing UI (managed implicitly)

**Type consistency:**
- `TemplateLineItem` defined in Task 2 (payslips.ts), used in Task 3 (payslip-regex.ts) with matching shape
- `applyTemplateWithRegex` returns `PayslipLineItem[]` — used in Task 4 extraction job
- `upsertTemplate` signature consistent between Task 2 definition and Task 4/5 usage
