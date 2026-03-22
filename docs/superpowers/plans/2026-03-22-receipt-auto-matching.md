# Receipt Auto-Matching & Full-Text Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add receipt auto-matching (inbox workflow with scoring engine), full-text search (tsvector + GIN), and pluggable AI extraction to GnuCash Web.

**Architecture:** Receipts get a structured extraction step (regex default, AI optional) that runs after OCR. A scoring engine matches extracted data against transactions by amount/date/vendor. An inbox UI shows unlinked receipts with ranked match suggestions. Full-text search replaces ILIKE with PostgreSQL tsvector + GIN index.

**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL (raw SQL + tsvector), BullMQ (existing), fastest-levenshtein (new)

**Spec:** `docs/designs/receipt-auto-matching-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/receipt-extraction.ts` | Regex extractor + AI extractor interface + `extractReceiptData()` |
| `src/lib/receipt-matching.ts` | Scoring engine: amount/date/vendor scoring + candidate query |
| `src/lib/ai-config.ts` | AI provider config CRUD + AES-256 encryption helpers |
| `src/app/api/receipts/inbox/route.ts` | GET inbox with match suggestions |
| `src/app/api/receipts/[id]/dismiss/route.ts` | POST dismiss a match candidate |
| `src/app/api/settings/ai/route.ts` | GET/PUT AI provider config |
| `src/app/api/settings/ai/test/route.ts` | POST test AI connection |
| `src/components/receipts/ReceiptInbox.tsx` | Inbox tab with match review cards |
| `src/components/receipts/TransactionPicker.tsx` | Searchable modal for manual linking |
| `src/lib/__tests__/receipt-extraction.test.ts` | Tests for extraction module |
| `src/lib/__tests__/receipt-matching.test.ts` | Tests for scoring engine |

### Modified Files

| File | Change |
|------|--------|
| `src/lib/db-init.ts` | Add `extracted_data` column, `ocr_tsvector` generated column + GIN index, `gnucash_web_ai_config` table |
| `src/lib/receipts.ts` | Add `updateExtractedData()`, migrate FTS query from ILIKE to tsvector |
| `src/lib/queue/jobs/ocr-receipt.ts` | Add extraction step after OCR |
| `worker.ts` | Increase concurrency from 1 to 3 |
| `src/components/receipts/ReceiptGallery.tsx` | Refactor dropdown to tab bar (All / Linked / Inbox) |
| `package.json` | Add `fastest-levenshtein` |
| `prisma/schema.prisma` | Add `extracted_data` field to receipt model |

---

## Task 1: Install Dependencies & Schema Changes

**Files:**
- Modify: `package.json`
- Modify: `src/lib/db-init.ts`
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Install fastest-levenshtein**

```bash
npm install fastest-levenshtein
```

- [ ] **Step 2: Add schema changes to db-init.ts**

In `createExtensionTables()`, after the existing `receiptsTableDDL` execution, add three new DDL blocks:

```typescript
const receiptsExtractedDataDDL = `
    ALTER TABLE gnucash_web_receipts
    ADD COLUMN IF NOT EXISTS extracted_data JSONB;
`;

const receiptsFtsDDL = `
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'gnucash_web_receipts'
            AND column_name = 'ocr_tsvector'
        ) THEN
            ALTER TABLE gnucash_web_receipts
            ADD COLUMN ocr_tsvector tsvector
              GENERATED ALWAYS AS (to_tsvector('english', COALESCE(ocr_text, ''))) STORED;
        END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_receipts_ocr_fts
      ON gnucash_web_receipts USING GIN (ocr_tsvector);
`;

const aiConfigTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_ai_config (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL DEFAULT 'none',
        base_url VARCHAR(500),
        api_key_encrypted TEXT,
        model VARCHAR(100),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
    );
`;
```

Add the execution calls after the existing queries in the try block:
```typescript
await query(receiptsExtractedDataDDL);
await query(receiptsFtsDDL);
await query(aiConfigTableDDL);
```

- [ ] **Step 3: Add extracted_data to Prisma model**

In `prisma/schema.prisma`, add to the `gnucash_web_receipts` model after `created_by`:

```prisma
extracted_data Json?    @db.JsonB
```

Also add a new model:

```prisma
model gnucash_web_ai_config {
  id               Int       @id @default(autoincrement())
  user_id          Int       @unique
  provider         String    @default("none") @db.VarChar(50)
  base_url         String?   @db.VarChar(500)
  api_key_encrypted String?  @db.Text
  model            String?   @db.VarChar(100)
  enabled          Boolean   @default(false)
  created_at       DateTime  @default(now())
  updated_at       DateTime  @default(now())

  @@map("gnucash_web_ai_config")
}
```

- [ ] **Step 4: Regenerate Prisma client and verify**

```bash
npx prisma generate
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/db-init.ts prisma/schema.prisma
git commit -m "feat(matching): add extracted_data column, tsvector FTS, and ai_config table"
```

---

## Task 2: Full-Text Search Migration

**Files:**
- Modify: `src/lib/receipts.ts`

- [ ] **Step 1: Update listReceipts search to use tsvector**

Replace the ILIKE search condition in `listReceipts()`:

```typescript
// Before:
if (params.search) {
  conditions.push(`r.ocr_text ILIKE $${paramIdx}`);
  values.push(`%${params.search}%`);
  paramIdx++;
}

// After:
let searchParamIdx: number | null = null;
if (params.search) {
  searchParamIdx = paramIdx;
  conditions.push(`r.ocr_tsvector @@ plainto_tsquery('english', $${paramIdx})`);
  values.push(params.search);
  paramIdx++;
}
```

Update the ORDER BY in the main query to use relevance ranking when searching:

```typescript
const orderBy = searchParamIdx
  ? `ts_rank(r.ocr_tsvector, plainto_tsquery('english', $${searchParamIdx})) DESC`
  : 'r.created_at DESC';
```

Replace `ORDER BY r.created_at DESC` in the main query with `ORDER BY ${orderBy}`.

- [ ] **Step 2: Add updateExtractedData function**

Add to `src/lib/receipts.ts`:

```typescript
export async function updateExtractedData(id: number, data: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE gnucash_web_receipts SET extracted_data = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(data), id]
  );
}

export async function dismissMatch(id: number, bookGuid: string, transactionGuid: string): Promise<boolean> {
  const result = await query(
    `UPDATE gnucash_web_receipts
     SET extracted_data = jsonb_set(
       COALESCE(extracted_data, '{}'),
       '{dismissed_guids}',
       COALESCE(extracted_data->'dismissed_guids', '[]'::jsonb) || $1::jsonb
     ),
     updated_at = NOW()
     WHERE id = $2 AND book_guid = $3
     RETURNING id`,
    [JSON.stringify(transactionGuid), id, bookGuid]
  );
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 3: Verify types compile**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/receipts.ts
git commit -m "feat(matching): migrate FTS to tsvector, add updateExtractedData and dismissMatch"
```

---

## Task 3: Receipt Extraction Module

**Files:**
- Create: `src/lib/receipt-extraction.ts`
- Create: `src/lib/__tests__/receipt-extraction.test.ts`

- [ ] **Step 1: Create the extraction module**

```typescript
// src/lib/receipt-extraction.ts

export interface ExtractedData {
  amount: number | null;
  currency: string;
  date: string | null;
  vendor: string | null;
  vendor_normalized: string | null;
  extraction_method: 'regex' | 'ai' | 'ai_fallback_regex';
  confidence: number;
}

export interface AiConfig {
  provider: string;
  base_url: string | null;
  api_key: string | null;
  model: string | null;
  enabled: boolean;
}

/** Extract structured data from OCR text. Uses AI if configured, falls back to regex. */
export async function extractReceiptData(
  ocrText: string,
  aiConfig: AiConfig | null
): Promise<ExtractedData> {
  if (aiConfig?.enabled && aiConfig.base_url && aiConfig.model) {
    try {
      return await extractWithAi(ocrText, aiConfig);
    } catch (err) {
      console.warn('AI extraction failed, falling back to regex:', err);
      const regexResult = extractWithRegex(ocrText);
      return { ...regexResult, extraction_method: 'ai_fallback_regex' };
    }
  }
  return extractWithRegex(ocrText);
}

/** Regex-based extraction (always available, no external dependencies). */
export function extractWithRegex(ocrText: string): ExtractedData {
  return {
    amount: extractAmount(ocrText),
    currency: 'USD',
    date: extractDate(ocrText),
    vendor: extractVendor(ocrText),
    vendor_normalized: normalizeVendor(extractVendor(ocrText)),
    extraction_method: 'regex',
    confidence: 0.6,
  };
}

/** Extract the total amount from receipt text. Returns the largest dollar amount. */
export function extractAmount(text: string): number | null {
  // Match patterns: $42.17, TOTAL: 42.17, TOTAL $1,234.56, etc.
  const patterns = [
    /(?:TOTAL|GRAND\s*TOTAL|AMOUNT\s*DUE|BALANCE\s*DUE|AMOUNT)\s*:?\s*\$?([\d,]+\.\d{2})/gi,
    /\$\s*([\d,]+\.\d{2})/g,
  ];

  let largest: number | null = null;

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(value) && (largest === null || value > largest)) {
        largest = value;
      }
    }
  }

  return largest;
}

/** Extract the first date from receipt text. */
export function extractDate(text: string): string | null {
  const patterns: { regex: RegExp; parse: (m: RegExpMatchArray) => string | null }[] = [
    // YYYY-MM-DD
    { regex: /(\d{4})-(\d{2})-(\d{2})/, parse: (m) => `${m[1]}-${m[2]}-${m[3]}` },
    // MM/DD/YYYY
    { regex: /(\d{1,2})\/(\d{1,2})\/(\d{4})/, parse: (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` },
    // MM/DD/YY
    { regex: /(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/, parse: (m) => `20${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` },
    // Mon DD, YYYY (e.g., Mar 15, 2026)
    {
      regex: /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i,
      parse: (m) => {
        const months: Record<string, string> = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
        const mon = months[m[1].toLowerCase().slice(0, 3)];
        return mon ? `${m[3]}-${mon}-${m[2].padStart(2, '0')}` : null;
      },
    },
  ];

  for (const { regex, parse } of patterns) {
    const match = text.match(regex);
    if (match) {
      const result = parse(match);
      if (result) return result;
    }
  }
  return null;
}

/** Extract vendor name: first non-numeric, non-date line of OCR text. */
export function extractVendor(text: string): string | null {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  for (const line of lines) {
    // Skip lines that are mostly numbers, dates, or very short
    if (/^\d+[\s./-]*\d*$/.test(line)) continue;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line)) continue;
    if (/^[\d\s$.,]+$/.test(line)) continue;
    return line;
  }
  return null;
}

/** Normalize vendor name for fuzzy matching. */
export function normalizeVendor(vendor: string | null): string | null {
  if (!vendor) return null;
  return vendor
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/** AI-based extraction via OpenAI-compatible API. */
async function extractWithAi(ocrText: string, config: AiConfig): Promise<ExtractedData> {
  const url = `${config.base_url!.replace(/\/+$/, '')}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: 'Extract structured data from this receipt text. Return ONLY valid JSON with these fields: amount (number), currency (string, e.g. "USD"), date (string, YYYY-MM-DD format), vendor (string). No explanation, just JSON.',
          },
          { role: 'user', content: ocrText },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
    });

    if (!response.ok) throw new Error(`AI API error: ${response.status}`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty AI response');

    // Parse JSON from response (may be wrapped in markdown code block)
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      amount: typeof parsed.amount === 'number' ? parsed.amount : null,
      currency: parsed.currency || 'USD',
      date: parsed.date || null,
      vendor: parsed.vendor || null,
      vendor_normalized: normalizeVendor(parsed.vendor),
      extraction_method: 'ai',
      confidence: 0.9,
    };
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 2: Create tests**

```typescript
// src/lib/__tests__/receipt-extraction.test.ts

import { describe, it, expect } from 'vitest';
import { extractAmount, extractDate, extractVendor, normalizeVendor, extractWithRegex } from '../receipt-extraction';

describe('extractAmount', () => {
  it('extracts dollar amount with $ prefix', () => {
    expect(extractAmount('Items $42.17')).toBe(42.17);
  });

  it('extracts TOTAL amount', () => {
    expect(extractAmount('Subtotal: $38.75\nTax: $3.42\nTOTAL: $42.17')).toBe(42.17);
  });

  it('extracts amount with comma separator', () => {
    expect(extractAmount('GRAND TOTAL $1,234.56')).toBe(1234.56);
  });

  it('returns largest amount (likely total)', () => {
    expect(extractAmount('Item $5.99\nItem $3.49\nTotal $9.48')).toBe(9.48);
  });

  it('returns null for no amounts', () => {
    expect(extractAmount('No amounts here')).toBeNull();
  });
});

describe('extractDate', () => {
  it('extracts MM/DD/YYYY', () => {
    expect(extractDate('Date: 03/15/2026')).toBe('2026-03-15');
  });

  it('extracts YYYY-MM-DD', () => {
    expect(extractDate('2026-03-15 Receipt')).toBe('2026-03-15');
  });

  it('extracts MM/DD/YY', () => {
    expect(extractDate('03/15/26')).toBe('2026-03-15');
  });

  it('extracts Mon DD, YYYY', () => {
    expect(extractDate('Mar 15, 2026')).toBe('2026-03-15');
  });

  it('returns null for no dates', () => {
    expect(extractDate('No date here')).toBeNull();
  });
});

describe('extractVendor', () => {
  it('returns first non-numeric line', () => {
    expect(extractVendor('COSTCO WHOLESALE #482\n123 Main St\n03/15/2026')).toBe('COSTCO WHOLESALE #482');
  });

  it('skips numeric-only lines', () => {
    expect(extractVendor('12345\nSHELL GAS STATION\n$38.50')).toBe('SHELL GAS STATION');
  });

  it('returns null for empty text', () => {
    expect(extractVendor('')).toBeNull();
  });
});

describe('normalizeVendor', () => {
  it('lowercases and strips numbers', () => {
    expect(normalizeVendor('COSTCO WHOLESALE #482')).toBe('costco wholesale');
  });

  it('collapses whitespace', () => {
    expect(normalizeVendor('  SHELL  GAS  123  ')).toBe('shell gas');
  });

  it('returns null for null input', () => {
    expect(normalizeVendor(null)).toBeNull();
  });
});

describe('extractWithRegex', () => {
  it('extracts all fields from typical receipt', () => {
    const text = 'COSTCO WHOLESALE #482\n123 Main St\n03/15/2026\nMILK 2% $4.99\nBREAD $3.49\nTOTAL $8.48';
    const result = extractWithRegex(text);
    expect(result.amount).toBe(8.48);
    expect(result.date).toBe('2026-03-15');
    expect(result.vendor).toBe('COSTCO WHOLESALE #482');
    expect(result.extraction_method).toBe('regex');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/lib/__tests__/receipt-extraction.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/receipt-extraction.ts src/lib/__tests__/receipt-extraction.test.ts
git commit -m "feat(matching): add receipt extraction module with regex and AI support"
```

---

## Task 4: Scoring Engine

**Files:**
- Create: `src/lib/receipt-matching.ts`
- Create: `src/lib/__tests__/receipt-matching.test.ts`

- [ ] **Step 1: Create the scoring engine**

```typescript
// src/lib/receipt-matching.ts

import { distance } from 'fastest-levenshtein';
import { normalizeVendor } from './receipt-extraction';

export interface MatchCandidate {
  transaction_guid: string;
  description: string;
  post_date: string;
  amount: string;
  score: number;
  score_breakdown: {
    amount: number;
    date: number;
    vendor: number;
  };
}

const AMOUNT_WEIGHT = 0.5;
const DATE_WEIGHT = 0.3;
const VENDOR_WEIGHT = 0.2;
const MIN_SCORE = 0.3;
const MAX_CANDIDATES = 5;

export function scoreAmount(receiptAmount: number, txAmount: number): number {
  const diff = Math.abs(receiptAmount - txAmount);
  if (diff <= 0.01) return 1.0;
  const pct = diff / receiptAmount;
  if (pct <= 0.01) return 0.8;
  if (pct <= 0.05) return 0.5;
  return 0.0;
}

export function scoreDate(receiptDate: string, txDate: string): number {
  const r = new Date(receiptDate);
  const t = new Date(txDate);
  const daysDiff = Math.abs(Math.round((r.getTime() - t.getTime()) / (1000 * 60 * 60 * 24)));
  if (daysDiff === 0) return 1.0;
  if (daysDiff <= 1) return 0.9;
  if (daysDiff <= 3) return 0.7;
  if (daysDiff <= 7) return 0.4;
  return 0.0;
}

export function scoreVendor(receiptVendor: string | null, txDescription: string): number {
  const normReceipt = normalizeVendor(receiptVendor);
  const normTx = normalizeVendor(txDescription);

  if (!normReceipt || !normTx) return 0.0;
  if (normReceipt === normTx) return 1.0;
  if (normTx.includes(normReceipt) || normReceipt.includes(normTx)) return 0.7;
  if (distance(normReceipt, normTx) < 3) return 0.5;
  return 0.0;
}

export function computeMatchScore(
  receiptAmount: number | null,
  receiptDate: string | null,
  receiptVendor: string | null,
  txAmount: number,
  txDate: string,
  txDescription: string
): { score: number; breakdown: { amount: number; date: number; vendor: number } } {
  const amountScore = receiptAmount != null ? scoreAmount(receiptAmount, txAmount) : 0;
  const dateScore = receiptDate ? scoreDate(receiptDate, txDate) : 0;
  const vendorScore = scoreVendor(receiptVendor, txDescription);

  const score = amountScore * AMOUNT_WEIGHT + dateScore * DATE_WEIGHT + vendorScore * VENDOR_WEIGHT;

  return {
    score,
    breakdown: { amount: amountScore, date: dateScore, vendor: vendorScore },
  };
}

/** Score and rank candidate transactions for a receipt. */
export function rankCandidates(
  receiptAmount: number | null,
  receiptDate: string | null,
  receiptVendor: string | null,
  candidates: { guid: string; description: string; post_date: string; amount: string }[],
  dismissedGuids: string[] = []
): MatchCandidate[] {
  const dismissed = new Set(dismissedGuids);

  return candidates
    .filter(c => !dismissed.has(c.guid))
    .map(c => {
      const txAmount = parseFloat(c.amount);
      const { score, breakdown } = computeMatchScore(
        receiptAmount, receiptDate, receiptVendor,
        txAmount, c.post_date, c.description
      );
      return {
        transaction_guid: c.guid,
        description: c.description,
        post_date: c.post_date,
        amount: c.amount,
        score: Math.round(score * 100) / 100,
        score_breakdown: breakdown,
      };
    })
    .filter(c => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}
```

- [ ] **Step 2: Create tests**

```typescript
// src/lib/__tests__/receipt-matching.test.ts

import { describe, it, expect } from 'vitest';
import { scoreAmount, scoreDate, scoreVendor, computeMatchScore, rankCandidates } from '../receipt-matching';

describe('scoreAmount', () => {
  it('exact match returns 1.0', () => expect(scoreAmount(42.17, 42.17)).toBe(1.0));
  it('within $0.01 returns 1.0', () => expect(scoreAmount(42.17, 42.18)).toBe(1.0));
  it('within 1% returns 0.8', () => expect(scoreAmount(100.00, 100.50)).toBe(0.8));
  it('within 5% returns 0.5', () => expect(scoreAmount(100.00, 104.00)).toBe(0.5));
  it('beyond 5% returns 0.0', () => expect(scoreAmount(100.00, 110.00)).toBe(0.0));
});

describe('scoreDate', () => {
  it('same day returns 1.0', () => expect(scoreDate('2026-03-15', '2026-03-15')).toBe(1.0));
  it('1 day off returns 0.9', () => expect(scoreDate('2026-03-15', '2026-03-16')).toBe(0.9));
  it('3 days off returns 0.7', () => expect(scoreDate('2026-03-15', '2026-03-18')).toBe(0.7));
  it('7 days off returns 0.4', () => expect(scoreDate('2026-03-15', '2026-03-22')).toBe(0.4));
  it('beyond 7 days returns 0.0', () => expect(scoreDate('2026-03-15', '2026-03-30')).toBe(0.0));
});

describe('scoreVendor', () => {
  it('exact normalized match returns 1.0', () => expect(scoreVendor('COSTCO', 'costco')).toBe(1.0));
  it('substring containment returns 0.7', () => expect(scoreVendor('COSTCO', 'COSTCO WHOLESALE #482')).toBe(0.7));
  it('levenshtein < 3 returns 0.5', () => expect(scoreVendor('SHEL', 'SHELL')).toBe(0.5));
  it('no match returns 0.0', () => expect(scoreVendor('COSTCO', 'TARGET')).toBe(0.0));
  it('null vendor returns 0.0', () => expect(scoreVendor(null, 'TARGET')).toBe(0.0));
});

describe('computeMatchScore', () => {
  it('perfect match scores > 0.9', () => {
    const { score } = computeMatchScore(42.17, '2026-03-15', 'COSTCO', 42.17, '2026-03-15', 'COSTCO');
    expect(score).toBeGreaterThan(0.9);
  });

  it('amount only match scores ~0.5', () => {
    const { score } = computeMatchScore(42.17, null, null, 42.17, '2026-03-15', 'SOMETHING');
    expect(score).toBeCloseTo(0.5, 1);
  });
});

describe('rankCandidates', () => {
  const candidates = [
    { guid: 'a', description: 'COSTCO WHSE', post_date: '2026-03-16', amount: '42.17' },
    { guid: 'b', description: 'TARGET', post_date: '2026-03-15', amount: '42.17' },
    { guid: 'c', description: 'AMAZON', post_date: '2026-03-01', amount: '99.99' },
  ];

  it('ranks by combined score, highest first', () => {
    const results = rankCandidates(42.17, '2026-03-15', 'COSTCO', candidates);
    expect(results[0].transaction_guid).toBe('a'); // costco + close date + exact amount
  });

  it('filters below threshold', () => {
    const results = rankCandidates(42.17, '2026-03-15', 'COSTCO', candidates);
    expect(results.find(r => r.transaction_guid === 'c')).toBeUndefined(); // wrong amount
  });

  it('excludes dismissed guids', () => {
    const results = rankCandidates(42.17, '2026-03-15', 'COSTCO', candidates, ['a']);
    expect(results.find(r => r.transaction_guid === 'a')).toBeUndefined();
  });

  it('returns max 5 candidates', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      guid: `g${i}`, description: 'COSTCO', post_date: '2026-03-15', amount: '42.17',
    }));
    expect(rankCandidates(42.17, '2026-03-15', 'COSTCO', many).length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/lib/__tests__/receipt-matching.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/receipt-matching.ts src/lib/__tests__/receipt-matching.test.ts
git commit -m "feat(matching): add scoring engine with amount/date/vendor matching"
```

---

## Task 5: AI Config Module

**Files:**
- Create: `src/lib/ai-config.ts`

- [ ] **Step 1: Create AI config module with AES-256 encryption**

```typescript
// src/lib/ai-config.ts

import crypto from 'crypto';
import { query } from './db';
import type { AiConfig } from './receipt-extraction';

const ALGORITHM = 'aes-256-cbc';

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET || '';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string | null {
  try {
    const [ivHex, encHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null; // Key changed or corrupted — user needs to re-enter
  }
}

/** Get AI config for a user. Checks DB first, falls back to env vars. */
export async function getAiConfig(userId: number): Promise<AiConfig | null> {
  // Check DB config first
  const result = await query(
    'SELECT * FROM gnucash_web_ai_config WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length > 0 && result.rows[0].enabled) {
    const row = result.rows[0];
    const apiKey = row.api_key_encrypted ? decrypt(row.api_key_encrypted) : null;
    return {
      provider: row.provider,
      base_url: row.base_url,
      api_key: apiKey,
      model: row.model,
      enabled: row.enabled,
    };
  }

  // Fall back to env vars
  const envKey = process.env.AI_API_KEY;
  const envBaseUrl = process.env.AI_BASE_URL;
  const envModel = process.env.AI_MODEL;

  if (envBaseUrl && envModel) {
    return {
      provider: 'custom',
      base_url: envBaseUrl,
      api_key: envKey || null,
      model: envModel,
      enabled: true,
    };
  }

  return null;
}

/** Save AI config for a user. */
export async function saveAiConfig(
  userId: number,
  config: { provider: string; base_url: string | null; api_key: string | null; model: string | null; enabled: boolean }
): Promise<void> {
  const encryptedKey = config.api_key ? encrypt(config.api_key) : null;

  await query(
    `INSERT INTO gnucash_web_ai_config (user_id, provider, base_url, api_key_encrypted, model, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       base_url = EXCLUDED.base_url,
       api_key_encrypted = EXCLUDED.api_key_encrypted,
       model = EXCLUDED.model,
       enabled = EXCLUDED.enabled,
       updated_at = NOW()`,
    [userId, config.provider, config.base_url, encryptedKey, config.model, config.enabled]
  );
}

/** Get AI config for display (redacts API key). */
export async function getAiConfigForDisplay(userId: number): Promise<{
  provider: string;
  base_url: string | null;
  has_api_key: boolean;
  api_key_valid: boolean;
  model: string | null;
  enabled: boolean;
} | null> {
  const result = await query(
    'SELECT * FROM gnucash_web_ai_config WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const hasKey = !!row.api_key_encrypted;
  const keyValid = hasKey ? decrypt(row.api_key_encrypted) !== null : true;

  return {
    provider: row.provider,
    base_url: row.base_url,
    has_api_key: hasKey,
    api_key_valid: keyValid,
    model: row.model,
    enabled: row.enabled,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/ai-config.ts
git commit -m "feat(matching): add AI config module with AES-256 encryption"
```

---

## Task 6: OCR Pipeline Integration

**Files:**
- Modify: `src/lib/queue/jobs/ocr-receipt.ts`
- Modify: `worker.ts`

- [ ] **Step 1: Add extraction step to OCR job**

At the end of `handleOcrReceipt()`, after `await updateOcrResults(...)`, add:

```typescript
// Run structured extraction on the OCR text
try {
  const { getAiConfig } = await import('@/lib/ai-config');
  const { extractReceiptData } = await import('@/lib/receipt-extraction');
  const { updateExtractedData } = await import('@/lib/receipts');

  const aiConfig = await getAiConfig(receipt.created_by);
  const extractedData = await extractReceiptData(extractedText || '', aiConfig);
  await updateExtractedData(receiptId, extractedData);
  console.log(`[Job ${job.id}] Extraction complete: ${JSON.stringify({ amount: extractedData.amount, vendor: extractedData.vendor, method: extractedData.extraction_method })}`);
} catch (extractErr) {
  console.error(`[Job ${job.id}] Extraction failed (OCR succeeded):`, extractErr);
  // Don't throw — OCR succeeded, extraction is secondary
}
```

- [ ] **Step 2: Increase worker concurrency**

In `worker.ts`, change concurrency from 1 to 3:

```typescript
// Before:
concurrency: 1,

// After:
concurrency: 3,
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/queue/jobs/ocr-receipt.ts worker.ts
git commit -m "feat(matching): integrate extraction into OCR pipeline, increase worker concurrency"
```

---

## Task 7: Inbox API & Dismiss Endpoint

**Files:**
- Create: `src/app/api/receipts/inbox/route.ts`
- Create: `src/app/api/receipts/[id]/dismiss/route.ts`

- [ ] **Step 1: Create inbox API endpoint**

```typescript
// src/app/api/receipts/inbox/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { query } from '@/lib/db';
import { rankCandidates } from '@/lib/receipt-matching';
import { getBookAccountGuids } from '@/lib/book-scope';

export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    // Fetch unlinked receipts with extracted data
    const receiptsResult = await query(
      `SELECT id, filename, thumbnail_key, extracted_data, ocr_status, created_at
       FROM gnucash_web_receipts
       WHERE book_guid = $1 AND transaction_guid IS NULL
       ORDER BY created_at DESC
       LIMIT 50`,
      [bookGuid]
    );

    const bookAccountGuids = await getBookAccountGuids();

    // For each receipt with extracted data, compute match candidates
    const receiptsWithMatches = await Promise.all(
      receiptsResult.rows.map(async (receipt: Record<string, unknown>) => {
        const extracted = receipt.extracted_data as Record<string, unknown> | null;
        if (!extracted || !extracted.amount) {
          return { ...receipt, match_candidates: [] };
        }

        const receiptDate = extracted.date as string | null;
        const receiptAmount = extracted.amount as number;

        // Determine date range for candidate query
        const dateCenter = receiptDate || (receipt.created_at as string);
        const dateWindow = receiptDate ? 7 : 30;

        // Fetch candidate transactions
        const candidatesResult = await query(
          `SELECT DISTINCT t.guid, t.description, t.post_date::text,
                  ABS(s.value_num::decimal / NULLIF(s.value_denom, 0)) as amount
           FROM transactions t
           JOIN splits s ON s.tx_guid = t.guid
           JOIN accounts a ON a.guid = s.account_guid
           WHERE t.post_date BETWEEN ($1::date - ($2 || ' days')::interval) AND ($1::date + ($2 || ' days')::interval)
             AND a.guid = ANY($3::text[])
             AND t.guid NOT IN (
               SELECT DISTINCT transaction_guid FROM gnucash_web_receipts
               WHERE transaction_guid IS NOT NULL AND book_guid = $4
               AND id != $5
             )`,
          [dateCenter, dateWindow, bookAccountGuids, bookGuid, receipt.id]
        );

        const dismissedGuids = (extracted.dismissed_guids as string[]) || [];

        const matchCandidates = rankCandidates(
          receiptAmount,
          receiptDate,
          extracted.vendor as string | null,
          candidatesResult.rows.map((r: Record<string, unknown>) => ({
            guid: r.guid as string,
            description: r.description as string,
            post_date: r.post_date as string,
            amount: String(r.amount),
          })),
          dismissedGuids
        );

        return { ...receipt, match_candidates: matchCandidates };
      })
    );

    return NextResponse.json({
      receipts: receiptsWithMatches,
      total: receiptsResult.rows.length,
    });
  } catch (error) {
    console.error('Inbox error:', error);
    return NextResponse.json({ error: 'Failed to load inbox' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create dismiss endpoint**

```typescript
// src/app/api/receipts/[id]/dismiss/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { dismissMatch } from '@/lib/receipts';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const receiptId = parseInt(id, 10);
    if (isNaN(receiptId)) {
      return NextResponse.json({ error: 'Invalid receipt ID' }, { status: 400 });
    }

    const body = await request.json();
    const { transaction_guid } = body;
    if (!transaction_guid) {
      return NextResponse.json({ error: 'transaction_guid required' }, { status: 400 });
    }

    const updated = await dismissMatch(receiptId, bookGuid, transaction_guid);
    if (!updated) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Dismiss error:', error);
    return NextResponse.json({ error: 'Failed to dismiss match' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/receipts/inbox/route.ts src/app/api/receipts/[id]/dismiss/route.ts
git commit -m "feat(matching): add inbox API and dismiss endpoint"
```

---

## Task 8: AI Settings API

**Files:**
- Create: `src/app/api/settings/ai/route.ts`
- Create: `src/app/api/settings/ai/test/route.ts`

- [ ] **Step 1: Create AI settings GET/PUT endpoint**

```typescript
// src/app/api/settings/ai/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAiConfigForDisplay, saveAiConfig } from '@/lib/ai-config';

export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user } = roleResult;

    const config = await getAiConfigForDisplay(user.id);
    return NextResponse.json(config || { provider: 'none', base_url: null, has_api_key: false, api_key_valid: true, model: null, enabled: false });
  } catch (error) {
    console.error('AI config error:', error);
    return NextResponse.json({ error: 'Failed to get AI config' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user } = roleResult;

    const body = await request.json();
    const { provider, base_url, api_key, model, enabled } = body;

    await saveAiConfig(user.id, {
      provider: provider || 'none',
      base_url: base_url || null,
      api_key: api_key || null,
      model: model || null,
      enabled: enabled ?? false,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('AI config save error:', error);
    return NextResponse.json({ error: 'Failed to save AI config' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create AI test connection endpoint**

```typescript
// src/app/api/settings/ai/test/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { extractReceiptData } from '@/lib/receipt-extraction';

export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { provider, base_url, api_key, model } = body;

    if (!base_url || !model) {
      return NextResponse.json({ error: 'base_url and model are required' }, { status: 400 });
    }

    const sampleText = 'COSTCO WHOLESALE #482\n123 Main St, Anytown USA\n03/15/2026\nKIRKLAND MILK 2% $4.99\nKS BREAD WHT $3.49\nTAX $0.68\nTOTAL $9.16';

    const result = await extractReceiptData(sampleText, {
      provider, base_url, api_key: api_key || null, model, enabled: true,
    });

    return NextResponse.json({
      success: true,
      extraction_method: result.extraction_method,
      extracted: { amount: result.amount, date: result.date, vendor: result.vendor },
    });
  } catch (error) {
    console.error('AI test error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Connection test failed',
    }, { status: 500 });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/settings/ai/
git commit -m "feat(matching): add AI settings API with connection test"
```

---

## Task 9: Inbox UI Component

**Files:**
- Create: `src/components/receipts/ReceiptInbox.tsx`
- Modify: `src/components/receipts/ReceiptGallery.tsx`

- [ ] **Step 1: Create ReceiptInbox component**

Create a card-based inbox component that shows unlinked receipts with match suggestions. Each card has: thumbnail, extracted data (amount/date/vendor), best match with score, and action buttons (Link, Not this, More, Link manually).

The component fetches from `GET /api/receipts/inbox`, handles linking via `PATCH /api/receipts/[id]`, and dismiss via `POST /api/receipts/[id]/dismiss`.

Key interactions:
- "Link" → PATCH receipt with transaction_guid, show success toast, remove from list
- "Not this" → POST dismiss, show next candidate
- "More" → expand to show all candidates
- "Link manually" → open TransactionPicker modal

- [ ] **Step 2: Refactor ReceiptGallery to tab bar**

Replace the `<select>` dropdown filter with a tab bar: **All | Linked | Inbox**

The All and Linked tabs use the existing gallery grid. The Inbox tab renders the `ReceiptInbox` component. Add a "Batch Upload" button that opens a modal with the existing `ReceiptUploadZone` (no `transaction_guid`).

- [ ] **Step 3: Verify types compile**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/components/receipts/ReceiptInbox.tsx src/components/receipts/ReceiptGallery.tsx
git commit -m "feat(matching): add inbox UI with match review cards and tab navigation"
```

---

## Task 10: Transaction Picker & AI Settings UI

**Files:**
- Create: `src/components/receipts/TransactionPicker.tsx`

- [ ] **Step 1: Create TransactionPicker modal**

A searchable modal for manually linking a receipt to a transaction. Searches via the existing `/api/transactions` endpoint with search param. Shows results in a list with description, date, amount. One-tap to link via existing PATCH endpoint.

- [ ] **Step 2: Add AI Settings section to settings page**

Add an AI Provider section to the existing settings page (check if `/settings` has a page component, or create a section). Provider dropdown, base_url, model, api_key fields. Test Connection button. Save button.

- [ ] **Step 3: Verify build**

```bash
npx tsc --noEmit
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/receipts/TransactionPicker.tsx
git commit -m "feat(matching): add transaction picker modal and AI settings UI"
```

---

## Task 11: Full Build Verification

- [ ] **Step 1: Run TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

- [ ] **Step 3: Run build**

```bash
npm run build
```

- [ ] **Step 4: Run lint**

```bash
npm run lint
```

- [ ] **Step 5: Fix any issues and commit**

```bash
git add -A
git commit -m "fix(matching): resolve build and lint issues"
```
