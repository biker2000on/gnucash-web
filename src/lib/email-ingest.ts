/**
 * Email-in document ingestion.
 *
 * Users forward a receipt/statement/payslip email to a dedicated mailbox; the
 * background worker polls it over IMAP (imapflow), and PDF/image attachments
 * from allowlisted senders are fed through the same intake core the upload
 * routes use (src/lib/services/document-intake.ts), so email-ingested
 * documents get identical thumbnails, OCR/extraction jobs, and batches.
 *
 * Configuration is env-based (INGEST_IMAP_HOST/PORT/SECURE/USER/PASS,
 * INGEST_FOLDER, INGEST_DEFAULT_BOOK) — see .env.example. Sender → user/book
 * mapping lives in the lazily-created `gnucash_web_ingest_senders` table;
 * processed Message-IDs are recorded in `gnucash_web_ingest_messages` for
 * idempotency (a restart or overlapping poll never ingests twice).
 *
 * The IMAP connection is hidden behind the small `IngestMailClient` interface
 * so unit tests never import imapflow (it is only loaded via dynamic import
 * inside `createImapIngestClient`).
 */

import { createHash } from 'node:crypto';
import prisma from '@/lib/prisma';
import { createNotification } from '@/lib/notifications';
import {
  intakeReceipt,
  intakeStatement,
  intakePayslip,
} from '@/lib/services/document-intake';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EmailIngestConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  folder: string;
  /** Fallback book for senders without an explicit book_guid. */
  defaultBookGuid: string | null;
}

/** Read INGEST_IMAP_* env vars; null unless host+user+pass are all set. */
export function getEmailIngestConfig(): EmailIngestConfig | null {
  const host = process.env.INGEST_IMAP_HOST;
  const user = process.env.INGEST_IMAP_USER;
  const pass = process.env.INGEST_IMAP_PASS;
  if (!host || !user || !pass) return null;

  const secure = (process.env.INGEST_IMAP_SECURE ?? 'true').toLowerCase() !== 'false';
  const port = parseInt(process.env.INGEST_IMAP_PORT || '', 10) || (secure ? 993 : 143);

  return {
    host,
    port,
    secure,
    user,
    pass,
    folder: process.env.INGEST_FOLDER || 'INBOX',
    defaultBookGuid: process.env.INGEST_DEFAULT_BOOK || null,
  };
}

export function isEmailIngestConfigured(): boolean {
  return getEmailIngestConfig() !== null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export type IngestKind = 'receipt' | 'statement' | 'payslip';
export type IngestDefaultKind = IngestKind | 'auto';

export const INGEST_KINDS: IngestDefaultKind[] = ['auto', 'receipt', 'statement', 'payslip'];

/**
 * Normalize an email address for allowlist comparison: lowercase, unwrap
 * "Name <addr>" forms, and strip plus-addressing tags (a+tag@b → a@b).
 */
export function normalizeSenderEmail(raw: string): string {
  let email = raw.trim().toLowerCase();
  const angled = email.match(/<([^>]*)>/);
  if (angled) email = angled[1].trim();

  const at = email.lastIndexOf('@');
  if (at === -1) return email;

  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);
  return `${local}@${domain}`;
}

/**
 * Find the allowlist entry matching a sender address. Case-insensitive and
 * plus-addressing tolerant on both sides.
 */
export function matchAllowedSender<T extends { email: string }>(
  sender: string,
  allowlist: T[],
): T | null {
  const normalized = normalizeSenderEmail(sender);
  if (!normalized) return null;
  return allowlist.find(entry => normalizeSenderEmail(entry.email) === normalized) ?? null;
}

/** Checked before statement keywords so "earnings statement" → payslip. */
const PAYSLIP_KEYWORDS = [
  'payslip',
  'pay slip',
  'paystub',
  'pay stub',
  'payroll',
  'earnings statement',
  'pay statement',
  'salary slip',
];

const STATEMENT_KEYWORDS = [
  'statement',
  'stmt',
  'account summary',
  'transaction history',
];

/**
 * Classify an attachment into a pipeline kind. A non-'auto' sender default
 * wins; otherwise filename + subject keywords decide (payslip keywords first,
 * then statement keywords), falling back to receipt.
 */
export function classifyKind(input: {
  filename: string;
  subject?: string | null;
  defaultKind?: IngestDefaultKind | null;
}): IngestKind {
  const defaultKind = input.defaultKind ?? 'auto';
  if (defaultKind !== 'auto') return defaultKind;

  const haystack = `${input.filename} ${input.subject ?? ''}`.toLowerCase();
  if (PAYSLIP_KEYWORDS.some(k => haystack.includes(k))) return 'payslip';
  if (STATEMENT_KEYWORDS.some(k => haystack.includes(k))) return 'statement';
  return 'receipt';
}

export const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024; // 15MB

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'heic']);
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/heic',
  'image/heif',
]);

/**
 * Which email attachments are worth feeding into the pipelines at all:
 * PDF/JPG/PNG/HEIC (by extension or MIME type), non-empty, ≤ 15MB.
 */
export function isAllowedAttachment(att: {
  filename?: string | null;
  mimeType?: string | null;
  size: number;
}): boolean {
  if (!Number.isFinite(att.size) || att.size <= 0 || att.size > MAX_ATTACHMENT_SIZE) {
    return false;
  }
  const name = att.filename ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  if (ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) return true;

  const mime = (att.mimeType ?? '').toLowerCase().split(';')[0].trim();
  return ALLOWED_ATTACHMENT_MIME_TYPES.has(mime);
}

/**
 * Stable dedupe key for a message: the normalized Message-ID (angle brackets
 * stripped, trimmed, lowercased) or, when absent, a hash of
 * from|subject|date|uid prefixed with `fallback:`.
 */
export function messageDedupeKey(msg: {
  messageId?: string | null;
  from?: string | null;
  subject?: string | null;
  date?: Date | string | null;
  uid?: number;
}): string {
  const raw = msg.messageId?.trim();
  if (raw) {
    return raw.replace(/^</, '').replace(/>$/, '').trim().toLowerCase();
  }
  const dateStr =
    msg.date instanceof Date ? msg.date.toISOString() : (msg.date ?? '');
  const hash = createHash('sha256')
    .update(`${msg.from ?? ''}|${msg.subject ?? ''}|${dateStr}|${msg.uid ?? ''}`)
    .digest('hex');
  return `fallback:${hash}`;
}

/**
 * Drop messages whose dedupe key has already been processed (or appears
 * earlier in the same batch).
 */
export function filterNewMessages<
  T extends { messageId?: string | null; from?: string | null; subject?: string | null; date?: Date | string | null; uid?: number },
>(messages: T[], processedKeys: Set<string>): T[] {
  const seen = new Set(processedKeys);
  const fresh: T[] = [];
  for (const msg of messages) {
    const key = messageDedupeKey(msg);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(msg);
  }
  return fresh;
}

/** Minimal shape of an imapflow BODYSTRUCTURE node (kept local so tests never import imapflow). */
export interface BodyStructureNode {
  part?: string;
  type: string;
  parameters?: { [key: string]: string };
  size?: number;
  disposition?: string;
  dispositionParameters?: { [key: string]: string };
  childNodes?: BodyStructureNode[];
}

export interface AttachmentPartRef {
  part: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Walk a BODYSTRUCTURE tree and collect downloadable leaf parts that look
 * like file attachments (explicit attachment disposition, or a filename on a
 * non-multipart part).
 */
export function collectAttachmentParts(node: BodyStructureNode): AttachmentPartRef[] {
  const found: AttachmentPartRef[] = [];

  const walk = (n: BodyStructureNode) => {
    if (n.childNodes?.length) {
      for (const child of n.childNodes) walk(child);
      return;
    }
    const type = (n.type ?? '').toLowerCase();
    if (type.startsWith('multipart/')) return;

    const filename = n.dispositionParameters?.filename ?? n.parameters?.name ?? '';
    const isAttachment = (n.disposition ?? '').toLowerCase() === 'attachment' || !!filename;
    if (!isAttachment || !n.part) return;

    found.push({
      part: n.part,
      filename,
      mimeType: type,
      size: n.size ?? 0,
    });
  };

  walk(node);
  return found;
}

// ---------------------------------------------------------------------------
// Lazy tables (advisory-lock pattern, same as webhooks.ts / notifications.ts)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureEmailIngestTables(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_email_ingest_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_ingest_senders (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
            book_guid VARCHAR(32),
            default_kind VARCHAR(20) NOT NULL DEFAULT 'auto',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_senders_email
            ON gnucash_web_ingest_senders(LOWER(email));

          CREATE TABLE IF NOT EXISTS gnucash_web_ingest_messages (
            id SERIAL PRIMARY KEY,
            message_key VARCHAR(512) NOT NULL,
            from_email VARCHAR(255),
            subject VARCHAR(500),
            outcome VARCHAR(50) NOT NULL,
            detail TEXT,
            ingested_count INTEGER NOT NULL DEFAULT 0,
            processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_messages_key
            ON gnucash_web_ingest_messages(message_key);
          CREATE INDEX IF NOT EXISTS idx_ingest_messages_processed
            ON gnucash_web_ingest_messages(processed_at DESC);
        END $$;
      `);
    })();
    ensurePromise.catch(() => { ensurePromise = null; });
  }
  return ensurePromise;
}

// ---------------------------------------------------------------------------
// Allowlist CRUD + ingest log
// ---------------------------------------------------------------------------

export interface IngestSender {
  id: number;
  email: string;
  userId: number;
  bookGuid: string | null;
  defaultKind: IngestDefaultKind;
  createdAt: Date;
}

interface SenderRow {
  id: number;
  email: string;
  user_id: number;
  book_guid: string | null;
  default_kind: string;
  created_at: Date;
}

function rowToSender(row: SenderRow): IngestSender {
  const kind = INGEST_KINDS.includes(row.default_kind as IngestDefaultKind)
    ? (row.default_kind as IngestDefaultKind)
    : 'auto';
  return {
    id: row.id,
    email: row.email,
    userId: row.user_id,
    bookGuid: row.book_guid,
    defaultKind: kind,
    createdAt: row.created_at,
  };
}

/** All allowlisted senders (the poller matches across every user/book). */
export async function listIngestSenders(): Promise<IngestSender[]> {
  await ensureEmailIngestTables();
  const rows = await prisma.$queryRaw<SenderRow[]>`
    SELECT id, email, user_id, book_guid, default_kind, created_at
    FROM gnucash_web_ingest_senders
    ORDER BY created_at DESC`;
  return rows.map(rowToSender);
}

export async function addIngestSender(input: {
  email: string;
  userId: number;
  bookGuid?: string | null;
  defaultKind?: IngestDefaultKind;
}): Promise<IngestSender> {
  await ensureEmailIngestTables();
  const email = input.email.trim();
  const defaultKind = input.defaultKind ?? 'auto';

  const existing = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM gnucash_web_ingest_senders
    WHERE LOWER(email) = LOWER(${email})
    LIMIT 1`;
  if (existing.length > 0) {
    throw new Error('This sender is already on the allowlist');
  }

  const rows = await prisma.$queryRaw<SenderRow[]>`
    INSERT INTO gnucash_web_ingest_senders (email, user_id, book_guid, default_kind)
    VALUES (${email}, ${input.userId}, ${input.bookGuid || null}, ${defaultKind})
    RETURNING id, email, user_id, book_guid, default_kind, created_at`;
  return rowToSender(rows[0]);
}

export async function deleteIngestSender(id: number, userId: number): Promise<boolean> {
  await ensureEmailIngestTables();
  const count = await prisma.$executeRaw`
    DELETE FROM gnucash_web_ingest_senders
    WHERE id = ${id} AND user_id = ${userId}`;
  return count > 0;
}

export interface IngestLogEntry {
  id: number;
  messageKey: string;
  fromEmail: string | null;
  subject: string | null;
  outcome: string;
  detail: string | null;
  ingestedCount: number;
  processedAt: Date;
}

interface MessageRow {
  id: number;
  message_key: string;
  from_email: string | null;
  subject: string | null;
  outcome: string;
  detail: string | null;
  ingested_count: number;
  processed_at: Date;
}

/** Most recent ingest-log entries (default: last 10). */
export async function listIngestLog(limit = 10): Promise<IngestLogEntry[]> {
  await ensureEmailIngestTables();
  const rows = await prisma.$queryRaw<MessageRow[]>`
    SELECT id, message_key, from_email, subject, outcome, detail, ingested_count, processed_at
    FROM gnucash_web_ingest_messages
    ORDER BY processed_at DESC, id DESC
    LIMIT ${limit}`;
  return rows.map(row => ({
    id: row.id,
    messageKey: row.message_key,
    fromEmail: row.from_email,
    subject: row.subject,
    outcome: row.outcome,
    detail: row.detail,
    ingestedCount: row.ingested_count,
    processedAt: row.processed_at,
  }));
}

/** Which of the given dedupe keys have already been processed. */
export async function getProcessedKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  await ensureEmailIngestTables();
  const rows = await prisma.$queryRaw<Array<{ message_key: string }>>`
    SELECT message_key FROM gnucash_web_ingest_messages
    WHERE message_key = ANY(${keys}::text[])`;
  return new Set(rows.map(r => r.message_key));
}

export async function recordProcessedMessage(input: {
  messageKey: string;
  fromEmail?: string | null;
  subject?: string | null;
  outcome: string;
  detail?: string | null;
  ingestedCount?: number;
}): Promise<void> {
  await ensureEmailIngestTables();
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_ingest_messages
      (message_key, from_email, subject, outcome, detail, ingested_count)
    VALUES (
      ${input.messageKey.slice(0, 512)},
      ${input.fromEmail?.slice(0, 255) ?? null},
      ${input.subject?.slice(0, 500) ?? null},
      ${input.outcome},
      ${input.detail ?? null},
      ${input.ingestedCount ?? 0}
    )
    ON CONFLICT (message_key) DO NOTHING`;
}

// ---------------------------------------------------------------------------
// IMAP client interface + imapflow implementation
// ---------------------------------------------------------------------------

export interface IngestAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface IngestEnvelope {
  uid: number;
  messageId: string | null;
  from: string | null;
  subject: string;
  date: Date | null;
}

/** Narrow mailbox surface so the poller can be tested with a fake client. */
export interface IngestMailClient {
  listUnseen(): Promise<IngestEnvelope[]>;
  fetchAttachments(uid: number): Promise<IngestAttachment[]>;
  markSeen(uid: number): Promise<void>;
  close(): Promise<void>;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Real IMAP client backed by imapflow (loaded via dynamic import so the
 * module — and therefore the test suite — never pulls it in statically).
 * imapflow decodes base64/quoted-printable transfer encodings on download.
 */
export async function createImapIngestClient(config: EmailIngestConfig): Promise<IngestMailClient> {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock(config.folder);

  return {
    async listUnseen() {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return [];

      const envelopes: IngestEnvelope[] = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        envelopes.push({
          uid: msg.uid,
          messageId: msg.envelope?.messageId ?? null,
          from: msg.envelope?.from?.[0]?.address ?? null,
          subject: msg.envelope?.subject ?? '',
          date: msg.envelope?.date ?? null,
        });
      }
      return envelopes;
    },

    async fetchAttachments(uid) {
      const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
      if (!msg || !msg.bodyStructure) return [];

      const parts = collectAttachmentParts(msg.bodyStructure as BodyStructureNode);
      const attachments: IngestAttachment[] = [];
      for (const part of parts) {
        // Pre-filter on declared size to avoid downloading oversized parts.
        if (part.size > MAX_ATTACHMENT_SIZE) continue;
        const { content } = await client.download(String(uid), part.part, { uid: true });
        if (!content) continue;
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          content: await streamToBuffer(content),
        });
      }
      return attachments;
    },

    async markSeen(uid) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    },

    async close() {
      try { lock.release(); } catch { /* already released */ }
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

export interface PollEmailIngestResult {
  configured: boolean;
  checked: number;
  ingested: number;
  skipped: number;
  errors: number;
}

async function ingestOneAttachment(
  kind: IngestKind,
  input: { bookGuid: string; userId: number; filename: string; buffer: Buffer },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (kind === 'receipt') {
    const result = await intakeReceipt({ ...input, transactionGuid: null });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (kind === 'payslip') {
    const result = await intakePayslip(input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  const result = await intakeStatement({ ...input, accountGuid: null });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * One poll pass: fetch UNSEEN messages, skip non-allowlisted senders and
 * already-processed Message-IDs, feed allowed attachments through the intake
 * core under the sender's user/book, mark each message seen, and notify the
 * owning user. Every message is processed inside its own try/catch so one bad
 * email never blocks the rest.
 *
 * `clientFactory` exists for tests; production callers omit it and get the
 * imapflow-backed client.
 */
export async function pollEmailIngest(
  clientFactory?: () => Promise<IngestMailClient>,
): Promise<PollEmailIngestResult> {
  const config = getEmailIngestConfig();
  const result: PollEmailIngestResult = {
    configured: config !== null,
    checked: 0,
    ingested: 0,
    skipped: 0,
    errors: 0,
  };
  if (!config) return result;

  await ensureEmailIngestTables();

  const client = await (clientFactory ? clientFactory() : createImapIngestClient(config));
  try {
    const envelopes = await client.listUnseen();
    if (envelopes.length === 0) return result;

    const senders = await listIngestSenders();
    const processedKeys = await getProcessedKeys(envelopes.map(e => messageDedupeKey(e)));
    const seenThisRun = new Set<string>();

    for (const envelope of envelopes) {
      result.checked++;
      const key = messageDedupeKey(envelope);

      try {
        // Idempotency: skip anything already recorded (or repeated in-batch).
        if (processedKeys.has(key) || seenThisRun.has(key)) {
          await client.markSeen(envelope.uid);
          result.skipped++;
          continue;
        }
        seenThisRun.add(key);

        const sender = envelope.from ? matchAllowedSender(envelope.from, senders) : null;
        if (!sender) {
          console.log(
            `[email-ingest] Skipping message from non-allowlisted sender ${envelope.from ?? '(unknown)'}: "${envelope.subject}"`,
          );
          await recordProcessedMessage({
            messageKey: key,
            fromEmail: envelope.from,
            subject: envelope.subject,
            outcome: 'skipped_sender',
            detail: 'Sender is not on the allowlist',
          });
          await client.markSeen(envelope.uid);
          result.skipped++;
          continue;
        }

        const bookGuid = sender.bookGuid ?? config.defaultBookGuid;
        if (!bookGuid) {
          await recordProcessedMessage({
            messageKey: key,
            fromEmail: envelope.from,
            subject: envelope.subject,
            outcome: 'error',
            detail: 'No book configured for this sender and INGEST_DEFAULT_BOOK is unset',
          });
          await client.markSeen(envelope.uid);
          result.errors++;
          continue;
        }

        const attachments = (await client.fetchAttachments(envelope.uid)).filter(att =>
          isAllowedAttachment({
            filename: att.filename,
            mimeType: att.mimeType,
            size: att.content.byteLength,
          }),
        );

        if (attachments.length === 0) {
          await recordProcessedMessage({
            messageKey: key,
            fromEmail: envelope.from,
            subject: envelope.subject,
            outcome: 'no_attachments',
            detail: 'No PDF/JPG/PNG/HEIC attachments under 15MB',
          });
          await client.markSeen(envelope.uid);
          result.skipped++;
          continue;
        }

        const ingestedItems: string[] = [];
        const failedItems: string[] = [];
        for (const att of attachments) {
          const filename = att.filename || `attachment-${envelope.uid}`;
          const kind = classifyKind({
            filename,
            subject: envelope.subject,
            defaultKind: sender.defaultKind,
          });
          const outcome = await ingestOneAttachment(kind, {
            bookGuid,
            userId: sender.userId,
            filename,
            buffer: att.content,
          });
          if (outcome.ok) {
            ingestedItems.push(`${filename} → ${kind}`);
          } else {
            failedItems.push(`${filename}: ${outcome.error}`);
          }
        }

        const detailParts: string[] = [];
        if (ingestedItems.length) detailParts.push(`Ingested: ${ingestedItems.join(', ')}`);
        if (failedItems.length) detailParts.push(`Failed: ${failedItems.join(', ')}`);

        await recordProcessedMessage({
          messageKey: key,
          fromEmail: envelope.from,
          subject: envelope.subject,
          outcome: ingestedItems.length > 0 ? 'ingested' : 'error',
          detail: detailParts.join(' · ') || null,
          ingestedCount: ingestedItems.length,
        });
        await client.markSeen(envelope.uid);
        result.ingested += ingestedItems.length;
        if (ingestedItems.length === 0) result.errors++;

        if (ingestedItems.length > 0) {
          try {
            await createNotification({
              userId: sender.userId,
              bookGuid,
              type: 'email_ingest',
              severity: failedItems.length > 0 ? 'warning' : 'success',
              title: `Email ingested: ${ingestedItems.length} document${ingestedItems.length === 1 ? '' : 's'}`,
              message: `From ${envelope.from}${envelope.subject ? ` — "${envelope.subject}"` : ''}. ${detailParts.join(' · ')}`,
              source: 'email-ingest',
              sourceId: key.slice(0, 255),
            });
          } catch (notifyErr) {
            console.warn('[email-ingest] Failed to create notification:', notifyErr);
          }
        }
      } catch (err) {
        result.errors++;
        console.error(`[email-ingest] Failed to process message ${key} (uid ${envelope.uid}):`, err);
        try {
          await recordProcessedMessage({
            messageKey: key,
            fromEmail: envelope.from,
            subject: envelope.subject,
            outcome: 'error',
            detail: err instanceof Error ? err.message : String(err),
          });
        } catch { /* best effort */ }
      }
    }

    return result;
  } finally {
    try { await client.close(); } catch { /* best effort */ }
  }
}
