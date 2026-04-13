# Payslip Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import payroll stubs (PDF upload + AI extraction), map line items to GnuCash accounts via reusable employer templates, and post detailed split transactions — replacing SimpleFin lump-sum deposits.

**Architecture:** Payslips are stored in two new Prisma models (`gnucash_web_payslips`, `gnucash_web_payslip_mappings`). PDF storage reuses the existing `StorageBackend` infrastructure. AI extraction runs as a BullMQ job following the `ocr-receipt` pattern — OCR the PDF, then send text to the user's AI provider for structured line item extraction. A payslip service handles transaction generation using `generateGuid()` and `fromDecimal()` from `gnucash.ts`. The UI adds a `/payslips` list page, a detail panel with editable line items + account mapping, and an upload zone.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma 7 (ORM), PostgreSQL, BullMQ/Redis, existing storage backend (S3/filesystem), existing AI extraction infrastructure, existing `AccountSelector` component

**Spec:** `docs/superpowers/specs/2026-03-24-payslip-integration-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/payslips.ts` | Payslip DB queries via Prisma (CRUD, list, status updates) |
| `src/lib/payslip-extraction.ts` | AI-based payslip line item extraction (prompt + parsing) |
| `src/lib/services/payslip-post.service.ts` | Transaction generation from payslip line items (splits, balance validation, SimpleFin matching) |
| `src/lib/queue/jobs/extract-payslip.ts` | BullMQ job: OCR + AI extraction pipeline |
| `src/app/api/payslips/route.ts` | GET list payslips (with filters) |
| `src/app/api/payslips/upload/route.ts` | POST upload payslip PDF |
| `src/app/api/payslips/[id]/route.ts` | GET detail, PATCH update line items/status, DELETE |
| `src/app/api/payslips/[id]/post/route.ts` | POST generate and post GnuCash transaction from payslip |
| `src/app/api/payslips/[id]/match/route.ts` | GET find matching SimpleFin deposits |
| `src/app/api/payslips/mappings/route.ts` | GET/PUT employer account mappings |
| `src/app/(main)/payslips/page.tsx` | Payslips list page with upload |
| `src/components/payslips/PayslipDetailPanel.tsx` | Slide-over: PDF viewer + editable line items + account mapping |
| `src/components/payslips/PayslipUploadZone.tsx` | Drag-drop PDF upload (wraps ReceiptUploadZone pattern) |
| `src/components/payslips/PayslipLineItemTable.tsx` | Editable table of extracted line items with account selectors |
| `src/components/payslips/TransactionPreview.tsx` | Read-only split preview before posting |
| `src/lib/__tests__/payslip-extraction.test.ts` | Unit tests for extraction parsing |
| `src/lib/__tests__/payslip-post.test.ts` | Unit tests for transaction generation logic |

### Modified Files

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `gnucash_web_payslips` and `gnucash_web_payslip_mappings` models |
| `src/lib/db-init.ts` | Add DDL for both tables (idempotent `CREATE TABLE IF NOT EXISTS`) |
| `src/lib/types.ts` | Add `PayslipLineItem` and `PayslipStatus` types |
| `worker.ts` | Add `extract-payslip` job handler case in switch |
| `src/components/Layout.tsx` | Add "Payslips" nav item after "Receipts" |

---

## Task 1: TypeScript Types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add payslip types to `types.ts`**

Add at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

export type PayslipStatus = 'processing' | 'needs_mapping' | 'ready' | 'posted' | 'error';

export type PayslipLineItemCategory = 'earnings' | 'tax' | 'deduction' | 'employer_contribution' | 'reimbursement';

export interface PayslipLineItem {
  category: PayslipLineItemCategory;
  label: string;
  normalized_label: string;
  amount: number;
  hours?: number;
  rate?: number;
}
```

- [ ] **Step 2: Verify the file has no syntax errors**

Run: `npx tsc --noEmit src/lib/types.ts 2>&1 | head -20`
Expected: No errors (clean exit)

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(payslips): add PayslipLineItem and PayslipStatus types"
```

---

## Task 2: Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `gnucash_web_payslips` model**

Add after the `gnucash_web_receipts` model block in `prisma/schema.prisma`:

```prisma
model gnucash_web_payslips {
  id               Int       @id @default(autoincrement())
  book_guid        String    @db.VarChar(32)
  pay_date         DateTime  @db.Date
  pay_period_start DateTime? @db.Date
  pay_period_end   DateTime? @db.Date
  employer_name    String    @db.VarChar(255)
  gross_pay        Decimal?  @db.Decimal(12, 2)
  net_pay          Decimal?  @db.Decimal(12, 2)
  currency         String    @default("USD") @db.VarChar(10)
  source           String    @default("pdf_upload") @db.VarChar(20)
  source_id        String?   @db.VarChar(255)
  transaction_guid String?   @db.VarChar(32)
  storage_key      String?   @db.VarChar(500)
  thumbnail_key    String?   @db.VarChar(500)
  line_items       Json?     @db.JsonB
  raw_response     Json?     @db.JsonB
  status           String    @default("processing") @db.VarChar(20)
  error_message    String?   @db.Text
  deposit_account_guid String? @db.VarChar(32)
  created_by       Int?
  created_at       DateTime  @default(now())
  updated_at       DateTime  @default(now())

  @@index([book_guid])
  @@index([pay_date])
  @@index([status])
  @@index([employer_name])
  @@map("gnucash_web_payslips")
}
```

- [ ] **Step 2: Add `gnucash_web_payslip_mappings` model**

Add immediately after the payslips model:

```prisma
model gnucash_web_payslip_mappings {
  id                 Int      @id @default(autoincrement())
  book_guid          String   @db.VarChar(32)
  employer_name      String   @db.VarChar(255)
  normalized_label   String   @db.VarChar(255)
  line_item_category String   @db.VarChar(30)
  account_guid       String   @db.VarChar(32)
  created_at         DateTime @default(now())
  updated_at         DateTime @default(now())

  @@unique([book_guid, employer_name, normalized_label, line_item_category])
  @@index([book_guid, employer_name])
  @@map("gnucash_web_payslip_mappings")
}
```

- [ ] **Step 3: Generate Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(payslips): add Prisma models for payslips and mappings"
```

---

## Task 3: Database DDL in db-init.ts

**Files:**
- Modify: `src/lib/db-init.ts`

- [ ] **Step 1: Add payslips table DDL**

Inside `createExtensionTables()`, add the DDL string and execute it. Find the block where other `gnucash_web_*` tables are created (look for the receipts DDL near line 480) and add after it:

```typescript
const payslipsTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_payslips (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        pay_date DATE NOT NULL,
        pay_period_start DATE,
        pay_period_end DATE,
        employer_name VARCHAR(255) NOT NULL,
        gross_pay DECIMAL(12,2),
        net_pay DECIMAL(12,2),
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        source VARCHAR(20) NOT NULL DEFAULT 'pdf_upload',
        source_id VARCHAR(255),
        transaction_guid VARCHAR(32),
        storage_key VARCHAR(500),
        thumbnail_key VARCHAR(500),
        line_items JSONB,
        raw_response JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'processing',
        error_message TEXT,
        deposit_account_guid VARCHAR(32),
        created_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_payslips_book ON gnucash_web_payslips(book_guid);
    CREATE INDEX IF NOT EXISTS idx_payslips_pay_date ON gnucash_web_payslips(pay_date);
    CREATE INDEX IF NOT EXISTS idx_payslips_status ON gnucash_web_payslips(status);
    CREATE INDEX IF NOT EXISTS idx_payslips_employer ON gnucash_web_payslips(employer_name);

    CREATE TABLE IF NOT EXISTS gnucash_web_payslip_mappings (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        employer_name VARCHAR(255) NOT NULL,
        normalized_label VARCHAR(255) NOT NULL,
        line_item_category VARCHAR(30) NOT NULL,
        account_guid VARCHAR(32) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_guid, employer_name, normalized_label, line_item_category)
    );
    CREATE INDEX IF NOT EXISTS idx_payslip_mappings_employer ON gnucash_web_payslip_mappings(book_guid, employer_name);
`;
```

Then add `await query(payslipsTableDDL);` in the execution list where other table DDLs are executed.

- [ ] **Step 2: Verify db-init compiles**

Run: `npx tsc --noEmit src/lib/db-init.ts 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat(payslips): add DDL for payslips and mappings tables"
```

---

## Task 4: Payslip DB Service (CRUD via Prisma)

**Files:**
- Create: `src/lib/payslips.ts`
- Test: `src/lib/__tests__/payslips.test.ts`

- [ ] **Step 1: Write failing tests for payslip CRUD helpers**

Create `src/lib/__tests__/payslips.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma
const mockPrisma = {
  gnucash_web_payslips: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  gnucash_web_payslip_mappings: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
};

vi.mock('@/lib/prisma', () => ({ default: mockPrisma }));

import {
  listPayslips,
  getPayslip,
  createPayslip,
  updatePayslipStatus,
  getMappingsForEmployer,
  upsertMapping,
} from '../payslips';

describe('listPayslips', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns payslips filtered by book_guid', async () => {
    mockPrisma.gnucash_web_payslips.findMany.mockResolvedValue([
      { id: 1, employer_name: 'Acme', status: 'ready' },
    ]);

    const result = await listPayslips('book123');

    expect(mockPrisma.gnucash_web_payslips.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ book_guid: 'book123' }),
        orderBy: { pay_date: 'desc' },
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].employer_name).toBe('Acme');
  });
});

describe('getPayslip', () => {
  it('returns payslip by id and book_guid', async () => {
    mockPrisma.gnucash_web_payslips.findFirst.mockResolvedValue({
      id: 1, employer_name: 'Acme',
    });

    const result = await getPayslip(1, 'book123');

    expect(mockPrisma.gnucash_web_payslips.findFirst).toHaveBeenCalledWith({
      where: { id: 1, book_guid: 'book123' },
    });
    expect(result?.employer_name).toBe('Acme');
  });
});

describe('createPayslip', () => {
  it('creates a payslip record', async () => {
    mockPrisma.gnucash_web_payslips.create.mockResolvedValue({ id: 1 });

    const result = await createPayslip({
      book_guid: 'book123',
      pay_date: new Date('2026-01-15'),
      employer_name: 'Acme',
      storage_key: '2026/01/abc.pdf',
      created_by: 1,
    });

    expect(mockPrisma.gnucash_web_payslips.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        book_guid: 'book123',
        employer_name: 'Acme',
        status: 'processing',
      }),
    });
    expect(result.id).toBe(1);
  });
});

describe('updatePayslipStatus', () => {
  it('updates status and optional fields', async () => {
    mockPrisma.gnucash_web_payslips.update.mockResolvedValue({ id: 1, status: 'ready' });

    await updatePayslipStatus(1, 'ready', { gross_pay: 4000, net_pay: 3000 });

    expect(mockPrisma.gnucash_web_payslips.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ status: 'ready', gross_pay: 4000, net_pay: 3000 }),
    });
  });
});

describe('getMappingsForEmployer', () => {
  it('returns mappings for employer', async () => {
    mockPrisma.gnucash_web_payslip_mappings.findMany.mockResolvedValue([
      { normalized_label: 'federal_income_tax', account_guid: 'acc1' },
    ]);

    const result = await getMappingsForEmployer('book123', 'Acme');

    expect(result).toHaveLength(1);
    expect(result[0].normalized_label).toBe('federal_income_tax');
  });
});

describe('upsertMapping', () => {
  it('upserts a mapping by composite key', async () => {
    mockPrisma.gnucash_web_payslip_mappings.upsert.mockResolvedValue({ id: 1 });

    await upsertMapping({
      book_guid: 'book123',
      employer_name: 'Acme',
      normalized_label: 'federal_income_tax',
      line_item_category: 'tax',
      account_guid: 'acc1',
    });

    expect(mockPrisma.gnucash_web_payslip_mappings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          book_guid_employer_name_normalized_label_line_item_category: {
            book_guid: 'book123',
            employer_name: 'Acme',
            normalized_label: 'federal_income_tax',
            line_item_category: 'tax',
          },
        },
      })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/payslips.test.ts 2>&1 | tail -20`
Expected: FAIL — module `../payslips` cannot resolve `listPayslips` etc.

- [ ] **Step 3: Implement `src/lib/payslips.ts`**

```typescript
import prisma from '@/lib/prisma';
import type { PayslipStatus } from '@/lib/types';

export async function listPayslips(
  bookGuid: string,
  filters?: { status?: PayslipStatus; employer?: string }
) {
  const where: Record<string, unknown> = { book_guid: bookGuid };
  if (filters?.status) where.status = filters.status;
  if (filters?.employer) where.employer_name = filters.employer;

  return prisma.gnucash_web_payslips.findMany({
    where,
    orderBy: { pay_date: 'desc' },
  });
}

export async function getPayslip(id: number, bookGuid: string) {
  return prisma.gnucash_web_payslips.findFirst({
    where: { id, book_guid: bookGuid },
  });
}

export async function createPayslip(data: {
  book_guid: string;
  pay_date: Date;
  employer_name: string;
  storage_key?: string;
  thumbnail_key?: string;
  created_by?: number;
  source?: string;
}) {
  return prisma.gnucash_web_payslips.create({
    data: {
      book_guid: data.book_guid,
      pay_date: data.pay_date,
      employer_name: data.employer_name,
      storage_key: data.storage_key ?? null,
      thumbnail_key: data.thumbnail_key ?? null,
      created_by: data.created_by ?? null,
      source: data.source ?? 'pdf_upload',
      status: 'processing',
    },
  });
}

export async function updatePayslipStatus(
  id: number,
  status: PayslipStatus,
  extra?: Record<string, unknown>
) {
  return prisma.gnucash_web_payslips.update({
    where: { id },
    data: { status, updated_at: new Date(), ...extra },
  });
}

export async function updatePayslipLineItems(
  id: number,
  lineItems: unknown[],
  rawResponse?: unknown
) {
  return prisma.gnucash_web_payslips.update({
    where: { id },
    data: {
      line_items: lineItems as never,
      raw_response: rawResponse ? (rawResponse as never) : undefined,
      updated_at: new Date(),
    },
  });
}

export async function getMappingsForEmployer(bookGuid: string, employerName: string) {
  return prisma.gnucash_web_payslip_mappings.findMany({
    where: { book_guid: bookGuid, employer_name: employerName },
  });
}

export async function upsertMapping(data: {
  book_guid: string;
  employer_name: string;
  normalized_label: string;
  line_item_category: string;
  account_guid: string;
}) {
  return prisma.gnucash_web_payslip_mappings.upsert({
    where: {
      book_guid_employer_name_normalized_label_line_item_category: {
        book_guid: data.book_guid,
        employer_name: data.employer_name,
        normalized_label: data.normalized_label,
        line_item_category: data.line_item_category,
      },
    },
    update: {
      account_guid: data.account_guid,
      updated_at: new Date(),
    },
    create: {
      book_guid: data.book_guid,
      employer_name: data.employer_name,
      normalized_label: data.normalized_label,
      line_item_category: data.line_item_category,
      account_guid: data.account_guid,
    },
  });
}

export async function deletePayslip(id: number, bookGuid: string) {
  return prisma.gnucash_web_payslips.delete({
    where: { id, book_guid: bookGuid },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/payslips.test.ts 2>&1 | tail -20`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/payslips.ts src/lib/__tests__/payslips.test.ts
git commit -m "feat(payslips): add Prisma-based payslip CRUD service"
```

---

## Task 5: Payslip AI Extraction

**Files:**
- Create: `src/lib/payslip-extraction.ts`
- Test: `src/lib/__tests__/payslip-extraction.test.ts`

- [ ] **Step 1: Write failing tests for payslip extraction**

Create `src/lib/__tests__/payslip-extraction.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { parsePayslipAiResponse, buildPayslipExtractionPrompt } from '../payslip-extraction';

describe('parsePayslipAiResponse', () => {
  it('parses valid JSON response with line items', () => {
    const raw = JSON.stringify({
      employer_name: 'Acme Corp',
      pay_date: '2026-01-15',
      pay_period_start: '2026-01-01',
      pay_period_end: '2026-01-15',
      gross_pay: 4000,
      net_pay: 3002,
      line_items: [
        { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000, hours: 80, rate: 50 },
        { category: 'tax', label: 'Federal Income Tax', normalized_label: 'federal_income_tax', amount: -600 },
        { category: 'deduction', label: '401(k)', normalized_label: '401k', amount: -398 },
      ],
    });

    const result = parsePayslipAiResponse(raw);

    expect(result.employer_name).toBe('Acme Corp');
    expect(result.gross_pay).toBe(4000);
    expect(result.net_pay).toBe(3002);
    expect(result.line_items).toHaveLength(3);
    expect(result.line_items[0].category).toBe('earnings');
    expect(result.line_items[0].normalized_label).toBe('regular_pay');
    expect(result.line_items[1].amount).toBe(-600);
  });

  it('handles markdown-wrapped JSON', () => {
    const raw = '```json\n{"employer_name":"Acme","pay_date":"2026-01-15","gross_pay":4000,"net_pay":3000,"line_items":[]}\n```';
    const result = parsePayslipAiResponse(raw);
    expect(result.employer_name).toBe('Acme');
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePayslipAiResponse('not json')).toThrow();
  });

  it('throws on missing required fields', () => {
    const raw = JSON.stringify({ employer_name: 'Acme' });
    expect(() => parsePayslipAiResponse(raw)).toThrow();
  });
});

describe('buildPayslipExtractionPrompt', () => {
  it('returns system and user messages', () => {
    const { system, user } = buildPayslipExtractionPrompt('Regular Pay: $4,000.00\nFed Tax: -$600');

    expect(system).toContain('payslip');
    expect(system).toContain('normalized_label');
    expect(user).toContain('Regular Pay');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/payslip-extraction.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/lib/payslip-extraction.ts`**

```typescript
import type { AiConfig } from '@/lib/receipt-extraction';
import type { PayslipLineItem, PayslipLineItemCategory } from '@/lib/types';

export interface PayslipExtractedData {
  employer_name: string;
  pay_date: string;
  pay_period_start?: string;
  pay_period_end?: string;
  gross_pay: number;
  net_pay: number;
  line_items: PayslipLineItem[];
}

const VALID_CATEGORIES: PayslipLineItemCategory[] = [
  'earnings', 'tax', 'deduction', 'employer_contribution', 'reimbursement',
];

export function buildPayslipExtractionPrompt(ocrText: string) {
  const system = `You are a payslip data extraction assistant. Extract structured data from payslip/pay stub text.

Return ONLY valid JSON with this exact structure:
{
  "employer_name": "string",
  "pay_date": "YYYY-MM-DD",
  "pay_period_start": "YYYY-MM-DD or null",
  "pay_period_end": "YYYY-MM-DD or null",
  "gross_pay": number,
  "net_pay": number,
  "line_items": [
    {
      "category": "earnings|tax|deduction|employer_contribution|reimbursement",
      "label": "Original label from payslip",
      "normalized_label": "lowercase_snake_case_key",
      "amount": number (positive for earnings/reimbursements, negative for taxes/deductions),
      "hours": number or null (for earnings only),
      "rate": number or null (for earnings only)
    }
  ]
}

Rules for normalized_label:
- Lowercase, underscores, no spaces or punctuation
- "Federal Income Tax" → "federal_income_tax"
- "Social Security" or "OASDI" → "social_security"
- "Medicare" → "medicare"
- "401(k)" or "401K" → "401k"
- "Health Insurance" or "Medical" → "health_insurance"
- "Regular Pay" or "Base Pay" → "regular_pay"
- "Overtime" → "overtime"

Taxes and deductions must have negative amounts. Earnings and reimbursements must have positive amounts. Employer contributions must have positive amounts.

No explanation, no markdown, just the JSON object.`;

  return { system, user: ocrText };
}

export function parsePayslipAiResponse(raw: string): PayslipExtractedData {
  // Strip markdown code blocks if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(cleaned);

  // Validate required fields
  if (!parsed.employer_name || !parsed.pay_date || parsed.gross_pay == null || parsed.net_pay == null) {
    throw new Error('Missing required fields: employer_name, pay_date, gross_pay, net_pay');
  }

  // Validate and normalize line items
  const line_items: PayslipLineItem[] = (parsed.line_items || []).map((item: Record<string, unknown>) => {
    if (!VALID_CATEGORIES.includes(item.category as PayslipLineItemCategory)) {
      throw new Error(`Invalid category: ${item.category}`);
    }
    return {
      category: item.category as PayslipLineItemCategory,
      label: String(item.label),
      normalized_label: String(item.normalized_label || '').toLowerCase().replace(/[^a-z0-9]/g, '_'),
      amount: Number(item.amount),
      hours: item.hours != null ? Number(item.hours) : undefined,
      rate: item.rate != null ? Number(item.rate) : undefined,
    };
  });

  return {
    employer_name: String(parsed.employer_name),
    pay_date: String(parsed.pay_date),
    pay_period_start: parsed.pay_period_start ? String(parsed.pay_period_start) : undefined,
    pay_period_end: parsed.pay_period_end ? String(parsed.pay_period_end) : undefined,
    gross_pay: Number(parsed.gross_pay),
    net_pay: Number(parsed.net_pay),
    line_items,
  };
}

/** Send OCR text to AI provider for structured extraction. */
export async function extractPayslipData(
  ocrText: string,
  aiConfig: AiConfig
): Promise<PayslipExtractedData> {
  const { system, user } = buildPayslipExtractionPrompt(ocrText);

  const baseUrl = aiConfig.base_url?.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aiConfig.api_key}`,
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`AI API returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI returned empty response');

  return parsePayslipAiResponse(content);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/payslip-extraction.test.ts 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/payslip-extraction.ts src/lib/__tests__/payslip-extraction.test.ts
git commit -m "feat(payslips): add AI extraction prompt and response parser"
```

---

## Task 6: Transaction Generation Service

**Files:**
- Create: `src/lib/services/payslip-post.service.ts`
- Test: `src/lib/__tests__/payslip-post.test.ts`

- [ ] **Step 1: Write failing tests for transaction generation**

Create `src/lib/__tests__/payslip-post.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validatePayslipBalance, buildSplitsFromLineItems } from '../services/payslip-post.service';
import type { PayslipLineItem } from '@/lib/types';

describe('validatePayslipBalance', () => {
  it('returns zero imbalance for balanced payslip', () => {
    const lineItems: PayslipLineItem[] = [
      { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000 },
      { category: 'tax', label: 'Federal Tax', normalized_label: 'federal_income_tax', amount: -600 },
      { category: 'deduction', label: '401k', normalized_label: '401k', amount: -400 },
    ];
    const netPay = 3000;

    const imbalance = validatePayslipBalance(lineItems, netPay);
    expect(imbalance).toBe(0);
  });

  it('returns positive imbalance when line items exceed net pay', () => {
    const lineItems: PayslipLineItem[] = [
      { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000 },
      { category: 'tax', label: 'Federal Tax', normalized_label: 'federal_income_tax', amount: -600 },
    ];
    const netPay = 3000;

    const imbalance = validatePayslipBalance(lineItems, netPay);
    expect(imbalance).toBe(400); // 4000 - 600 - 3000 = 400
  });
});

describe('buildSplitsFromLineItems', () => {
  it('creates splits for each mapped line item plus deposit', () => {
    const lineItems: PayslipLineItem[] = [
      { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000 },
      { category: 'tax', label: 'Federal Tax', normalized_label: 'federal_income_tax', amount: -600 },
    ];
    const mappings: Record<string, string> = {
      'earnings:regular_pay': 'income-guid',
      'tax:federal_income_tax': 'tax-guid',
    };
    const depositAccountGuid = 'bank-guid';
    const netPay = 3400;

    const splits = buildSplitsFromLineItems(lineItems, mappings, depositAccountGuid, netPay);

    // Should have 3 splits: earnings, tax, deposit
    expect(splits).toHaveLength(3);

    // Earnings split: credit income account (negative in GnuCash for income)
    const earningsSplit = splits.find(s => s.accountGuid === 'income-guid');
    expect(earningsSplit).toBeDefined();
    expect(earningsSplit!.amount).toBe(-4000);

    // Tax split: debit expense account (positive in GnuCash for expense)
    const taxSplit = splits.find(s => s.accountGuid === 'tax-guid');
    expect(taxSplit).toBeDefined();
    expect(taxSplit!.amount).toBe(600);

    // Deposit split: debit bank account (positive)
    const depositSplit = splits.find(s => s.accountGuid === 'bank-guid');
    expect(depositSplit).toBeDefined();
    expect(depositSplit!.amount).toBe(3400);
  });

  it('excludes employer_contribution items from splits', () => {
    const lineItems: PayslipLineItem[] = [
      { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000 },
      { category: 'employer_contribution', label: '401k Match', normalized_label: '401k_match', amount: 200 },
    ];
    const mappings: Record<string, string> = {
      'earnings:regular_pay': 'income-guid',
      'employer_contribution:401k_match': 'match-guid',
    };

    const splits = buildSplitsFromLineItems(lineItems, mappings, 'bank-guid', 4000);

    // 2 splits: earnings + deposit. Employer contribution excluded.
    expect(splits).toHaveLength(2);
    expect(splits.find(s => s.accountGuid === 'match-guid')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/payslip-post.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/lib/services/payslip-post.service.ts`**

```typescript
import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';
import { updatePayslipStatus } from '@/lib/payslips';
import type { PayslipLineItem } from '@/lib/types';

interface SplitData {
  accountGuid: string;
  amount: number;
  memo: string;
}

/**
 * Validate that line items sum correctly against net pay.
 * Returns the imbalance amount (0 = balanced).
 * Formula: sum(all non-employer-contribution items) - net_pay
 */
export function validatePayslipBalance(lineItems: PayslipLineItem[], netPay: number): number {
  const sum = lineItems
    .filter(item => item.category !== 'employer_contribution')
    .reduce((acc, item) => acc + item.amount, 0);
  return Math.round((sum - netPay) * 100) / 100;
}

/**
 * Build GnuCash split data from line items + mappings.
 * Mappings key format: "category:normalized_label" → account_guid.
 *
 * GnuCash sign convention for payslips:
 * - Income accounts: credited (negative value_num) for earnings
 * - Expense accounts: debited (positive value_num) for taxes/deductions
 * - Bank account: debited (positive value_num) for net deposit
 */
export function buildSplitsFromLineItems(
  lineItems: PayslipLineItem[],
  mappings: Record<string, string>,
  depositAccountGuid: string,
  netPay: number
): SplitData[] {
  const splits: SplitData[] = [];

  for (const item of lineItems) {
    if (item.category === 'employer_contribution') continue;

    const key = `${item.category}:${item.normalized_label}`;
    const accountGuid = mappings[key];
    if (!accountGuid) continue;

    // Flip sign for GnuCash: earnings become credits (negative), taxes/deductions become debits (positive)
    const gnucashAmount = item.category === 'earnings' || item.category === 'reimbursement'
      ? -item.amount   // credit income account
      : -item.amount;  // deductions are already negative, negating makes them positive (debit expense)

    splits.push({
      accountGuid,
      amount: gnucashAmount,
      memo: item.label,
    });
  }

  // Deposit split: net pay debits the bank account
  splits.push({
    accountGuid: depositAccountGuid,
    amount: netPay,
    memo: 'Net pay deposit',
  });

  return splits;
}

/**
 * Post a payslip as a GnuCash transaction with splits.
 * Uses a Prisma interactive transaction for atomicity.
 */
export async function postPayslipTransaction(
  payslipId: number,
  bookGuid: string,
  currencyGuid: string,
  lineItems: PayslipLineItem[],
  mappings: Record<string, string>,
  depositAccountGuid: string,
  netPay: number,
  payDate: Date,
  employerName: string,
  imbalanceAccountGuid?: string
): Promise<string> {
  const imbalance = validatePayslipBalance(lineItems, netPay);
  const splits = buildSplitsFromLineItems(lineItems, mappings, depositAccountGuid, netPay);

  // Add imbalance split if needed
  if (Math.abs(imbalance) >= 0.01 && imbalanceAccountGuid) {
    splits.push({
      accountGuid: imbalanceAccountGuid,
      amount: -imbalance,
      memo: 'Payslip rounding',
    });
  } else if (Math.abs(imbalance) >= 0.01) {
    throw new Error(`Payslip has $${imbalance.toFixed(2)} imbalance and no imbalance account configured`);
  }

  // Verify splits sum to zero
  const total = splits.reduce((acc, s) => acc + s.amount, 0);
  if (Math.abs(total) >= 0.01) {
    throw new Error(`Splits do not balance: total = ${total.toFixed(2)}`);
  }

  const transactionGuid = generateGuid();
  const postDate = new Date(payDate.toISOString().split('T')[0] + 'T12:00:00Z');
  const enterDate = new Date();

  await prisma.$transaction(async (tx) => {
    // Create GnuCash transaction
    await tx.$executeRaw`
      INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
      VALUES (${transactionGuid}, ${currencyGuid}, '', ${postDate}, ${enterDate}, ${`Payslip: ${employerName}`})
    `;

    // Create splits
    for (const split of splits) {
      const splitGuid = generateGuid();
      const { num, denom } = fromDecimal(split.amount);

      await tx.$executeRaw`
        INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
        VALUES (${splitGuid}, ${transactionGuid}, ${split.accountGuid}, ${split.memo}, '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
      `;
    }

    // Link payslip to transaction
    await tx.gnucash_web_payslips.update({
      where: { id: payslipId },
      data: {
        transaction_guid: transactionGuid,
        status: 'posted',
        deposit_account_guid: depositAccountGuid,
        updated_at: new Date(),
      },
    });
  });

  return transactionGuid;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/payslip-post.test.ts 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/payslip-post.service.ts src/lib/__tests__/payslip-post.test.ts
git commit -m "feat(payslips): add transaction generation service with balance validation"
```

---

## Task 7: BullMQ Extraction Job

**Files:**
- Create: `src/lib/queue/jobs/extract-payslip.ts`
- Modify: `worker.ts`

- [ ] **Step 1: Create the extract-payslip job handler**

Create `src/lib/queue/jobs/extract-payslip.ts`:

```typescript
import { Job } from 'bullmq';

export async function handleExtractPayslip(job: Job): Promise<void> {
  const { payslipId } = job.data as { payslipId: number; bookGuid?: string };
  console.log(`[Job ${job.id}] Starting payslip extraction for ${payslipId}`);

  const { getPayslip, updatePayslipStatus, updatePayslipLineItems } = await import('@/lib/payslips');
  const { getMappingsForEmployer } = await import('@/lib/payslips');

  try {
    await updatePayslipStatus(payslipId, 'processing');

    // Look up payslip
    const prisma = (await import('@/lib/prisma')).default;
    const payslip = await prisma.gnucash_web_payslips.findFirst({ where: { id: payslipId } });
    if (!payslip) {
      console.warn(`[Job ${job.id}] Payslip ${payslipId} not found, skipping`);
      return;
    }

    if (!payslip.storage_key) {
      await updatePayslipStatus(payslipId, 'error', { error_message: 'No PDF file attached' });
      return;
    }

    // Get PDF and extract text
    const { getStorageBackend } = await import('@/lib/storage/storage-backend');
    const storage = await getStorageBackend();
    const buffer = await storage.get(payslip.storage_key);

    // OCR: extract text from PDF
    const { extractTextFromPdf } = await import('./ocr-receipt');
    const ocrText = await extractTextFromPdf(buffer);

    if (!ocrText || ocrText.trim().length === 0) {
      await updatePayslipStatus(payslipId, 'error', { error_message: 'Could not extract text from PDF' });
      return;
    }

    // AI extraction
    const { getAiConfig } = await import('@/lib/ai-config');
    const aiConfig = await getAiConfig(payslip.created_by);

    if (!aiConfig?.enabled || !aiConfig.base_url || !aiConfig.model) {
      await updatePayslipStatus(payslipId, 'error', { error_message: 'AI extraction not configured. Configure an AI provider in Settings.' });
      return;
    }

    const { extractPayslipData } = await import('@/lib/payslip-extraction');
    const extracted = await extractPayslipData(ocrText, aiConfig);

    // Update payslip with extracted data
    await updatePayslipLineItems(payslipId, extracted.line_items, { ocrText, aiResponse: extracted });
    await updatePayslipStatus(payslipId, 'needs_mapping', {
      employer_name: extracted.employer_name,
      pay_date: new Date(extracted.pay_date),
      pay_period_start: extracted.pay_period_start ? new Date(extracted.pay_period_start) : null,
      pay_period_end: extracted.pay_period_end ? new Date(extracted.pay_period_end) : null,
      gross_pay: extracted.gross_pay,
      net_pay: extracted.net_pay,
    });

    // Check if all line items have existing mappings
    const mappings = await getMappingsForEmployer(payslip.book_guid, extracted.employer_name);
    const mappingKeys = new Set(mappings.map(m => `${m.line_item_category}:${m.normalized_label}`));
    const unmapped = extracted.line_items.filter(
      item => !mappingKeys.has(`${item.category}:${item.normalized_label}`)
    );

    if (unmapped.length === 0 && mappings.length > 0) {
      await updatePayslipStatus(payslipId, 'ready');
      console.log(`[Job ${job.id}] All line items auto-mapped, status → ready`);
    } else {
      console.log(`[Job ${job.id}] ${unmapped.length} unmapped line items, status → needs_mapping`);
    }

    console.log(`[Job ${job.id}] Extraction complete: ${extracted.line_items.length} line items, employer="${extracted.employer_name}"`);
  } catch (err) {
    console.error(`[Job ${job.id}] Payslip extraction failed:`, err);
    await updatePayslipStatus(payslipId, 'error', {
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
```

- [ ] **Step 2: Register job in worker.ts**

In `worker.ts`, find the `switch (job.name)` block (around line 208). Add a new case before the `default:` case:

```typescript
        case 'extract-payslip': {
          const { handleExtractPayslip } = await import('./src/lib/queue/jobs/extract-payslip');
          await handleExtractPayslip(job);
          break;
        }
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/queue/jobs/extract-payslip.ts worker.ts
git commit -m "feat(payslips): add BullMQ extraction job and register in worker"
```

---

## Task 8: Upload API Route

**Files:**
- Create: `src/app/api/payslips/upload/route.ts`

- [ ] **Step 1: Create the upload route**

```bash
mkdir -p src/app/api/payslips/upload
```

Create `src/app/api/payslips/upload/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createPayslip } from '@/lib/payslips';
import { getStorageBackend, generateStorageKey, thumbnailKeyFrom } from '@/lib/storage/storage-backend';
import { generateThumbnail } from '@/lib/storage/thumbnail';
import { enqueueJob } from '@/lib/queue/queues';

function detectMimeType(buffer: Buffer): string | null {
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  return null;
}

export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const storage = await getStorageBackend();
    const results: Array<{ id: number; filename: string; status: string }> = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());

      // Validate file type (only PDFs for payslips)
      const mimeType = detectMimeType(buffer);
      if (mimeType !== 'application/pdf') {
        results.push({ id: 0, filename: file.name, status: 'error: only PDF files accepted' });
        continue;
      }

      // Validate size (10MB)
      if (buffer.length > 10 * 1024 * 1024) {
        results.push({ id: 0, filename: file.name, status: 'error: file too large (max 10MB)' });
        continue;
      }

      const storageKey = generateStorageKey(file.name);
      let thumbnailKey: string | null = null;

      // Store PDF
      await storage.put(storageKey, buffer, mimeType);

      // Generate thumbnail
      try {
        const thumbBuffer = await generateThumbnail(buffer, mimeType);
        if (thumbBuffer) {
          thumbnailKey = thumbnailKeyFrom(storageKey);
          await storage.put(thumbnailKey, thumbBuffer, 'image/jpeg');
        }
      } catch (err) {
        console.warn('Thumbnail generation failed:', err);
      }

      // Create DB record — pay_date will be updated by extraction
      const payslip = await createPayslip({
        book_guid: bookGuid,
        pay_date: new Date(), // placeholder until AI extracts real date
        employer_name: 'Unknown', // placeholder until AI extracts
        storage_key: storageKey,
        thumbnail_key: thumbnailKey ?? undefined,
        created_by: user.id,
      });

      // Enqueue extraction job
      const jobId = await enqueueJob('extract-payslip', {
        payslipId: payslip.id,
        bookGuid,
      });

      if (!jobId) {
        const { updatePayslipStatus } = await import('@/lib/payslips');
        await updatePayslipStatus(payslip.id, 'error', {
          error_message: 'Failed to enqueue extraction job (Redis unavailable)',
        });
      }

      results.push({ id: payslip.id, filename: file.name, status: 'processing' });
    }

    return NextResponse.json({ results });
  } catch (err) {
    console.error('Payslip upload error:', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit src/app/api/payslips/upload/route.ts 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/payslips/upload/route.ts
git commit -m "feat(payslips): add PDF upload API route"
```

---

## Task 9: List & Detail API Routes

**Files:**
- Create: `src/app/api/payslips/route.ts`
- Create: `src/app/api/payslips/[id]/route.ts`
- Create: `src/app/api/payslips/[id]/post/route.ts`
- Create: `src/app/api/payslips/[id]/match/route.ts`
- Create: `src/app/api/payslips/mappings/route.ts`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p src/app/api/payslips/\[id\]/post src/app/api/payslips/\[id\]/match src/app/api/payslips/mappings
```

- [ ] **Step 2: Create list route `src/app/api/payslips/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listPayslips } from '@/lib/payslips';
import type { PayslipStatus } from '@/lib/types';

export async function GET(request: Request) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;
  const { bookGuid } = roleResult;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') as PayslipStatus | null;
  const employer = url.searchParams.get('employer');

  const payslips = await listPayslips(bookGuid, {
    status: status ?? undefined,
    employer: employer ?? undefined,
  });

  return NextResponse.json(payslips);
}
```

- [ ] **Step 3: Create detail route `src/app/api/payslips/[id]/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPayslip, updatePayslipStatus, updatePayslipLineItems, deletePayslip } from '@/lib/payslips';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;
  const { bookGuid } = roleResult;
  const { id } = await params;

  const payslip = await getPayslip(parseInt(id, 10), bookGuid);
  if (!payslip) {
    return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
  }

  return NextResponse.json(payslip);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const roleResult = await requireRole('edit');
  if (roleResult instanceof NextResponse) return roleResult;
  const { bookGuid } = roleResult;
  const { id } = await params;
  const payslipId = parseInt(id, 10);

  const payslip = await getPayslip(payslipId, bookGuid);
  if (!payslip) {
    return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
  }

  const body = await request.json();

  // Update line items if provided
  if (body.line_items) {
    await updatePayslipLineItems(payslipId, body.line_items);
  }

  // Update status if provided
  if (body.status) {
    await updatePayslipStatus(payslipId, body.status, {
      deposit_account_guid: body.deposit_account_guid ?? undefined,
    });
  }

  const updated = await getPayslip(payslipId, bookGuid);
  return NextResponse.json(updated);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const roleResult = await requireRole('edit');
  if (roleResult instanceof NextResponse) return roleResult;
  const { bookGuid } = roleResult;
  const { id } = await params;
  const payslipId = parseInt(id, 10);

  const payslip = await getPayslip(payslipId, bookGuid);
  if (!payslip) {
    return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
  }

  if (payslip.status === 'posted') {
    return NextResponse.json({ error: 'Cannot delete a posted payslip' }, { status: 400 });
  }

  // Delete stored files
  if (payslip.storage_key) {
    try {
      const { getStorageBackend } = await import('@/lib/storage/storage-backend');
      const storage = await getStorageBackend();
      await storage.delete(payslip.storage_key);
      if (payslip.thumbnail_key) await storage.delete(payslip.thumbnail_key);
    } catch (err) {
      console.warn('Failed to delete payslip files:', err);
    }
  }

  await deletePayslip(payslipId, bookGuid);
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Create post route `src/app/api/payslips/[id]/post/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPayslip, getMappingsForEmployer } from '@/lib/payslips';
import { postPayslipTransaction } from '@/lib/services/payslip-post.service';
import type { PayslipLineItem } from '@/lib/types';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const roleResult = await requireRole('edit');
  if (roleResult instanceof NextResponse) return roleResult;
  const { bookGuid } = roleResult;
  const { id } = await params;
  const payslipId = parseInt(id, 10);

  const payslip = await getPayslip(payslipId, bookGuid);
  if (!payslip) {
    return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
  }

  if (payslip.status === 'posted') {
    return NextResponse.json({ error: 'Payslip already posted' }, { status: 400 });
  }

  const body = await request.json();
  const depositAccountGuid: string = body.deposit_account_guid;
  const currencyGuid: string = body.currency_guid;
  const imbalanceAccountGuid: string | undefined = body.imbalance_account_guid;

  if (!depositAccountGuid || !currencyGuid) {
    return NextResponse.json({ error: 'deposit_account_guid and currency_guid required' }, { status: 400 });
  }

  const lineItems = payslip.line_items as PayslipLineItem[];
  if (!lineItems || lineItems.length === 0) {
    return NextResponse.json({ error: 'No line items to post' }, { status: 400 });
  }

  // Build mappings lookup
  const mappingRows = await getMappingsForEmployer(bookGuid, payslip.employer_name);
  const mappings: Record<string, string> = {};
  for (const row of mappingRows) {
    mappings[`${row.line_item_category}:${row.normalized_label}`] = row.account_guid;
  }

  // Check all non-employer-contribution items are mapped
  const unmapped = lineItems.filter(
    item => item.category !== 'employer_contribution' && !mappings[`${item.category}:${item.normalized_label}`]
  );
  if (unmapped.length > 0) {
    return NextResponse.json({
      error: 'Unmapped line items',
      unmapped: unmapped.map(i => `${i.category}:${i.label}`),
    }, { status: 400 });
  }

  try {
    const transactionGuid = await postPayslipTransaction(
      payslipId,
      bookGuid,
      currencyGuid,
      lineItems,
      mappings,
      depositAccountGuid,
      Number(payslip.net_pay),
      payslip.pay_date,
      payslip.employer_name,
      imbalanceAccountGuid
    );

    return NextResponse.json({ transaction_guid: transactionGuid });
  } catch (err) {
    console.error('Failed to post payslip transaction:', err);
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Failed to post transaction',
    }, { status: 500 });
  }
}
```

- [ ] **Step 5: Create SimpleFin match route `src/app/api/payslips/[id]/match/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getPayslip } from '@/lib/payslips';
import prisma from '@/lib/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;
  const { bookGuid } = roleResult;
  const { id } = await params;

  const payslip = await getPayslip(parseInt(id, 10), bookGuid);
  if (!payslip) {
    return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
  }

  if (!payslip.net_pay || !payslip.pay_date) {
    return NextResponse.json({ candidates: [] });
  }

  // Fuzzy match: +/- 3 days, amount within $0.01
  const candidates = await prisma.$queryRaw<Array<{
    guid: string;
    post_date: Date;
    description: string;
    amount: string;
    simplefin_transaction_id: string | null;
  }>>`
    SELECT t.guid, t.post_date, t.description,
           (s.value_num::numeric / s.value_denom::numeric) as amount,
           tm.simplefin_transaction_id
    FROM transactions t
    JOIN splits s ON s.tx_guid = t.guid
    LEFT JOIN gnucash_web_transaction_meta tm ON tm.transaction_guid = t.guid
    WHERE s.account_guid IN (
      SELECT guid FROM accounts
      WHERE account_type IN ('BANK', 'CREDIT_CARD')
    )
    AND ABS((s.value_num::numeric / s.value_denom::numeric) - ${Number(payslip.net_pay)}) < 0.02
    AND t.post_date BETWEEN ${new Date(payslip.pay_date.getTime() - 3 * 86400000)}
                        AND ${new Date(payslip.pay_date.getTime() + 3 * 86400000)}
    ORDER BY ABS(EXTRACT(EPOCH FROM t.post_date - ${payslip.pay_date}))
    LIMIT 10
  `;

  return NextResponse.json({ candidates });
}
```

- [ ] **Step 6: Create mappings route `src/app/api/payslips/mappings/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getMappingsForEmployer, upsertMapping } from '@/lib/payslips';

export async function GET(request: Request) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;
  const { bookGuid } = roleResult;

  const url = new URL(request.url);
  const employer = url.searchParams.get('employer');
  if (!employer) {
    return NextResponse.json({ error: 'employer query param required' }, { status: 400 });
  }

  const mappings = await getMappingsForEmployer(bookGuid, employer);
  return NextResponse.json(mappings);
}

export async function PUT(request: Request) {
  const roleResult = await requireRole('edit');
  if (roleResult instanceof NextResponse) return roleResult;
  const { bookGuid } = roleResult;

  const body = await request.json();
  const { employer_name, mappings } = body as {
    employer_name: string;
    mappings: Array<{
      normalized_label: string;
      line_item_category: string;
      account_guid: string;
    }>;
  };

  if (!employer_name || !mappings?.length) {
    return NextResponse.json({ error: 'employer_name and mappings required' }, { status: 400 });
  }

  for (const m of mappings) {
    await upsertMapping({
      book_guid: bookGuid,
      employer_name,
      normalized_label: m.normalized_label,
      line_item_category: m.line_item_category,
      account_guid: m.account_guid,
    });
  }

  const updated = await getMappingsForEmployer(bookGuid, employer_name);
  return NextResponse.json(updated);
}
```

- [ ] **Step 7: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/app/api/payslips/
git commit -m "feat(payslips): add list, detail, post, match, and mappings API routes"
```

---

## Task 10: Sidebar Navigation

**Files:**
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Add payslip icon component**

Find the icon component section (around lines 14-120) in `Layout.tsx` and add after the `IconPaperclip` (or similar receipt icon):

```typescript
function IconPayslip({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            <path strokeLinecap="round" d="M13 3v5a1 1 0 001 1h5" />
        </svg>
    );
}
```

- [ ] **Step 2: Add "Payslips" nav item**

In the `navItems` array (around line 180), add after the Receipts entry:

```typescript
    { name: 'Payslips', href: '/payslips', icon: 'Payslip' },
```

- [ ] **Step 3: Register icon in the icon map**

Find where icons are mapped to components (search for `IconPaperclip` or a `switch`/object mapping icons to components) and add:

```typescript
    Payslip: IconPayslip,
```

- [ ] **Step 4: Verify dev server renders the nav item**

Run: `npm run dev` and check the sidebar shows "Payslips" below "Receipts"

- [ ] **Step 5: Commit**

```bash
git add src/components/Layout.tsx
git commit -m "feat(payslips): add Payslips nav item to sidebar"
```

---

## Task 11: PayslipUploadZone Component

**Files:**
- Create: `src/components/payslips/PayslipUploadZone.tsx`

- [ ] **Step 1: Create the upload zone component**

```bash
mkdir -p src/components/payslips
```

Create `src/components/payslips/PayslipUploadZone.tsx`:

```tsx
'use client';

import { useState, useRef, useCallback } from 'react';

interface UploadResult {
  id: number;
  filename: string;
  status: string;
}

interface PayslipUploadZoneProps {
  onUploadComplete?: (results: UploadResult[]) => void;
}

export default function PayslipUploadZone({ onUploadComplete }: PayslipUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<Array<{ name: string; status: 'uploading' | 'success' | 'error'; message?: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));

    if (fileArray.length === 0) return;

    setUploads(fileArray.map(f => ({ name: f.name, status: 'uploading' as const })));

    const formData = new FormData();
    for (const file of fileArray) {
      formData.append('files', file);
    }

    try {
      const res = await fetch('/api/payslips/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);

      const data = await res.json();
      const results: UploadResult[] = data.results;

      setUploads(results.map(r => ({
        name: r.filename,
        status: r.status === 'processing' ? 'success' as const : 'error' as const,
        message: r.status !== 'processing' ? r.status : undefined,
      })));

      onUploadComplete?.(results);
    } catch (err) {
      setUploads(prev => prev.map(u => ({ ...u, status: 'error' as const, message: String(err) })));
    }
  }, [onUploadComplete]);

  return (
    <div>
      <div
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
        }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl cursor-pointer transition-colors p-8 text-center ${
          isDragging
            ? 'border-primary bg-primary/10'
            : 'border-border hover:border-primary-hover hover:bg-surface-hover'
        }`}
      >
        <svg className="w-8 h-8 mx-auto mb-2 text-foreground-muted" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        <p className="text-sm text-foreground-secondary">
          Drop payslip PDFs here or click to browse
        </p>
        <p className="text-xs text-foreground-muted mt-1">
          PDF only, max 10MB
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {uploads.length > 0 && (
        <div className="mt-3 space-y-1">
          {uploads.map((u, i) => (
            <div key={i} className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg ${
              u.status === 'uploading' ? 'bg-blue-500/10 text-blue-400' :
              u.status === 'success' ? 'bg-primary/10 text-primary' :
              'bg-red-500/10 text-red-400'
            }`}>
              {u.status === 'uploading' && (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              <span className="truncate">{u.name}</span>
              {u.message && <span className="ml-auto text-foreground-muted">{u.message}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit src/components/payslips/PayslipUploadZone.tsx 2>&1 | head -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/payslips/PayslipUploadZone.tsx
git commit -m "feat(payslips): add drag-drop PDF upload zone component"
```

---

## Task 12: PayslipLineItemTable Component

**Files:**
- Create: `src/components/payslips/PayslipLineItemTable.tsx`

- [ ] **Step 1: Create the line item table component**

Create `src/components/payslips/PayslipLineItemTable.tsx`:

```tsx
'use client';

import { useState, useEffect } from 'react';
import type { PayslipLineItem } from '@/lib/types';
import AccountSelector from '@/components/ui/AccountSelector';

interface MappingEntry {
  normalized_label: string;
  line_item_category: string;
  account_guid: string;
}

interface PayslipLineItemTableProps {
  lineItems: PayslipLineItem[];
  employerName: string;
  mappings: MappingEntry[];
  onMappingChange: (normalized_label: string, category: string, account_guid: string) => void;
  onLineItemEdit?: (index: number, field: string, value: unknown) => void;
  editable?: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  earnings: 'text-positive',
  tax: 'text-negative',
  deduction: 'text-negative',
  employer_contribution: 'text-foreground-muted',
  reimbursement: 'text-primary',
};

const CATEGORY_LABELS: Record<string, string> = {
  earnings: 'Earnings',
  tax: 'Tax',
  deduction: 'Deduction',
  employer_contribution: 'Employer',
  reimbursement: 'Reimbursement',
};

export default function PayslipLineItemTable({
  lineItems,
  employerName,
  mappings,
  onMappingChange,
  onLineItemEdit,
  editable = true,
}: PayslipLineItemTableProps) {
  // Build mapping lookup
  const mappingLookup: Record<string, string> = {};
  for (const m of mappings) {
    mappingLookup[`${m.line_item_category}:${m.normalized_label}`] = m.account_guid;
  }

  const unmappedCount = lineItems.filter(
    item => !mappingLookup[`${item.category}:${item.normalized_label}`]
  ).length;

  return (
    <div>
      {unmappedCount > 0 && (
        <div className="mb-3 px-3 py-2 bg-yellow-500/10 text-yellow-400 text-xs rounded-lg">
          {unmappedCount} line item{unmappedCount > 1 ? 's' : ''} need account mapping
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-foreground-muted border-b border-border">
            <th className="text-left py-2 px-2">Type</th>
            <th className="text-left py-2 px-2">Label</th>
            <th className="text-right py-2 px-2 font-mono">Amount</th>
            <th className="text-left py-2 px-2">Account</th>
          </tr>
        </thead>
        <tbody>
          {lineItems.map((item, idx) => {
            const key = `${item.category}:${item.normalized_label}`;
            const mappedGuid = mappingLookup[key];
            const isMapped = !!mappedGuid;

            return (
              <tr
                key={idx}
                className={`border-b border-border/50 ${!isMapped && item.category !== 'employer_contribution' ? 'bg-yellow-500/5' : ''}`}
              >
                <td className="py-2 px-2">
                  <span className={`text-xs font-medium ${CATEGORY_COLORS[item.category] || ''}`}>
                    {CATEGORY_LABELS[item.category] || item.category}
                  </span>
                </td>
                <td className="py-2 px-2">
                  <span className="text-foreground">{item.label}</span>
                  <span className="text-foreground-muted text-xs ml-1">({item.normalized_label})</span>
                  {item.hours && item.rate && (
                    <span className="text-foreground-muted text-xs ml-1">
                      {item.hours}h @ ${item.rate}/hr
                    </span>
                  )}
                </td>
                <td className="py-2 px-2 text-right font-mono tabular-nums">
                  {editable ? (
                    <input
                      type="number"
                      step="0.01"
                      value={item.amount}
                      onChange={(e) => onLineItemEdit?.(idx, 'amount', parseFloat(e.target.value))}
                      className="w-24 text-right bg-input-bg border border-border rounded px-2 py-1 text-sm font-mono tabular-nums focus:ring-2 focus:ring-primary/40 focus:outline-none"
                    />
                  ) : (
                    <span className={item.amount < 0 ? 'text-negative' : 'text-positive'}>
                      {item.amount < 0 ? '-' : ''}${Math.abs(item.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  )}
                </td>
                <td className="py-2 px-2">
                  {item.category === 'employer_contribution' ? (
                    <span className="text-xs text-foreground-muted italic">Informational only</span>
                  ) : (
                    <AccountSelector
                      value={mappedGuid || ''}
                      onChange={(guid) => onMappingChange(item.normalized_label, item.category, guid)}
                      placeholder="Select account..."
                      compact
                      hasError={!isMapped}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit src/components/payslips/PayslipLineItemTable.tsx 2>&1 | head -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/payslips/PayslipLineItemTable.tsx
git commit -m "feat(payslips): add editable line item table with account mapping"
```

---

## Task 13: TransactionPreview Component

**Files:**
- Create: `src/components/payslips/TransactionPreview.tsx`

- [ ] **Step 1: Create the transaction preview component**

Create `src/components/payslips/TransactionPreview.tsx`:

```tsx
'use client';

import type { PayslipLineItem } from '@/lib/types';
import { buildSplitsFromLineItems, validatePayslipBalance } from '@/lib/services/payslip-post.service';

interface TransactionPreviewProps {
  lineItems: PayslipLineItem[];
  mappings: Record<string, string>;
  accountNames: Record<string, string>; // guid → display name
  depositAccountGuid: string;
  depositAccountName: string;
  netPay: number;
  employerName: string;
  payDate: string;
}

export default function TransactionPreview({
  lineItems,
  mappings,
  accountNames,
  depositAccountGuid,
  depositAccountName,
  netPay,
  employerName,
  payDate,
}: TransactionPreviewProps) {
  const imbalance = validatePayslipBalance(lineItems, netPay);
  const splits = buildSplitsFromLineItems(lineItems, mappings, depositAccountGuid, netPay);

  return (
    <div className="bg-surface/50 rounded-xl border border-border p-4">
      <h4 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wider mb-3">
        Transaction Preview
      </h4>

      <div className="text-sm text-foreground-secondary mb-3">
        <span className="font-medium text-foreground">Payslip: {employerName}</span>
        <span className="ml-2">{payDate}</span>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-foreground-muted border-b border-border">
            <th className="text-left py-1.5 px-2">Account</th>
            <th className="text-right py-1.5 px-2 font-mono">Debit</th>
            <th className="text-right py-1.5 px-2 font-mono">Credit</th>
          </tr>
        </thead>
        <tbody>
          {splits.map((split, idx) => {
            const name = split.accountGuid === depositAccountGuid
              ? depositAccountName
              : accountNames[split.accountGuid] || split.accountGuid;
            const isDebit = split.amount > 0;

            return (
              <tr key={idx} className="border-b border-border/30">
                <td className="py-1.5 px-2 text-foreground">
                  {split.memo && <span className="text-foreground-muted text-xs mr-1">[{split.memo}]</span>}
                  {name}
                </td>
                <td className="py-1.5 px-2 text-right font-mono tabular-nums text-foreground">
                  {isDebit ? `$${split.amount.toFixed(2)}` : ''}
                </td>
                <td className="py-1.5 px-2 text-right font-mono tabular-nums text-foreground">
                  {!isDebit ? `$${Math.abs(split.amount).toFixed(2)}` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {Math.abs(imbalance) >= 0.01 && (
        <div className="mt-3 px-3 py-2 bg-yellow-500/10 text-yellow-400 text-xs rounded-lg">
          Imbalance: ${imbalance.toFixed(2)} — will be assigned to imbalance account
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/payslips/TransactionPreview.tsx
git commit -m "feat(payslips): add transaction preview component with debit/credit view"
```

---

## Task 14: PayslipDetailPanel Component

**Files:**
- Create: `src/components/payslips/PayslipDetailPanel.tsx`

- [ ] **Step 1: Create the detail panel**

Create `src/components/payslips/PayslipDetailPanel.tsx`:

```tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import type { PayslipLineItem } from '@/lib/types';
import AccountSelector from '@/components/ui/AccountSelector';
import PayslipLineItemTable from './PayslipLineItemTable';
import TransactionPreview from './TransactionPreview';

interface Payslip {
  id: number;
  employer_name: string;
  pay_date: string;
  pay_period_start: string | null;
  pay_period_end: string | null;
  gross_pay: string | null;
  net_pay: string | null;
  status: string;
  line_items: PayslipLineItem[] | null;
  storage_key: string | null;
  transaction_guid: string | null;
  deposit_account_guid: string | null;
}

interface MappingEntry {
  normalized_label: string;
  line_item_category: string;
  account_guid: string;
}

interface PayslipDetailPanelProps {
  payslipId: number;
  onClose: () => void;
  onUpdated?: () => void;
}

export default function PayslipDetailPanel({ payslipId, onClose, onUpdated }: PayslipDetailPanelProps) {
  const [payslip, setPayslip] = useState<Payslip | null>(null);
  const [mappings, setMappings] = useState<MappingEntry[]>([]);
  const [depositAccountGuid, setDepositAccountGuid] = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});

  // Fetch payslip + mappings
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/payslips/${payslipId}`);
        if (!res.ok) throw new Error('Failed to load payslip');
        const data = await res.json();
        setPayslip(data);
        setDepositAccountGuid(data.deposit_account_guid || '');

        // Fetch mappings for this employer
        if (data.employer_name) {
          const mapRes = await fetch(`/api/payslips/mappings?employer=${encodeURIComponent(data.employer_name)}`);
          if (mapRes.ok) setMappings(await mapRes.json());
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Load failed');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [payslipId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleMappingChange = useCallback(async (normalizedLabel: string, category: string, accountGuid: string) => {
    if (!payslip) return;

    // Update local state immediately
    setMappings(prev => {
      const existing = prev.findIndex(m => m.normalized_label === normalizedLabel && m.line_item_category === category);
      const entry = { normalized_label: normalizedLabel, line_item_category: category, account_guid: accountGuid };
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = entry;
        return updated;
      }
      return [...prev, entry];
    });

    // Save to server
    await fetch('/api/payslips/mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employer_name: payslip.employer_name,
        mappings: [{ normalized_label: normalizedLabel, line_item_category: category, account_guid: accountGuid }],
      }),
    });
  }, [payslip]);

  const handlePost = useCallback(async () => {
    if (!payslip || !depositAccountGuid) return;
    setPosting(true);
    setError(null);

    try {
      // Get currency guid from first account
      const accRes = await fetch(`/api/accounts`);
      const accounts = await accRes.json();
      const currencyGuid = accounts[0]?.commodity_guid || '';

      const res = await fetch(`/api/payslips/${payslipId}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deposit_account_guid: depositAccountGuid,
          currency_guid: currencyGuid,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Post failed');
      }

      const data = await res.json();
      setPayslip(prev => prev ? { ...prev, status: 'posted', transaction_guid: data.transaction_guid } : null);
      onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Post failed');
    } finally {
      setPosting(false);
    }
  }, [payslip, depositAccountGuid, payslipId, onUpdated]);

  const lineItems = payslip?.line_items || [];
  const mappingLookup: Record<string, string> = {};
  for (const m of mappings) {
    mappingLookup[`${m.line_item_category}:${m.normalized_label}`] = m.account_guid;
  }
  const allMapped = lineItems.every(
    item => item.category === 'employer_contribution' || mappingLookup[`${item.category}:${item.normalized_label}`]
  );
  const canPost = payslip?.status !== 'posted' && allMapped && depositAccountGuid && lineItems.length > 0;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full sm:w-[600px] bg-background border-l border-border z-50 overflow-y-auto" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="sticky top-0 bg-background border-b border-border px-4 py-3 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold text-foreground">
            {loading ? 'Loading...' : payslip ? `${payslip.employer_name} — ${new Date(payslip.pay_date).toLocaleDateString()}` : 'Payslip'}
          </h2>
          <button onClick={onClose} className="text-foreground-muted hover:text-foreground p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-foreground-muted text-sm">Loading payslip...</div>
        ) : !payslip ? (
          <div className="p-6 text-red-400 text-sm">Payslip not found</div>
        ) : (
          <div className="p-4 space-y-6">
            {/* Status badge */}
            <div className="flex items-center gap-3">
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                payslip.status === 'posted' ? 'bg-primary/10 text-primary' :
                payslip.status === 'ready' ? 'bg-green-500/10 text-green-400' :
                payslip.status === 'needs_mapping' ? 'bg-yellow-500/10 text-yellow-400' :
                payslip.status === 'processing' ? 'bg-blue-500/10 text-blue-400' :
                'bg-red-500/10 text-red-400'
              }`}>
                {payslip.status.replace('_', ' ')}
              </span>
              {payslip.gross_pay && (
                <span className="text-sm text-foreground-secondary">
                  Gross: <span className="font-mono tabular-nums text-foreground">${Number(payslip.gross_pay).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                </span>
              )}
              {payslip.net_pay && (
                <span className="text-sm text-foreground-secondary">
                  Net: <span className="font-mono tabular-nums text-foreground">${Number(payslip.net_pay).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                </span>
              )}
            </div>

            {/* PDF viewer */}
            {payslip.storage_key && (
              <div className="rounded-xl border border-border overflow-hidden">
                <iframe
                  src={`/api/payslips/${payslip.id}?view=pdf`}
                  className="w-full h-[400px]"
                  title="Payslip PDF"
                />
              </div>
            )}

            {/* Line items */}
            {lineItems.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground-secondary mb-2">Line Items</h3>
                <PayslipLineItemTable
                  lineItems={lineItems}
                  employerName={payslip.employer_name}
                  mappings={mappings}
                  onMappingChange={handleMappingChange}
                  editable={payslip.status !== 'posted'}
                />
              </div>
            )}

            {/* Deposit account selector */}
            {payslip.status !== 'posted' && lineItems.length > 0 && (
              <div>
                <label className="text-xs text-foreground-secondary block mb-1">Deposit Account (Net Pay)</label>
                <AccountSelector
                  value={depositAccountGuid}
                  onChange={setDepositAccountGuid}
                  placeholder="Select bank account..."
                  accountTypes={['BANK', 'CREDIT_CARD']}
                />
              </div>
            )}

            {/* Transaction preview */}
            {canPost && payslip.net_pay && (
              <TransactionPreview
                lineItems={lineItems}
                mappings={mappingLookup}
                accountNames={accountNames}
                depositAccountGuid={depositAccountGuid}
                depositAccountName="Deposit"
                netPay={Number(payslip.net_pay)}
                employerName={payslip.employer_name}
                payDate={new Date(payslip.pay_date).toLocaleDateString()}
              />
            )}

            {/* Error */}
            {error && (
              <div className="px-3 py-2 bg-red-500/10 text-red-400 text-xs rounded-lg">{error}</div>
            )}

            {/* Actions */}
            {payslip.status !== 'posted' && (
              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePost}
                  disabled={!canPost || posting}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-background hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {posting ? 'Posting...' : 'Post Transaction'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit src/components/payslips/PayslipDetailPanel.tsx 2>&1 | head -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/payslips/PayslipDetailPanel.tsx
git commit -m "feat(payslips): add detail panel with line items, mappings, and post action"
```

---

## Task 15: Payslips List Page

**Files:**
- Create: `src/app/(main)/payslips/page.tsx`

- [ ] **Step 1: Create the page**

```bash
mkdir -p src/app/\(main\)/payslips
```

Create `src/app/(main)/payslips/page.tsx`:

```tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import PayslipUploadZone from '@/components/payslips/PayslipUploadZone';
import PayslipDetailPanel from '@/components/payslips/PayslipDetailPanel';

interface PayslipRow {
  id: number;
  employer_name: string;
  pay_date: string;
  gross_pay: string | null;
  net_pay: string | null;
  status: string;
  created_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  processing: 'bg-blue-500/10 text-blue-400',
  needs_mapping: 'bg-yellow-500/10 text-yellow-400',
  ready: 'bg-green-500/10 text-green-400',
  posted: 'bg-primary/10 text-primary',
  error: 'bg-red-500/10 text-red-400',
};

export default function PayslipsPage() {
  const [payslips, setPayslips] = useState<PayslipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [filter, setFilter] = useState<string>('');

  const fetchPayslips = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter) params.set('status', filter);
      const res = await fetch(`/api/payslips?${params}`);
      if (res.ok) setPayslips(await res.json());
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchPayslips(); }, [fetchPayslips]);

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Payslips</h1>
        <button
          onClick={() => setShowUpload(!showUpload)}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-background hover:bg-primary-hover transition-colors"
        >
          {showUpload ? 'Hide Upload' : 'Upload Payslip'}
        </button>
      </div>

      {/* Upload zone */}
      {showUpload && (
        <div className="mb-6">
          <PayslipUploadZone onUploadComplete={() => { fetchPayslips(); setShowUpload(false); }} />
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="text-sm bg-input-bg border border-border rounded-lg px-3 py-1.5 text-foreground focus:ring-2 focus:ring-primary/40 focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="processing">Processing</option>
          <option value="needs_mapping">Needs Mapping</option>
          <option value="ready">Ready</option>
          <option value="posted">Posted</option>
          <option value="error">Error</option>
        </select>
        <span className="text-xs text-foreground-muted">
          {payslips.length} payslip{payslips.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="bg-surface/30 backdrop-blur-xl rounded-2xl border border-border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-foreground-muted text-sm">Loading...</div>
        ) : payslips.length === 0 ? (
          <div className="p-8 text-center text-foreground-muted text-sm">
            No payslips yet. Upload a payslip PDF to get started.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-foreground-muted border-b border-border">
                <th className="text-left py-3 px-4">Pay Date</th>
                <th className="text-left py-3 px-4">Employer</th>
                <th className="text-right py-3 px-4 font-mono">Gross</th>
                <th className="text-right py-3 px-4 font-mono">Net</th>
                <th className="text-left py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {payslips.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className="border-b border-border/50 hover:bg-surface-hover/50 cursor-pointer transition-colors"
                >
                  <td className="py-3 px-4 text-foreground">
                    {new Date(p.pay_date).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4 text-foreground font-medium">
                    {p.employer_name}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-foreground">
                    {p.gross_pay ? `$${Number(p.gross_pay).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-foreground">
                    {p.net_pay ? `$${Number(p.net_pay).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${STATUS_BADGE[p.status] || ''}`}>
                      {p.status.replace('_', ' ')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail panel */}
      {selectedId && (
        <PayslipDetailPanel
          payslipId={selectedId}
          onClose={() => setSelectedId(null)}
          onUpdated={fetchPayslips}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the page compiles and renders**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

Start dev server: `npm run dev`
Navigate to `http://localhost:3000/payslips` — should see the empty state with upload button.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(main\)/payslips/page.tsx
git commit -m "feat(payslips): add payslips list page with upload and detail panel"
```

---

## Task 16: End-to-End Smoke Test

**Files:** None (manual verification)

- [ ] **Step 1: Verify dev server starts cleanly**

Run: `npm run dev`
Expected: No build errors, server starts on port 3000

- [ ] **Step 2: Verify database tables created**

The tables should be created by either `prisma db push` or `db-init.ts` on startup. Check:

Run: `npx prisma db push --accept-data-loss 2>&1 | tail -10`
Expected: Schema in sync or tables created

- [ ] **Step 3: Navigate to /payslips and verify UI**

Check:
- Page loads with "Payslips" heading
- Upload button toggles upload zone
- Filter dropdown works
- Empty state message shows

- [ ] **Step 4: Upload a test PDF**

Upload any PDF file via the upload zone. Check:
- File uploads successfully
- Row appears in table with status "processing"
- If Redis is running, extraction job starts
- Click row → detail panel opens

- [ ] **Step 5: Verify sidebar navigation**

Check: "Payslips" appears in sidebar after "Receipts" and links to `/payslips`

- [ ] **Step 6: Run the test suite**

Run: `npx vitest run 2>&1 | tail -30`
Expected: All tests pass, including new payslip tests

- [ ] **Step 7: Run lint**

Run: `npm run lint 2>&1 | tail -20`
Expected: No lint errors in new files

- [ ] **Step 8: Commit any fixes**

If any issues found, fix and commit:

```bash
git add -A
git commit -m "fix(payslips): address smoke test issues"
```

---

## Self-Review Notes

**Spec coverage check:**
- PDF upload + AI extraction pipeline: Tasks 5, 7, 8
- Account mapping with reusable templates: Tasks 4, 9 (mappings route), 12
- Transaction generation with splits: Task 6
- SimpleFin deposit matching: Task 9 (match route)
- PDF storage via existing backend: Task 8
- Payslips list page: Task 15
- Payslip detail view: Task 14
- Balance validation: Task 6
- Employer contribution exclusion: Task 6

**Not implemented (deferred per spec):**
- Phase 2: QuickBooks Online API (explicitly marked as future TODO in spec)
- Payslip settings page (employer defaults, mapping management) — can be added as follow-up
- SimpleFin deposit replacement (the match endpoint finds candidates, but the actual replace/swap flow needs a follow-up task)
- Preventing future SimpleFin duplicates (requires modifying SimpleFin sync service — separate PR)

**Type consistency check:**
- `PayslipLineItem` defined in Task 1, used in Tasks 5, 6, 12, 13, 14 — consistent
- `PayslipStatus` defined in Task 1, used in Tasks 4, 9 — consistent
- `buildSplitsFromLineItems` and `validatePayslipBalance` defined in Task 6, imported in Task 13 — consistent
- `getMappingsForEmployer`, `upsertMapping` defined in Task 4, used in Tasks 7, 9 — consistent
