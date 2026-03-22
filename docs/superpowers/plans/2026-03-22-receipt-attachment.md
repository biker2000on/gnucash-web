# Receipt Attachment & Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add receipt attachment, viewing, OCR search, and gallery management to GnuCash Web transactions.

**Architecture:** Receipts are stored in a `gnucash_web_receipts` table (created via `db-init.ts` like all other extension tables) with files on the filesystem (default) or S3/MinIO. Thumbnails generated via `sharp`. OCR runs asynchronously via BullMQ (existing queue infrastructure). A `StorageBackend` interface abstracts filesystem vs S3. UI adds a paperclip indicator to transaction rows, a combined upload/view modal, and a `/receipts` gallery page.

**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL (raw SQL via `db.ts`), BullMQ/Redis (existing), sharp (new), tesseract.js (new, dev fallback), node-tesseract-ocr (new, prod), @aws-sdk/client-s3 (new, optional), pdfjs-dist (new)

**Spec:** `docs/designs/receipts-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/storage/storage-backend.ts` | `StorageBackend` interface + factory function |
| `src/lib/storage/filesystem-storage.ts` | Filesystem implementation of `StorageBackend` |
| `src/lib/storage/s3-storage.ts` | S3/MinIO implementation of `StorageBackend` |
| `src/lib/storage/thumbnail.ts` | Thumbnail generation (sharp + pdfjs-dist for PDF first page) |
| `src/lib/queue/jobs/ocr-receipt.ts` | BullMQ job handler for OCR processing |
| `src/lib/receipts.ts` | Receipt DB queries (CRUD, search, bulk counts) |
| `src/app/api/receipts/upload/route.ts` | POST upload endpoint |
| `src/app/api/receipts/[id]/route.ts` | GET serve file, DELETE receipt, PATCH link/unlink |
| `src/app/api/receipts/[id]/thumbnail/route.ts` | GET serve thumbnail |
| `src/app/api/receipts/route.ts` | GET list/search receipts with pagination |
| `src/app/api/transactions/[guid]/receipts/route.ts` | GET receipts for a specific transaction |
| `src/components/receipts/ReceiptModal.tsx` | Combined upload + view modal with tabs |
| `src/components/receipts/ReceiptUploadZone.tsx` | Drag-and-drop + camera capture upload zone |
| `src/components/receipts/ReceiptIndicator.tsx` | Paperclip icon for transaction rows |
| `src/components/receipts/ReceiptGallery.tsx` | Thumbnail grid with infinite scroll for `/receipts` page |
| `src/app/(main)/receipts/page.tsx` | `/receipts` gallery page |
| `src/lib/__tests__/receipts.test.ts` | Unit tests for receipt DB queries |
| `src/lib/__tests__/storage.test.ts` | Unit tests for storage backends |

### Modified Files

| File | Change |
|------|--------|
| `src/lib/db-init.ts` | Add `gnucash_web_receipts` table DDL + indexes |
| `prisma/schema.prisma` | Add `gnucash_web_receipts` model (type generation only) |
| `worker.ts` | Add `ocr-receipt` job handler case |
| `src/components/Layout.tsx` | Add "Receipts" nav item after "General Ledger" |
| `src/app/api/transactions/route.ts` | Add receipt_count to transaction list query via LEFT JOIN |
| `src/app/api/accounts/[guid]/transactions/route.ts` | Add receipt_count to account ledger query via LEFT JOIN |
| `src/components/TransactionJournal.tsx` | Add ReceiptIndicator column |
| `src/components/AccountLedger.tsx` | Add ReceiptIndicator column |
| `package.json` | Add sharp, tesseract.js, node-tesseract-ocr, pdfjs-dist, @aws-sdk/client-s3 |
| `Dockerfile` | Add `tesseract-ocr` and language data to Alpine image |

---

## Task 1: Database Schema & Table Creation

**Files:**
- Modify: `src/lib/db-init.ts`
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add receipts table DDL to `db-init.ts`**

Add the `gnucash_web_receipts` table DDL inside `createExtensionTables()`, after the existing table definitions and before the `try` block's execution list. Follow the exact pattern used by other tables (e.g., `gnucash_web_saved_reports`).

```typescript
const receiptsTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_receipts (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        transaction_guid VARCHAR(32),
        filename VARCHAR(255) NOT NULL,
        storage_key VARCHAR(500) NOT NULL,
        thumbnail_key VARCHAR(500),
        mime_type VARCHAR(100) NOT NULL,
        file_size INTEGER NOT NULL,
        ocr_text TEXT,
        ocr_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_transaction ON gnucash_web_receipts(transaction_guid);
    CREATE INDEX IF NOT EXISTS idx_receipts_book ON gnucash_web_receipts(book_guid);
    CREATE INDEX IF NOT EXISTS idx_receipts_created_by ON gnucash_web_receipts(created_by);
`;
```

Then add `await query(receiptsTableDDL);` in the try block after the other table executions.

- [ ] **Step 2: Add Prisma model for type generation**

Add to `prisma/schema.prisma` after the last `gnucash_web_*` model:

```prisma
model gnucash_web_receipts {
  id               Int       @id @default(autoincrement())
  book_guid        String    @db.VarChar(32)
  transaction_guid String?   @db.VarChar(32)
  filename         String    @db.VarChar(255)
  storage_key      String    @db.VarChar(500)
  thumbnail_key    String?   @db.VarChar(500)
  mime_type        String    @db.VarChar(100)
  file_size        Int
  ocr_text         String?   @db.Text
  ocr_status       String    @default("pending") @db.VarChar(20)
  created_at       DateTime  @default(now())
  updated_at       DateTime  @default(now())
  created_by       Int?

  @@index([transaction_guid])
  @@index([book_guid])
  @@index([created_by])
  @@map("gnucash_web_receipts")
}
```

- [ ] **Step 3: Regenerate Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client` with no errors

- [ ] **Step 4: Verify build still compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/db-init.ts prisma/schema.prisma
git commit -m "feat(receipts): add gnucash_web_receipts table schema"
```

---

## Task 2: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new dependencies**

```bash
npm install sharp tesseract.js pdfjs-dist @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

Note: `node-tesseract-ocr` is only needed in Docker (system binary wrapper). For development, `tesseract.js` (WASM) is the fallback. We'll install `node-tesseract-ocr` later in the Docker step.

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(receipts): add sharp, tesseract.js, pdfjs-dist, aws-sdk dependencies"
```

---

## Task 3: Storage Backend Abstraction

**Files:**
- Create: `src/lib/storage/storage-backend.ts`
- Create: `src/lib/storage/filesystem-storage.ts`
- Create: `src/lib/storage/s3-storage.ts`

- [ ] **Step 1: Create the `StorageBackend` interface and factory**

```typescript
// src/lib/storage/storage-backend.ts

export interface StorageBackend {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Returns a URL or path to serve the file. For filesystem, returns an API route path. For S3, returns a presigned URL. */
  getUrl(key: string): Promise<string>;
}

let _backend: StorageBackend | null = null;

export function getStorageBackend(): StorageBackend {
  if (_backend) return _backend;

  const type = process.env.RECEIPT_STORAGE || 'filesystem';

  if (type === 's3') {
    // Dynamic import to avoid loading aws-sdk when not needed
    const { S3Storage } = require('./s3-storage');
    _backend = new S3Storage();
  } else {
    const { FilesystemStorage } = require('./filesystem-storage');
    _backend = new FilesystemStorage();
  }

  return _backend;
}

/** Generate a storage key for a receipt: {yyyy}/{mm}/{uuid}.{ext} */
export function generateStorageKey(originalFilename: string): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const uuid = crypto.randomUUID();
  const ext = originalFilename.split('.').pop()?.toLowerCase() || 'bin';
  return `${yyyy}/${mm}/${uuid}.${ext}`;
}

/** Derive thumbnail key from a receipt storage key */
export function thumbnailKeyFrom(storageKey: string): string {
  const dotIdx = storageKey.lastIndexOf('.');
  if (dotIdx === -1) return `${storageKey}_thumb.jpg`;
  return `${storageKey.substring(0, dotIdx)}_thumb.jpg`;
}
```

- [ ] **Step 2: Create the filesystem storage implementation**

```typescript
// src/lib/storage/filesystem-storage.ts

import fs from 'fs/promises';
import path from 'path';
import { StorageBackend } from './storage-backend';

const RECEIPTS_DIR = process.env.RECEIPTS_DIR || path.join(process.cwd(), 'data', 'receipts');

export class FilesystemStorage implements StorageBackend {
  async put(key: string, buffer: Buffer, _contentType: string): Promise<void> {
    const filePath = path.join(RECEIPTS_DIR, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  }

  async get(key: string): Promise<Buffer> {
    const filePath = path.join(RECEIPTS_DIR, key);
    return fs.readFile(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(RECEIPTS_DIR, key);
    try {
      await fs.unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async getUrl(key: string): Promise<string> {
    // Filesystem proxies through the API route
    // The receipt ID will be used in the URL, not the key
    // This is a fallback — callers should use the API route directly
    return `/api/receipts/file/${encodeURIComponent(key)}`;
  }
}
```

- [ ] **Step 3: Create the S3 storage implementation**

```typescript
// src/lib/storage/s3-storage.ts

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  GetObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageBackend } from './storage-backend';

export class S3Storage implements StorageBackend {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = process.env.RECEIPT_S3_BUCKET || 'gnucash-receipts';
    this.client = new S3Client({
      endpoint: process.env.RECEIPT_S3_ENDPOINT,
      region: process.env.RECEIPT_S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.RECEIPT_S3_ACCESS_KEY || '',
        secretAccessKey: process.env.RECEIPT_S3_SECRET_KEY || '',
      },
      forcePathStyle: true, // Required for MinIO
    });
  }

  async put(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    const stream = response.Body;
    if (!stream) throw new Error(`Empty response for key: ${key}`);
    return Buffer.from(await stream.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  async getUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/
git commit -m "feat(receipts): add StorageBackend abstraction with filesystem and S3 implementations"
```

---

## Task 4: Thumbnail Generation

**Files:**
- Create: `src/lib/storage/thumbnail.ts`

- [ ] **Step 1: Create thumbnail generation module**

```typescript
// src/lib/storage/thumbnail.ts

import sharp from 'sharp';

const THUMB_WIDTH = 300;
const THUMB_HEIGHT = 300;

/**
 * Generate a JPEG thumbnail from an image buffer.
 * For PDFs, generates a styled placeholder (no native canvas dependency needed).
 */
export async function generateThumbnail(
  buffer: Buffer,
  mimeType: string
): Promise<Buffer> {
  if (mimeType === 'application/pdf') {
    return generatePdfPlaceholder();
  }
  return sharp(buffer)
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** Generate a simple placeholder thumbnail for PDFs (avoids native canvas dependency). */
async function generatePdfPlaceholder(): Promise<Buffer> {
  // Create a light gray rectangle with "PDF" text overlay via SVG
  const svg = `<svg width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f3f4f6"/>
    <text x="50%" y="50%" text-anchor="middle" dy="0.35em" font-family="sans-serif" font-size="48" fill="#9ca3af">PDF</text>
  </svg>`;
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 80 })
    .toBuffer();
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors (may need to install canvas types or adjust — if pdfjs canvas rendering is problematic, the fallback placeholder path handles it gracefully)

- [ ] **Step 3: Commit**

```bash
git add src/lib/storage/thumbnail.ts
git commit -m "feat(receipts): add thumbnail generation with sharp and PDF support"
```

---

## Task 5: Receipt Database Queries

**Files:**
- Create: `src/lib/receipts.ts`

- [ ] **Step 1: Create the receipts query module**

This module contains all raw SQL queries for receipt CRUD, search, and bulk counts. Follows the same pattern as other raw SQL in the codebase (using `query()` from `db.ts`).

```typescript
// src/lib/receipts.ts

import { query } from './db';

export interface Receipt {
  id: number;
  book_guid: string;
  transaction_guid: string | null;
  filename: string;
  storage_key: string;
  thumbnail_key: string | null;
  mime_type: string;
  file_size: number;
  ocr_text: string | null;
  ocr_status: string;
  created_at: string;
  updated_at: string;
  created_by: number;
}

export interface ReceiptWithTransaction extends Receipt {
  transaction_description?: string;
  transaction_post_date?: string;
}

/** Create a receipt record. Returns the new receipt. */
export async function createReceipt(data: {
  book_guid: string;
  transaction_guid: string | null;
  filename: string;
  storage_key: string;
  thumbnail_key: string | null;
  mime_type: string;
  file_size: number;
  created_by: number;
}): Promise<Receipt> {
  const result = await query(
    `INSERT INTO gnucash_web_receipts
      (book_guid, transaction_guid, filename, storage_key, thumbnail_key, mime_type, file_size, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [data.book_guid, data.transaction_guid, data.filename, data.storage_key, data.thumbnail_key, data.mime_type, data.file_size, data.created_by]
  );
  return result.rows[0];
}

/** Get a receipt by ID, scoped to book. */
export async function getReceiptById(id: number, bookGuid: string): Promise<Receipt | null> {
  const result = await query(
    `SELECT * FROM gnucash_web_receipts WHERE id = $1 AND book_guid = $2`,
    [id, bookGuid]
  );
  return result.rows[0] || null;
}

/** Delete a receipt by ID. Returns true if deleted. */
export async function deleteReceipt(id: number, bookGuid: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM gnucash_web_receipts WHERE id = $1 AND book_guid = $2 RETURNING id`,
    [id, bookGuid]
  );
  return result.rowCount > 0;
}

/** Update receipt's transaction link. */
export async function linkReceipt(id: number, bookGuid: string, transactionGuid: string | null): Promise<Receipt | null> {
  const result = await query(
    `UPDATE gnucash_web_receipts SET transaction_guid = $1, updated_at = NOW() WHERE id = $2 AND book_guid = $3 RETURNING *`,
    [transactionGuid, id, bookGuid]
  );
  return result.rows[0] || null;
}

/** Update OCR results. */
export async function updateOcrResults(id: number, ocrText: string | null, status: string): Promise<void> {
  await query(
    `UPDATE gnucash_web_receipts SET ocr_text = $1, ocr_status = $2, updated_at = NOW() WHERE id = $3`,
    [ocrText, status, id]
  );
}

/** Get receipts for a transaction. */
export async function getReceiptsForTransaction(transactionGuid: string, bookGuid: string): Promise<Receipt[]> {
  const result = await query(
    `SELECT * FROM gnucash_web_receipts WHERE transaction_guid = $1 AND book_guid = $2 ORDER BY created_at DESC`,
    [transactionGuid, bookGuid]
  );
  return result.rows;
}

/** List/search receipts with pagination. */
export async function listReceipts(params: {
  bookGuid: string;
  limit: number;
  offset: number;
  search?: string;
  linked?: 'linked' | 'unlinked';
  startDate?: string;
  endDate?: string;
}): Promise<{ receipts: ReceiptWithTransaction[]; total: number }> {
  const conditions: string[] = ['r.book_guid = $1'];
  const values: unknown[] = [params.bookGuid];
  let paramIdx = 2;

  if (params.search) {
    conditions.push(`r.ocr_text ILIKE $${paramIdx}`);
    values.push(`%${params.search}%`);
    paramIdx++;
  }

  if (params.linked === 'linked') {
    conditions.push('r.transaction_guid IS NOT NULL');
  } else if (params.linked === 'unlinked') {
    conditions.push('r.transaction_guid IS NULL');
  }

  if (params.startDate) {
    conditions.push(`r.created_at >= $${paramIdx}`);
    values.push(params.startDate);
    paramIdx++;
  }

  if (params.endDate) {
    conditions.push(`r.created_at <= $${paramIdx}`);
    values.push(params.endDate);
    paramIdx++;
  }

  const where = conditions.join(' AND ');

  const countResult = await query(
    `SELECT COUNT(*) as total FROM gnucash_web_receipts r WHERE ${where}`,
    values
  );

  const result = await query(
    `SELECT r.*, t.description as transaction_description, t.post_date as transaction_post_date
     FROM gnucash_web_receipts r
     LEFT JOIN transactions t ON t.guid = r.transaction_guid
     WHERE ${where}
     ORDER BY r.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, params.limit, params.offset]
  );

  return {
    receipts: result.rows,
    total: parseInt(countResult.rows[0].total, 10),
  };
}

/** Get receipt counts for multiple transactions (bulk, for ledger display). */
export async function getReceiptCountsForTransactions(
  transactionGuids: string[],
  bookGuid: string
): Promise<Record<string, number>> {
  if (transactionGuids.length === 0) return {};

  const placeholders = transactionGuids.map((_, i) => `$${i + 2}`).join(',');
  const result = await query(
    `SELECT transaction_guid, COUNT(*) as count
     FROM gnucash_web_receipts
     WHERE book_guid = $1 AND transaction_guid IN (${placeholders})
     GROUP BY transaction_guid`,
    [bookGuid, ...transactionGuids]
  );

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.transaction_guid] = parseInt(row.count, 10);
  }
  return counts;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/receipts.ts
git commit -m "feat(receipts): add receipt database query module"
```

---

## Task 6: OCR Worker Job

**Files:**
- Create: `src/lib/queue/jobs/ocr-receipt.ts`
- Modify: `worker.ts`

- [ ] **Step 1: Create the OCR job handler**

```typescript
// src/lib/queue/jobs/ocr-receipt.ts

import { Job } from 'bullmq';
import { updateOcrResults, getReceiptById } from '@/lib/receipts';
import { getStorageBackend } from '@/lib/storage/storage-backend';

/**
 * Auto-detect Tesseract: prefer system binary (fast, ~1-3s) over WASM (slow, ~10-30s).
 */
async function extractTextFromImage(buffer: Buffer): Promise<string> {
  // Try system tesseract first
  try {
    const { execSync } = await import('child_process');
    execSync('which tesseract', { stdio: 'ignore' });
    // System tesseract available
    const { recognize } = await import('node-tesseract-ocr');
    const text = await recognize(buffer, { lang: 'eng' });
    return text.trim();
  } catch {
    // Fall back to tesseract.js (WASM)
    const Tesseract = await import('tesseract.js');
    const result = await Tesseract.recognize(buffer, 'eng');
    return result.data.text.trim();
  }
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  const textParts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: { str?: string }) => item.str || '')
      .join(' ');
    textParts.push(pageText);
  }

  const directText = textParts.join('\n').trim();

  // If PDF has no text layer, OCR the first page as an image
  if (!directText) {
    // Render first page to image buffer and OCR it
    // This requires canvas — if unavailable, return empty
    try {
      const { generateThumbnail } = await import('@/lib/storage/thumbnail');
      // Reuse thumbnail logic to get an image, then OCR that
      const imageBuffer = await generateThumbnail(buffer, 'application/pdf');
      return extractTextFromImage(imageBuffer);
    } catch {
      return '';
    }
  }

  return directText;
}

export async function handleOcrReceipt(job: Job): Promise<void> {
  const { receiptId, bookGuid } = job.data as { receiptId: number; bookGuid: string };
  console.log(`[Job ${job.id}] Starting OCR for receipt ${receiptId}`);

  try {
    // Update status to processing
    await updateOcrResults(receiptId, null, 'processing');

    const receipt = await getReceiptById(receiptId, bookGuid);
    if (!receipt) {
      console.warn(`[Job ${job.id}] Receipt ${receiptId} not found, skipping OCR`);
      return;
    }

    const storage = getStorageBackend();
    const buffer = await storage.get(receipt.storage_key);

    let text: string;
    if (receipt.mime_type === 'application/pdf') {
      text = await extractTextFromPdf(buffer);
    } else {
      text = await extractTextFromImage(buffer);
    }

    await updateOcrResults(receiptId, text || null, 'complete');
    console.log(`[Job ${job.id}] OCR complete for receipt ${receiptId}: ${text.length} chars extracted`);
  } catch (err) {
    console.error(`[Job ${job.id}] OCR failed for receipt ${receiptId}:`, err);
    await updateOcrResults(receiptId, null, 'failed');
    throw err; // Let BullMQ handle retry
  }
}
```

- [ ] **Step 2: Add `ocr-receipt` case to `worker.ts`**

In `worker.ts`, inside the `switch (job.name)` block, add a new case after the existing ones:

```typescript
case 'ocr-receipt': {
  const { handleOcrReceipt } = await import('./src/lib/queue/jobs/ocr-receipt');
  await handleOcrReceipt(job);
  break;
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/queue/jobs/ocr-receipt.ts worker.ts
git commit -m "feat(receipts): add BullMQ OCR job handler with tesseract auto-detection"
```

---

## Task 7: Upload API Route

**Files:**
- Create: `src/app/api/receipts/upload/route.ts`

- [ ] **Step 1: Create the upload endpoint**

Handles multipart `FormData` upload. Validates MIME type via magic bytes, generates storage key, saves file, generates thumbnail, creates DB record, enqueues OCR job.

```typescript
// src/app/api/receipts/upload/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createReceipt } from '@/lib/receipts';
import { getStorageBackend, generateStorageKey, thumbnailKeyFrom } from '@/lib/storage/storage-backend';
import { generateThumbnail } from '@/lib/storage/thumbnail';
import { enqueueJob } from '@/lib/queue/queues';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/** Detect MIME type from magic bytes */
function detectMimeType(buffer: Buffer): string | null {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  return null;
}

/** Sanitize filename to prevent path traversal */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export async function POST(request: Request) {
  try {
    // Receipts are app-managed data (not GnuCash data), so all authenticated users can upload
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const formData = await request.formData();
    const transactionGuid = formData.get('transaction_guid') as string | null;
    const files = formData.getAll('files') as File[];

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    // If transaction_guid provided, verify transaction exists
    if (transactionGuid) {
      const { query: dbQuery } = await import('@/lib/db');
      const txResult = await dbQuery(
        'SELECT guid FROM transactions WHERE guid = $1',
        [transactionGuid]
      );
      if (txResult.rows.length === 0) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }
    }

    const storage = getStorageBackend();
    const results: { id: number; filename: string; status: string }[] = [];

    for (const file of files) {
      // Size check
      if (file.size > MAX_FILE_SIZE) {
        results.push({ id: 0, filename: file.name, status: `error: exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` });
        continue;
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      // Magic byte MIME validation
      const detectedMime = detectMimeType(buffer);
      if (!detectedMime || !ALLOWED_MIME_TYPES.includes(detectedMime)) {
        results.push({ id: 0, filename: file.name, status: 'error: unsupported file type (must be JPEG, PNG, or PDF)' });
        continue;
      }

      const sanitizedName = sanitizeFilename(file.name);
      const storageKey = generateStorageKey(sanitizedName);
      const thumbKey = thumbnailKeyFrom(storageKey);

      // Store original file
      await storage.put(storageKey, buffer, detectedMime);

      // Generate and store thumbnail
      let savedThumbKey: string | null = null;
      try {
        const thumbBuffer = await generateThumbnail(buffer, detectedMime);
        await storage.put(thumbKey, thumbBuffer, 'image/jpeg');
        savedThumbKey = thumbKey;
      } catch (err) {
        console.warn(`Thumbnail generation failed for ${sanitizedName}:`, err);
      }

      // Create DB record
      const receipt = await createReceipt({
        book_guid: bookGuid,
        transaction_guid: transactionGuid || null,
        filename: sanitizedName,
        storage_key: storageKey,
        thumbnail_key: savedThumbKey,
        mime_type: detectedMime,
        file_size: file.size,
        created_by: user.id,
      });

      // Enqueue OCR job
      const jobId = await enqueueJob('ocr-receipt', {
        receiptId: receipt.id,
        bookGuid,
      });

      if (!jobId) {
        // Redis unavailable — mark as enqueue_failed so user can retry
        const { updateOcrResults } = await import('@/lib/receipts');
        await updateOcrResults(receipt.id, null, 'enqueue_failed');
      }

      results.push({ id: receipt.id, filename: sanitizedName, status: 'uploaded' });
    }

    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    console.error('Receipt upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/receipts/upload/route.ts
git commit -m "feat(receipts): add upload API route with MIME validation and thumbnail generation"
```

---

## Task 8: Serve, Delete, and Patch API Routes

**Files:**
- Create: `src/app/api/receipts/[id]/route.ts`
- Create: `src/app/api/receipts/[id]/thumbnail/route.ts`

- [ ] **Step 1: Create the receipt serve/delete/patch endpoint**

```typescript
// src/app/api/receipts/[id]/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getReceiptById, deleteReceipt, linkReceipt } from '@/lib/receipts';
import { getStorageBackend } from '@/lib/storage/storage-backend';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const receiptId = parseInt(id, 10);
    if (isNaN(receiptId)) {
      return NextResponse.json({ error: 'Invalid receipt ID' }, { status: 400 });
    }

    const receipt = await getReceiptById(receiptId, bookGuid);
    if (!receipt) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    const storage = getStorageBackend();
    const buffer = await storage.get(receipt.storage_key);

    return new Response(buffer, {
      headers: {
        'Content-Type': receipt.mime_type,
        'Content-Disposition': `inline; filename="${receipt.filename}"`,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (error) {
    console.error('Receipt serve error:', error);
    return NextResponse.json({ error: 'Failed to serve receipt' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { id } = await params;
    const receiptId = parseInt(id, 10);
    if (isNaN(receiptId)) {
      return NextResponse.json({ error: 'Invalid receipt ID' }, { status: 400 });
    }

    const receipt = await getReceiptById(receiptId, bookGuid);
    if (!receipt) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    // Only the uploader or an admin can delete
    if (receipt.created_by !== user.id) {
      const { getUserRoleForBook } = await import('@/lib/services/permission.service');
      const userRole = await getUserRoleForBook(user.id, bookGuid);
      if (userRole !== 'admin') {
        return NextResponse.json({ error: 'Only the uploader or an admin can delete' }, { status: 403 });
      }
    }

    // Delete files first, then DB record
    const storage = getStorageBackend();
    try {
      await storage.delete(receipt.storage_key);
      if (receipt.thumbnail_key) {
        await storage.delete(receipt.thumbnail_key);
      }
    } catch (err) {
      console.warn('Failed to delete receipt files:', err);
      // Continue with DB deletion even if file deletion fails
    }

    await deleteReceipt(receiptId, bookGuid);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Receipt delete error:', error);
    return NextResponse.json({ error: 'Failed to delete receipt' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
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

    // transaction_guid can be null (unlink) or a valid GUID (link)
    if (transaction_guid !== null && transaction_guid !== undefined) {
      const { query: dbQuery } = await import('@/lib/db');
      const txResult = await dbQuery(
        'SELECT guid FROM transactions WHERE guid = $1',
        [transaction_guid]
      );
      if (txResult.rows.length === 0) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }
    }

    const updated = await linkReceipt(receiptId, bookGuid, transaction_guid ?? null);
    if (!updated) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Receipt link error:', error);
    return NextResponse.json({ error: 'Failed to update receipt' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create the thumbnail serve endpoint**

```typescript
// src/app/api/receipts/[id]/thumbnail/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getReceiptById } from '@/lib/receipts';
import { getStorageBackend } from '@/lib/storage/storage-backend';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const receiptId = parseInt(id, 10);
    if (isNaN(receiptId)) {
      return NextResponse.json({ error: 'Invalid receipt ID' }, { status: 400 });
    }

    const receipt = await getReceiptById(receiptId, bookGuid);
    if (!receipt || !receipt.thumbnail_key) {
      return NextResponse.json({ error: 'Thumbnail not found' }, { status: 404 });
    }

    const storage = getStorageBackend();
    const buffer = await storage.get(receipt.thumbnail_key);

    return new Response(buffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=604800', // 7 days
      },
    });
  } catch (error) {
    console.error('Thumbnail serve error:', error);
    return NextResponse.json({ error: 'Failed to serve thumbnail' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/receipts/
git commit -m "feat(receipts): add serve, delete, patch, and thumbnail API routes"
```

---

## Task 9: List/Search and Transaction Receipts API Routes

**Files:**
- Create: `src/app/api/receipts/route.ts`
- Create: `src/app/api/transactions/[guid]/receipts/route.ts`

- [ ] **Step 1: Create the list/search endpoint**

```typescript
// src/app/api/receipts/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listReceipts } from '@/lib/receipts';

export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const search = searchParams.get('search') || undefined;
    const linked = searchParams.get('linked') as 'linked' | 'unlinked' | undefined;
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;

    const result = await listReceipts({
      bookGuid,
      limit,
      offset,
      search,
      linked: linked === 'linked' || linked === 'unlinked' ? linked : undefined,
      startDate,
      endDate,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Receipt list error:', error);
    return NextResponse.json({ error: 'Failed to list receipts' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create the transaction receipts endpoint**

```typescript
// src/app/api/transactions/[guid]/receipts/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getReceiptsForTransaction } from '@/lib/receipts';

type RouteParams = { params: Promise<{ guid: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { guid } = await params;
    const receipts = await getReceiptsForTransaction(guid, bookGuid);

    return NextResponse.json(receipts);
  } catch (error) {
    console.error('Transaction receipts error:', error);
    return NextResponse.json({ error: 'Failed to get receipts' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/receipts/route.ts src/app/api/transactions/[guid]/receipts/route.ts
git commit -m "feat(receipts): add list/search and transaction receipts API routes"
```

---

## Task 10: Receipt Count in Transaction Queries

**Files:**
- Modify: `src/app/api/transactions/route.ts`
- Modify: `src/app/api/accounts/[guid]/transactions/route.ts`

- [ ] **Step 1: Add receipt_count to the transactions list query**

In `src/app/api/transactions/route.ts`, find the main SELECT query in the GET handler. Add a subquery to count receipts per transaction. The exact modification depends on the query structure, but the pattern is:

Add to the SELECT clause:
```sql
, (SELECT COUNT(*) FROM gnucash_web_receipts gr WHERE gr.transaction_guid = t.guid) as receipt_count
```

This avoids a JOIN that could change row counts. The subquery is correlated but efficient with the `idx_receipts_transaction` index.

- [ ] **Step 2: Add receipt_count to the account transactions query**

Same pattern in `src/app/api/accounts/[guid]/transactions/route.ts` — add the receipt_count subquery to the main SELECT.

- [ ] **Step 3: Verify types compile and queries are correct**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/transactions/route.ts src/app/api/accounts/[guid]/transactions/route.ts
git commit -m "feat(receipts): add receipt_count to transaction list and account ledger queries"
```

---

## Task 11: ReceiptUploadZone Component

**Files:**
- Create: `src/components/receipts/ReceiptUploadZone.tsx`

- [ ] **Step 1: Create the upload zone component**

Drag-and-drop zone with camera button (mobile) and file picker. Shows upload progress per file. Accepts multiple files. Uses `capture="environment"` for mobile camera.

```typescript
// src/components/receipts/ReceiptUploadZone.tsx
'use client';

import { useState, useRef, useCallback } from 'react';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

interface ReceiptUploadZoneProps {
  transactionGuid?: string | null;
  onUploadComplete: (results: { id: number; filename: string; status: string }[]) => void;
}

interface UploadProgress {
  filename: string;
  status: 'uploading' | 'success' | 'error';
  message?: string;
}

export function ReceiptUploadZone({ transactionGuid, onUploadComplete }: ReceiptUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setIsUploading(true);
    setUploads(fileArray.map(f => ({ filename: f.name, status: 'uploading' })));

    const formData = new FormData();
    if (transactionGuid) {
      formData.append('transaction_guid', transactionGuid);
    }
    for (const file of fileArray) {
      formData.append('files', file);
    }

    try {
      const response = await fetch('/api/receipts/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json();
        setUploads(fileArray.map(f => ({ filename: f.name, status: 'error', message: err.error || 'Upload failed' })));
        return;
      }

      const data = await response.json();
      setUploads(data.results.map((r: { filename: string; status: string }) => ({
        filename: r.filename,
        status: r.status === 'uploaded' ? 'success' : 'error',
        message: r.status !== 'uploaded' ? r.status : undefined,
      })));
      onUploadComplete(data.results);
    } catch {
      setUploads(fileArray.map(f => ({ filename: f.name, status: 'error', message: 'Network error' })));
    } finally {
      setIsUploading(false);
    }
  }, [transactionGuid, onUploadComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  return (
    <div className="space-y-3">
      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        aria-label="Upload receipt"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        className={`flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
          isDragging
            ? 'border-emerald-500 bg-emerald-500/10'
            : 'border-border hover:border-emerald-400 hover:bg-surface-hover'
        }`}
      >
        {/* Upload icon */}
        <svg className="w-10 h-10 text-foreground-secondary mb-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        <p className="text-sm text-foreground-secondary">
          {isMobile ? 'Tap to select files' : 'Drag & drop receipts here, or click to browse'}
        </p>
        <p className="text-xs text-foreground-secondary mt-1">JPEG, PNG, or PDF up to 10MB</p>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />

      {/* Camera button (mobile) */}
      {isMobile && (
        <>
          <button
            onClick={() => cameraInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors text-sm font-medium min-h-[44px]"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
            </svg>
            Take Photo
          </button>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </>
      )}

      {/* Upload progress */}
      {uploads.length > 0 && (
        <div className="space-y-2" aria-live="polite">
          {uploads.map((upload, i) => (
            <div key={i} className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
              upload.status === 'uploading' ? 'bg-blue-500/10 text-blue-400' :
              upload.status === 'success' ? 'bg-emerald-500/10 text-emerald-400' :
              'bg-red-500/10 text-red-400'
            }`}>
              {upload.status === 'uploading' && (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {upload.status === 'success' && '✓'}
              {upload.status === 'error' && '✕'}
              <span className="truncate">{upload.filename}</span>
              {upload.message && <span className="text-xs ml-auto">{upload.message}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/receipts/ReceiptUploadZone.tsx
git commit -m "feat(receipts): add ReceiptUploadZone component with drag-drop and camera capture"
```

---

## Task 12: ReceiptModal Component

**Files:**
- Create: `src/components/receipts/ReceiptModal.tsx`

- [ ] **Step 1: Create the combined upload/view modal**

Single modal with two tabs: View (if receipts exist) and Upload. Opens to Upload tab if no receipts exist, View tab if receipts exist. Shows receipt image/PDF in main area, multi-receipt thumbnail strip, action buttons, collapsible OCR text.

```typescript
// src/components/receipts/ReceiptModal.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { ReceiptUploadZone } from './ReceiptUploadZone';
import { useToast } from '@/contexts/ToastContext';
import type { Receipt } from '@/lib/receipts';

interface ReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  transactionGuid: string;
  transactionDescription?: string;
}

export function ReceiptModal({ isOpen, onClose, transactionGuid, transactionDescription }: ReceiptModalProps) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'view' | 'upload'>('view');
  const [loading, setLoading] = useState(true);
  const [showOcr, setShowOcr] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const toast = useToast();

  const fetchReceipts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/transactions/${transactionGuid}/receipts`);
      if (res.ok) {
        const data = await res.json();
        setReceipts(data);
        setActiveTab(data.length > 0 ? 'view' : 'upload');
        setActiveIndex(0);
      }
    } catch {
      // Silently fail — show upload tab
    } finally {
      setLoading(false);
    }
  }, [transactionGuid]);

  useEffect(() => {
    if (isOpen) fetchReceipts();
  }, [isOpen, fetchReceipts]);

  const handleDelete = async () => {
    const receipt = receipts[activeIndex];
    if (!receipt) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`/api/receipts/${receipt.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Receipt deleted');
        setShowDeleteConfirm(false);
        fetchReceipts();
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to delete');
      }
    } catch {
      toast.error('Failed to delete receipt');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleUploadComplete = () => {
    toast.success('Receipt(s) uploaded');
    fetchReceipts();
  };

  const activeReceipt = receipts[activeIndex];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={transactionDescription || 'Receipt'} size="lg">
      <div className="flex flex-col h-full">
        {/* Tab bar */}
        <div className="flex border-b border-border px-4">
          <button
            onClick={() => setActiveTab('view')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'view'
                ? 'border-emerald-500 text-emerald-500'
                : 'border-transparent text-foreground-secondary hover:text-foreground'
            }`}
          >
            View ({receipts.length})
          </button>
          <button
            onClick={() => setActiveTab('upload')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'upload'
                ? 'border-emerald-500 text-emerald-500'
                : 'border-transparent text-foreground-secondary hover:text-foreground'
            }`}
          >
            Upload
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'upload' ? (
            <ReceiptUploadZone
              transactionGuid={transactionGuid}
              onUploadComplete={handleUploadComplete}
            />
          ) : loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500" />
            </div>
          ) : receipts.length === 0 ? (
            <div className="text-center py-16 text-foreground-secondary">
              <p>No receipts attached.</p>
              <button
                onClick={() => setActiveTab('upload')}
                className="mt-2 text-emerald-500 hover:text-emerald-400 text-sm"
              >
                Upload one
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Main receipt view */}
              {activeReceipt && (
                <div className="bg-black/20 rounded-xl overflow-hidden flex items-center justify-center min-h-[300px]">
                  {activeReceipt.mime_type === 'application/pdf' ? (
                    <iframe
                      src={`/api/receipts/${activeReceipt.id}`}
                      className="w-full h-[60vh] border-0"
                      title={activeReceipt.filename}
                    />
                  ) : (
                    <img
                      src={`/api/receipts/${activeReceipt.id}`}
                      alt={activeReceipt.filename}
                      className="max-w-full max-h-[60vh] object-contain"
                    />
                  )}
                </div>
              )}

              {/* Multi-receipt thumbnail strip */}
              {receipts.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {receipts.map((r, i) => (
                    <button
                      key={r.id}
                      onClick={() => setActiveIndex(i)}
                      className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${
                        i === activeIndex ? 'border-emerald-500' : 'border-border hover:border-emerald-400'
                      }`}
                    >
                      {r.thumbnail_key ? (
                        <img
                          src={`/api/receipts/${r.id}/thumbnail`}
                          alt={r.filename}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-surface-hover flex items-center justify-center text-xs text-foreground-secondary">
                          PDF
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Action buttons */}
              {activeReceipt && (
                <div className="flex gap-2">
                  <a
                    href={`/api/receipts/${activeReceipt.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm text-foreground transition-colors min-h-[44px]"
                  >
                    Open in Tab
                  </a>
                  <a
                    href={`/api/receipts/${activeReceipt.id}`}
                    download={activeReceipt.filename}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm text-foreground transition-colors min-h-[44px]"
                  >
                    Download
                  </a>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-sm transition-colors min-h-[44px]"
                  >
                    Delete
                  </button>
                </div>
              )}

              {/* OCR text (collapsible) */}
              {activeReceipt?.ocr_text && (
                <div>
                  <button
                    onClick={() => setShowOcr(!showOcr)}
                    className="flex items-center gap-1 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                  >
                    <svg
                      className={`w-4 h-4 transition-transform ${showOcr ? 'rotate-90' : ''}`}
                      fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    OCR Text
                  </button>
                  {showOcr && (
                    <pre className="mt-2 p-3 bg-black/20 rounded-lg text-xs text-foreground-secondary whitespace-pre-wrap max-h-48 overflow-y-auto">
                      {activeReceipt.ocr_text}
                    </pre>
                  )}
                </div>
              )}

              {activeReceipt?.ocr_status === 'processing' && (
                <p className="text-xs text-foreground-secondary">OCR processing...</p>
              )}
              {activeReceipt?.ocr_status === 'failed' && (
                <p className="text-xs text-red-400">OCR failed</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmationDialog
        isOpen={showDeleteConfirm}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
        title="Delete Receipt"
        message={`Are you sure you want to delete "${activeReceipt?.filename}"? This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        isLoading={isDeleting}
      />
    </Modal>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/receipts/ReceiptModal.tsx
git commit -m "feat(receipts): add ReceiptModal with view/upload tabs, multi-receipt support"
```

---

## Task 13: ReceiptIndicator Component

**Files:**
- Create: `src/components/receipts/ReceiptIndicator.tsx`

- [ ] **Step 1: Create the paperclip indicator component**

Self-contained component that shows a paperclip icon. Green if receipts exist, gray if not. Receives `receiptCount` as prop (from bulk JOIN). Opens ReceiptModal on click.

```typescript
// src/components/receipts/ReceiptIndicator.tsx
'use client';

import { useState } from 'react';
import { ReceiptModal } from './ReceiptModal';

interface ReceiptIndicatorProps {
  transactionGuid: string;
  transactionDescription?: string;
  receiptCount: number;
}

export function ReceiptIndicator({ transactionGuid, transactionDescription, receiptCount }: ReceiptIndicatorProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className="p-1 rounded hover:bg-surface-hover transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
        aria-label={receiptCount > 0 ? `${receiptCount} receipt${receiptCount !== 1 ? 's' : ''} attached` : 'No receipts'}
        title={receiptCount > 0 ? `${receiptCount} receipt${receiptCount !== 1 ? 's' : ''}` : 'Attach receipt'}
      >
        {receiptCount > 0 ? (
          <svg className="w-4 h-4 text-emerald-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-foreground-secondary opacity-40" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <ReceiptModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        transactionGuid={transactionGuid}
        transactionDescription={transactionDescription}
      />
    </>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/receipts/ReceiptIndicator.tsx
git commit -m "feat(receipts): add ReceiptIndicator paperclip component"
```

---

## Task 14: Integrate ReceiptIndicator into Ledger Views

**Files:**
- Modify: `src/components/TransactionJournal.tsx`
- Modify: `src/components/AccountLedger.tsx`

This task requires reading both components to understand their table structure, then adding a receipt column with the ReceiptIndicator. The `receipt_count` field comes from the API changes in Task 10.

- [ ] **Step 1: Read TransactionJournal.tsx to understand table structure**

Read the file to find where table columns are defined and where each row is rendered.

- [ ] **Step 2: Add ReceiptIndicator column to TransactionJournal**

Import `ReceiptIndicator` and add it as a column in the transaction table. The transaction objects now include `receipt_count` from the API. Add the column after the description or as the last column before any action buttons.

```typescript
import { ReceiptIndicator } from '@/components/receipts/ReceiptIndicator';
```

In the table header, add:
```tsx
<th className="...">📎</th>
```

In the table row, add:
```tsx
<td className="...">
  <ReceiptIndicator
    transactionGuid={transaction.guid}
    transactionDescription={transaction.description}
    receiptCount={transaction.receipt_count || 0}
  />
</td>
```

- [ ] **Step 3: Read AccountLedger.tsx and add ReceiptIndicator column**

Same pattern as TransactionJournal. Read the file, find the table structure, add the column.

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/components/TransactionJournal.tsx src/components/AccountLedger.tsx
git commit -m "feat(receipts): integrate ReceiptIndicator into transaction journal and account ledger"
```

---

## Task 15: Receipts Gallery Page

**Files:**
- Create: `src/components/receipts/ReceiptGallery.tsx`
- Create: `src/app/(main)/receipts/page.tsx`

- [ ] **Step 1: Create the gallery component**

Thumbnail grid with infinite scroll, search bar, filters (linked/unlinked, date range). Click opens a view modal.

```typescript
// src/components/receipts/ReceiptGallery.tsx
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ReceiptModal } from './ReceiptModal';
import { useToast } from '@/contexts/ToastContext';
import type { ReceiptWithTransaction } from '@/lib/receipts';

const PAGE_SIZE = 30;

export function ReceiptGallery() {
  const [receipts, setReceipts] = useState<ReceiptWithTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [linkedFilter, setLinkedFilter] = useState<'' | 'linked' | 'unlinked'>('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptWithTransaction | null>(null);
  const observerTarget = useRef<HTMLDivElement>(null);
  const toast = useToast();

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchReceipts = useCallback(async (reset: boolean = false) => {
    const currentOffset = reset ? 0 : offset;
    setLoading(true);

    const params = new URLSearchParams({
      limit: PAGE_SIZE.toString(),
      offset: currentOffset.toString(),
    });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (linkedFilter) params.set('linked', linkedFilter);

    try {
      const res = await fetch(`/api/receipts?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();

      if (reset) {
        setReceipts(data.receipts);
      } else {
        setReceipts(prev => [...prev, ...data.receipts]);
      }
      setTotal(data.total);
      setHasMore(currentOffset + PAGE_SIZE < data.total);
      if (reset) setOffset(PAGE_SIZE);
      else setOffset(currentOffset + PAGE_SIZE);
    } catch {
      toast.error('Failed to load receipts');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, linkedFilter, offset, toast]);

  // Reset on filter change
  useEffect(() => {
    fetchReceipts(true);
  }, [debouncedSearch, linkedFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Infinite scroll
  useEffect(() => {
    if (!observerTarget.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && hasMore) {
          fetchReceipts(false);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [hasMore, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="search"
          placeholder="Search receipt text..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder-foreground-secondary focus:outline-none focus:border-emerald-500"
        />
        <select
          value={linkedFilter}
          onChange={(e) => setLinkedFilter(e.target.value as '' | 'linked' | 'unlinked')}
          className="px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-emerald-500"
        >
          <option value="">All receipts</option>
          <option value="linked">Linked to transaction</option>
          <option value="unlinked">Unlinked</option>
        </select>
      </div>

      <p className="text-sm text-foreground-secondary">{total} receipt{total !== 1 ? 's' : ''}</p>

      {/* Thumbnail Grid */}
      {receipts.length === 0 && !loading ? (
        <div className="text-center py-16 text-foreground-secondary">
          <p>No receipts yet. Attach one from any transaction.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {receipts.map((receipt) => (
            <button
              key={receipt.id}
              onClick={() => setSelectedReceipt(receipt)}
              className="group relative bg-surface-hover rounded-xl overflow-hidden aspect-square hover:ring-2 hover:ring-emerald-500 transition-all"
            >
              {receipt.thumbnail_key ? (
                <img
                  src={`/api/receipts/${receipt.id}/thumbnail`}
                  alt={receipt.filename}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-foreground-secondary">
                  <svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
              )}
              {/* Overlay with filename */}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                <p className="text-xs text-white truncate">{receipt.filename}</p>
                {receipt.transaction_description && (
                  <p className="text-xs text-white/70 truncate">{receipt.transaction_description}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Infinite scroll sentinel */}
      {hasMore && <div ref={observerTarget} className="h-8" />}

      {loading && (
        <div className="flex justify-center py-4">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-500" />
        </div>
      )}

      {/* View modal for selected receipt */}
      {selectedReceipt && selectedReceipt.transaction_guid && (
        <ReceiptModalLazy
          receiptId={selectedReceipt.id}
          transactionGuid={selectedReceipt.transaction_guid}
          transactionDescription={selectedReceipt.transaction_description}
          onClose={() => setSelectedReceipt(null)}
        />
      )}
      {selectedReceipt && !selectedReceipt.transaction_guid && (
        <UnlinkedReceiptModal
          receipt={selectedReceipt}
          onClose={() => { setSelectedReceipt(null); fetchReceipts(true); }}
        />
      )}
    </div>
  );
}

/** Wrapper for ReceiptModal for linked receipts in gallery */
function ReceiptModalLazy({ receiptId, transactionGuid, transactionDescription, onClose }: {
  receiptId: number;
  transactionGuid: string;
  transactionDescription?: string;
  onClose: () => void;
}) {
  return (
    <ReceiptModal
      isOpen={true}
      onClose={onClose}
      transactionGuid={transactionGuid}
      transactionDescription={transactionDescription}
    />
  );
}

/** Simple modal for viewing unlinked receipts */
function UnlinkedReceiptModal({ receipt, onClose }: { receipt: ReceiptWithTransaction; onClose: () => void }) {
  return (
    <Modal isOpen onClose={onClose} title={receipt.filename} size="lg">
      <div className="p-4">
        {receipt.mime_type === 'application/pdf' ? (
          <iframe
            src={`/api/receipts/${receipt.id}`}
            className="w-full h-[60vh] border-0 rounded-lg"
            title={receipt.filename}
          />
        ) : (
          <img
            src={`/api/receipts/${receipt.id}`}
            alt={receipt.filename}
            className="max-w-full max-h-[60vh] object-contain mx-auto rounded-lg"
          />
        )}
        <div className="mt-4 flex gap-2">
          <a
            href={`/api/receipts/${receipt.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 text-center px-3 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm transition-colors min-h-[44px]"
          >
            Open in Tab
          </a>
          <a
            href={`/api/receipts/${receipt.id}`}
            download={receipt.filename}
            className="flex-1 text-center px-3 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm transition-colors min-h-[44px]"
          >
            Download
          </a>
        </div>
        <p className="mt-3 text-xs text-foreground-secondary">
          This receipt is not linked to a transaction.
        </p>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Create the receipts page**

```typescript
// src/app/(main)/receipts/page.tsx

import { ReceiptGallery } from '@/components/receipts/ReceiptGallery';

export default function ReceiptsPage() {
  return (
    <div className="p-4 md:p-6">
      <h1 className="text-2xl font-semibold text-foreground mb-6">Receipts</h1>
      <ReceiptGallery />
    </div>
  );
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/components/receipts/ReceiptGallery.tsx src/app/\(main\)/receipts/page.tsx
git commit -m "feat(receipts): add receipts gallery page with search, filters, and infinite scroll"
```

---

## Task 16: Add Receipts to Sidebar Navigation

**Files:**
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Add Receipts nav item and paperclip icon**

Add a new `IconPaperclip` component in the icon section of `Layout.tsx`:

```typescript
function IconPaperclip({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
        </svg>
    );
}
```

Add `Paperclip: IconPaperclip` to the `iconMap` object.

Add the nav item to `navItems` array after "General Ledger":

```typescript
{ name: 'Receipts', href: '/receipts', icon: 'Paperclip' },
```

- [ ] **Step 2: Verify the app builds**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/Layout.tsx
git commit -m "feat(receipts): add Receipts to sidebar navigation"
```

---

## Task 17: Dockerfile Update for Tesseract

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add tesseract-ocr to the Docker image**

In the runner stage (after `FROM node:24-alpine AS runner`), add the system package installation before `RUN addgroup`:

```dockerfile
# Install tesseract-ocr for receipt OCR processing
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng
```

Also add a `data/receipts` directory for the default filesystem storage:

```dockerfile
RUN mkdir -p data/receipts
RUN chown nextjs:nodejs data/receipts
```

- [ ] **Step 2: Install node-tesseract-ocr for the production image**

Add `node-tesseract-ocr` to package.json dependencies:

```bash
npm install node-tesseract-ocr
```

- [ ] **Step 3: Verify Docker build**

Run: `docker build -t gnucash-web .`
Expected: Build succeeds without errors

- [ ] **Step 4: Commit**

```bash
git add Dockerfile package.json package-lock.json
git commit -m "feat(receipts): add tesseract-ocr to Dockerfile and node-tesseract-ocr dependency"
```

---

## Task 18: Full Build Verification

- [ ] **Step 1: Run full TypeScript check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 2: Run the Next.js build**

Run: `npm run build`
Expected: Build succeeds, all pages compile

- [ ] **Step 3: Run linter**

Run: `npm run lint`
Expected: No lint errors in new files

- [ ] **Step 4: Fix any issues found**

Address any build, type, or lint errors from the previous steps.

- [ ] **Step 5: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix(receipts): resolve build and lint issues"
```

---

## Deferred to Follow-Up

These spec features are intentionally deferred from the initial implementation to keep scope manageable:

1. **Drag-on-row** — Drag a receipt file directly onto a transaction row for quick attach (spec design review decision). Requires drag event handlers on every transaction row with visual feedback states.
2. **Hover thumbnail preview** — Show thumbnail tooltip on paperclip hover (desktop only, spec responsive behavior table). Requires a tooltip/popover component.
3. **Date range filter in gallery** — The API supports `startDate`/`endDate` params but the gallery UI only shows search and linked/unlinked filters. Add date pickers in a follow-up.
4. **Full-text search migration** — At ~1000+ receipts, migrate from `ILIKE` to PostgreSQL `tsvector` + GIN index (noted in TODOS.md as P3).
5. **Receipt auto-matching** — Upload-first workflow with fuzzy matching to transactions (Approach C from spec, noted in TODOS.md as P3).
