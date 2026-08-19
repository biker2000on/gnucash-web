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
 * idempotency (a restart or overlapping poll never ingests twice). A claim is
 * taken before any side effects and released only by finishing, so a claim
 * abandoned by a crash/redeploy becomes reclaimable after
 * INGEST_CLAIM_STALE_MINUTES rather than swallowing the message forever.
 *
 * Failure handling (see INGEST_OUTCOME_* below): a failed message is never a
 * silent tombstone. Transient failures (network blip, rate limit, storage/DB
 * hiccup) go to `error` and are retried on a later poll, bounded by
 * INGEST_MAX_ATTEMPTS with exponential backoff; permanent failures (malformed
 * attachment, unsupported type, missing book config) — and transient ones that
 * exhaust the budget — go to the terminal `failed_permanent` state, which
 * keeps the reason in `detail` and raises an `error` notification for the
 * owning user.
 *
 * MANUAL RETRY, and the ownership snapshot it rests on. A terminal failure can
 * be re-armed once its cause is fixed (`requestIngestRetry` → the
 * `retry_requested` state → the next poll re-fetches the message by Message-ID
 * and reprocesses it). The hazard that once made this unsafe was attribution:
 * routing is decided by the MUTABLE sender allowlist, so a retry that
 * re-matched the allowlist could file a message into a different user's book
 * than the one it was originally routed to. It no longer re-matches. Every row
 * carries an IMMUTABLE OWNER SNAPSHOT — `owner_user_id`, `owner_book_guid`,
 * `owner_sender_id`, `owner_sender_email` — written by the FIRST claim from the
 * allowlist match of that moment and never rewritten afterwards (the claim
 * upsert COALESCEs, so a later attempt cannot overwrite it). Retry authorizes
 * against that snapshot and reprocesses under it, so editing or deleting an
 * allowlist entry can never re-attribute an already-ingested message.
 *
 * Two classes of row are therefore NOT retriable, and both say so rather than
 * failing silently: a row whose snapshot is NULL (recorded before the columns
 * existed and whose routing sender could not be proven at migration time), and
 * a message with NO Message-ID header — recorded under a `fallback:` hash key
 * derived from from/subject/date/uid, which cannot be re-identified in the
 * mailbox. Manual retries are bounded (INGEST_MAX_MANUAL_RETRIES) and
 * rate-limited (INGEST_MANUAL_RETRY_COOLDOWN_MINUTES); `attempts` is never
 * reset, so each one buys exactly one further attempt.
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

export type IngestKind = 'receipt' | 'statement' | 'payslip' | 'bill';
export type IngestDefaultKind = IngestKind | 'auto';

export const INGEST_KINDS: IngestDefaultKind[] = ['auto', 'receipt', 'statement', 'payslip', 'bill'];

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
 * Subject prefix that routes a message to the bill-capture pipeline
 * ("bill", "Bill: Electric June", "bill - Acme"). Prefix only — a receipt
 * subject merely mentioning "billing" elsewhere doesn't count.
 */
export function subjectRequestsBill(subject: string | null | undefined): boolean {
  return /^\s*bill\b/i.test(subject ?? '');
}

/**
 * Classify an attachment into a pipeline kind. A non-'auto' sender default
 * wins; then a "bill" subject prefix; otherwise filename + subject keywords
 * decide (payslip keywords first, then statement keywords), falling back to
 * receipt.
 */
export function classifyKind(input: {
  filename: string;
  subject?: string | null;
  defaultKind?: IngestDefaultKind | null;
}): IngestKind {
  const defaultKind = input.defaultKind ?? 'auto';
  if (defaultKind !== 'auto') return defaultKind;

  if (subjectRequestsBill(input.subject)) return 'bill';

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

// ---------------------------------------------------------------------------
// Failure classification (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Outcome vocabulary stored in `gnucash_web_ingest_messages.outcome`
 * (VARCHAR(50) — no schema change was needed to add the failure states).
 *
 *   processing        in-flight claim
 *   ingested          at least one attachment landed — terminal, never retried
 *   skipped_sender    sender not allowlisted — terminal
 *   no_attachments    nothing ingestible attached — terminal
 *   error             TRANSIENT failure, an automatic retry is pending
 *   failed_permanent  terminal failure; reason kept in `detail`, user notified,
 *                     manually re-armable by the snapshotted owner
 *   retry_requested   the owner re-armed a terminal failure; the next poll
 *                     re-finds the message by Message-ID and claims it
 */
export const INGEST_OUTCOME_PROCESSING = 'processing';
export const INGEST_OUTCOME_INGESTED = 'ingested';
/** Transient failure awaiting an automatic, bounded retry. */
export const INGEST_OUTCOME_RETRYING = 'error';
/** Terminal failure — inspectable in the ingest log and manually re-triable. */
export const INGEST_OUTCOME_FAILED = 'failed_permanent';
/** The snapshotted owner asked for one more attempt on a terminal failure. */
export const INGEST_OUTCOME_RETRY_REQUESTED = 'retry_requested';

export type IngestFailureKind = 'transient' | 'permanent';

/**
 * Substrings that mark a failure as PERMANENT: retrying cannot change the
 * answer because the input itself is wrong (bad bytes, wrong type, too big) or
 * the configuration is missing. Checked before the transient patterns so
 * "unsupported file type" doesn't get rescued by a stray "connection" word.
 */
const PERMANENT_FAILURE_PATTERNS = [
  'unsupported file type',
  'unsupported media',
  'invalid file',
  'invalid image',
  'invalid pdf',
  'not a pdf',
  'malformed',
  'corrupt',
  'damaged',
  'unreadable',
  'password protected',
  'password-protected',
  'encrypted',
  'exceeds',
  'too large',
  'empty file',
  'no book configured',
];

/**
 * Substrings that mark a failure as TRANSIENT: the same bytes may well succeed
 * on the next poll. Network/TLS faults, rate limits, upstream 5xx, storage and
 * database hiccups.
 */
const TRANSIENT_FAILURE_PATTERNS = [
  'econnreset',
  'econnrefused',
  'econnaborted',
  'etimedout',
  'esockettimedout',
  'enotfound',
  'eai_again',
  'ehostunreach',
  'enetunreach',
  'epipe',
  'socket hang up',
  'network',
  'timeout',
  'timed out',
  'rate limit',
  'ratelimit',
  'too many requests',
  'service unavailable',
  'temporarily unavailable',
  'try again',
  'connection terminated',
  'connection closed',
  'connection lost',
  'deadlock',
  'could not serialize',
  'failed to save receipt record',
  'storage backend',
];

/**
 * Node/libuv and Postgres error codes that are unambiguously retryable.
 * Checked before any substring matching — a typed code from the upstream API
 * beats guessing from prose, and prose matching is what misfires on messages
 * that merely happen to contain "503" or "storage".
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
  'EBUSY', 'EAGAIN',
  // Postgres: serialization failure, deadlock detected, too many connections,
  // cannot connect now, admin shutdown.
  '40001', '40P01', '53300', '57P03', '57P01',
]);

/** HTTP statuses worth another attempt, when the upstream reports one. */
function isTransientHttpStatus(status: unknown): boolean {
  return typeof status === 'number' && (status === 429 || (status >= 500 && status <= 599));
}

/** Pull a typed error code / HTTP status off an unknown thrown value. */
function errorCodeOf(err: unknown): { code?: string; status?: unknown } {
  if (!err || typeof err !== 'object') return {};
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown };
  return {
    code: typeof e.code === 'string' ? e.code.toUpperCase() : undefined,
    status: e.status ?? e.statusCode,
  };
}

/**
 * Flatten an error (or an intake `{ ok: false, error }` string) to a message,
 * keeping any typed code/status so the reason persisted in the ingest log
 * still identifies the fault after the object itself is gone.
 */
export function describeIngestError(err: unknown): string {
  if (typeof err === 'string') return err;

  const { code, status } = errorCodeOf(err);
  const base = err instanceof Error
    ? err.message
    : (() => {
        // A non-Error object stringifies to "[object Object]", which would
        // throw the reason away — prefer any message-ish field it carries.
        if (err && typeof err === 'object') {
          const m = (err as { message?: unknown }).message;
          if (typeof m === 'string' && m) return m;
          try { return JSON.stringify(err).slice(0, 500); } catch { /* circular */ }
        }
        try { return String(err); } catch { return 'Unknown error'; }
      })();

  const prefix = [code, isTransientHttpStatus(status) || typeof status === 'number' ? `HTTP ${status}` : null]
    .filter((p): p is string => !!p && !base.includes(p))
    .join(' ');
  return prefix ? `${prefix}: ${base}` : base;
}

/**
 * Decide whether a failure is worth retrying.
 *
 * Permanent patterns win over transient ones. Anything unrecognized defaults to
 * TRANSIENT: this module exists to stop inbound money from being silently
 * dropped, and a bounded handful of retries is far cheaper than a false
 * "permanent" verdict on a real receipt. The retry budget
 * (INGEST_MAX_ATTEMPTS) is what keeps that default safe — an unclassifiable
 * failure still lands in `failed_permanent` once the budget is spent.
 */
export function classifyIngestFailure(err: unknown): IngestFailureKind {
  // Typed signals first — they are unambiguous where prose is not.
  const { code, status } = errorCodeOf(err);
  if ((code && TRANSIENT_ERROR_CODES.has(code)) || isTransientHttpStatus(status)) {
    return 'transient';
  }

  const message = describeIngestError(err).toLowerCase();
  if (PERMANENT_FAILURE_PATTERNS.some(p => message.includes(p))) return 'permanent';
  if (TRANSIENT_FAILURE_PATTERNS.some(p => message.includes(p))) return 'transient';
  return 'transient';
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
        DECLARE
          owner_columns_existed BOOLEAN;
          backfilled INTEGER := 0;
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
            attempts INTEGER NOT NULL DEFAULT 0,
            processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          -- Added after the table shipped; idempotent for existing installs.
          ALTER TABLE gnucash_web_ingest_messages
            ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

          CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_messages_key
            ON gnucash_web_ingest_messages(message_key);
          CREATE INDEX IF NOT EXISTS idx_ingest_messages_processed
            ON gnucash_web_ingest_messages(processed_at DESC);

          -- Has this install already been through the owner-snapshot upgrade?
          -- Captured BEFORE the ALTER below so the one-shot legacy sweep that
          -- follows it can tell a first upgrade from every later run.
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'gnucash_web_ingest_messages'
              AND column_name = 'owner_user_id'
          ) INTO owner_columns_existed;

          -- IMMUTABLE OWNER SNAPSHOT. Routing is decided by the mutable sender
          -- allowlist, so a message's user/book must be frozen onto its own row
          -- at first ingest; otherwise a manual retry after an allowlist edit
          -- could file the message into a different user's book. Written once
          -- by claimIngestMessage and never updated (see the COALESCE there).
          -- owner_sender_id/email record WHICH allowlist rule matched, for
          -- audit and to recover the default kind; they are not authority.
          ALTER TABLE gnucash_web_ingest_messages
            ADD COLUMN IF NOT EXISTS owner_user_id INTEGER
              REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS owner_book_guid VARCHAR(32),
            ADD COLUMN IF NOT EXISTS owner_sender_id INTEGER,
            ADD COLUMN IF NOT EXISTS owner_sender_email VARCHAR(255),
            ADD COLUMN IF NOT EXISTS manual_retries INTEGER NOT NULL DEFAULT 0,
            -- When the owner last re-armed this row BY HAND. The cooldown is a
            -- rate limit on the human, so it has to be measured against the
            -- human's last action; processed_at moves on every automatic
            -- attempt and every poll outcome, so measuring against it charged
            -- the user a cooldown for work they did not do. NULL means never
            -- manually retried, and imposes no cooldown at all.
            ADD COLUMN IF NOT EXISTS last_manual_retry_at TIMESTAMPTZ;

          CREATE INDEX IF NOT EXISTS idx_ingest_messages_owner
            ON gnucash_web_ingest_messages(owner_user_id);

          -- Backfill for rows that predate the columns. Attribution is only
          -- written where it can be PROVEN: exactly one allowlist entry
          -- normalizes to the row's sender AND that entry already existed when
          -- the message was processed, so it is necessarily the rule that
          -- routed it. Ambiguous or later-created rules prove nothing and are
          -- left NULL — an unattributed row is reported as non-retriable rather
          -- than guessed into somebody's book.
          WITH candidate AS (
            SELECT m.id AS message_id, MIN(s.id) AS sender_id, COUNT(*) AS matches
            FROM gnucash_web_ingest_messages m
            JOIN gnucash_web_ingest_senders s
              ON regexp_replace(lower(s.email), '\\+[^@]*@', '@')
               = regexp_replace(lower(m.from_email), '\\+[^@]*@', '@')
             AND s.created_at <= m.processed_at
            WHERE m.owner_user_id IS NULL
              AND m.from_email IS NOT NULL
            GROUP BY m.id
          )
          UPDATE gnucash_web_ingest_messages m
          SET owner_user_id = s.user_id,
              owner_book_guid = s.book_guid,
              owner_sender_id = s.id,
              owner_sender_email = s.email
          FROM candidate c
          JOIN gnucash_web_ingest_senders s ON s.id = c.sender_id
          WHERE m.id = c.message_id AND c.matches = 1;
          GET DIAGNOSTICS backfilled = ROW_COUNT;
          IF backfilled > 0 THEN
            RAISE NOTICE '[email-ingest] Backfilled an owner snapshot onto % ingest message row(s)', backfilled;
          END IF;

          -- One-shot legacy sweep. An intermediate build removed manual retry
          -- and left any 'retry_requested' row as an invisible tombstone; such
          -- a row also predates the owner snapshot, so it cannot be re-armed
          -- safely even now. Convert it to the terminal state ONCE, on the
          -- upgrade that introduces the columns. Guarded on
          -- owner_columns_existed so it can never touch a row that the current
          -- code legitimately re-armed.
          IF NOT owner_columns_existed THEN
            UPDATE gnucash_web_ingest_messages
            SET outcome = 'failed_permanent',
                detail = COALESCE(NULLIF(detail, ''), 'Manual retry was requested')
                         || ' — re-arm it again now that manual retry is supported'
            WHERE outcome = 'retry_requested';
          END IF;
        END $$;
      `);

      // Report what the backfill could NOT prove. These rows are readable and
      // countable like any other, but they can never be manually retried —
      // saying so once at startup beats a user discovering it from a refusal.
      try {
        const [counts] = await prisma.$queryRaw<Array<{ unattributed: number; total: number }>>`
          SELECT COUNT(*) FILTER (WHERE owner_user_id IS NULL)::int AS unattributed,
                 COUNT(*)::int AS total
          FROM gnucash_web_ingest_messages`;
        if (counts && counts.unattributed > 0) {
          console.warn(
            `[email-ingest] ${counts.unattributed} of ${counts.total} ingest message row(s) have no ` +
            'owner snapshot (their routing sender could not be proven) — those messages are not manually retriable',
          );
        }
      } catch (err) {
        // Diagnostics only; never let a count failure break schema setup.
        console.warn('[email-ingest] Could not count unattributed ingest rows:', err);
      }
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

/**
 * Who a message was routed to, frozen at first ingest.
 *
 * This is the ONLY authority for retry: it is written once from the allowlist
 * match that actually routed the mail and never rewritten, so it survives any
 * later edit or deletion of that allowlist entry. `senderId`/`senderEmail`
 * record which rule matched — useful for audit and for recovering the sender's
 * default kind — but they are not consulted for authorization.
 */
export interface IngestOwnerSnapshot {
  userId: number;
  bookGuid: string | null;
  senderId: number | null;
  senderEmail: string | null;
}

export interface IngestLogEntry {
  id: number;
  messageKey: string;
  fromEmail: string | null;
  subject: string | null;
  outcome: string;
  detail: string | null;
  ingestedCount: number;
  attempts: number;
  /** Immutable routing snapshot; null on rows recorded before it existed. */
  owner: IngestOwnerSnapshot | null;
  manualRetries: number;
  /** True when `requestIngestRetry` would accept this row (cooldown aside). */
  retriable: boolean;
  /** Why not, when `retriable` is false and the row is a terminal failure. */
  retryBlockedReason: string | null;
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
  attempts: number;
  owner_user_id: number | null;
  owner_book_guid: string | null;
  owner_sender_id: number | null;
  owner_sender_email: string | null;
  manual_retries: number | null;
  last_manual_retry_at: Date | null;
  processed_at: Date;
}

export function ownerSnapshotOf(row: {
  owner_user_id: number | null;
  owner_book_guid: string | null;
  owner_sender_id: number | null;
  owner_sender_email: string | null;
}): IngestOwnerSnapshot | null {
  if (row.owner_user_id === null || row.owner_user_id === undefined) return null;
  return {
    userId: row.owner_user_id,
    bookGuid: row.owner_book_guid ?? null,
    senderId: row.owner_sender_id ?? null,
    senderEmail: row.owner_sender_email ?? null,
  };
}

/**
 * Why a terminal failure cannot be re-armed, or null when it can.
 *
 * Mirrors `requestIngestRetry`'s own preconditions (the time-based cooldown
 * aside, which only the server can judge), so the UI never offers a control
 * the server will refuse — and can say why when it doesn't.
 */
export function retryBlockedReason(row: {
  outcome: string;
  message_key: string;
  owner_user_id: number | null;
  manual_retries: number | null;
}): string | null {
  if (row.outcome === INGEST_OUTCOME_RETRY_REQUESTED) {
    return 'Already re-armed — waiting for the next mailbox poll';
  }
  if (row.outcome !== INGEST_OUTCOME_FAILED) {
    return 'Only a terminally failed message can be retried';
  }
  if (row.owner_user_id === null || row.owner_user_id === undefined) {
    return 'No owner was recorded for this message, so it cannot be re-routed safely — forward the email again';
  }
  if (row.message_key.startsWith('fallback:')) {
    return 'This email had no Message-ID header, so it cannot be found in the mailbox again — forward it again';
  }
  if ((row.manual_retries ?? 0) >= INGEST_MAX_MANUAL_RETRIES) {
    return 'This message has used all of its manual retries';
  }
  return null;
}

function rowToLogEntry(row: MessageRow): IngestLogEntry {
  const attempts = row.attempts ?? 0;
  const blocked = retryBlockedReason(row);
  return {
    id: row.id,
    messageKey: row.message_key,
    fromEmail: row.from_email,
    subject: row.subject,
    outcome: row.outcome,
    detail: row.detail,
    ingestedCount: row.ingested_count,
    attempts,
    owner: ownerSnapshotOf(row),
    manualRetries: row.manual_retries ?? 0,
    retriable: blocked === null,
    retryBlockedReason: row.outcome === INGEST_OUTCOME_FAILED ? blocked : null,
    processedAt: row.processed_at,
  };
}

/** Most recent ingest-log entries (default: last 10). */
export async function listIngestLog(limit = 10): Promise<IngestLogEntry[]> {
  await ensureEmailIngestTables();
  const rows = await prisma.$queryRaw<MessageRow[]>`
    SELECT id, message_key, from_email, subject, outcome, detail, ingested_count,
           attempts, owner_user_id, owner_book_guid, owner_sender_id,
           owner_sender_email, manual_retries, processed_at
    FROM gnucash_web_ingest_messages
    ORDER BY processed_at DESC, id DESC
    LIMIT ${limit}`;
  return rows.map(rowToLogEntry);
}

/**
 * How long an in-flight `outcome = 'processing'` claim is honored. A worker
 * that crashes / OOMs / is redeployed between claiming and finalizing leaves
 * the row stuck in 'processing' forever (nothing ever deletes a claim), and
 * the message was never marked seen — so after this window any poll may steal
 * the claim and retry, instead of silently skipping the message for good.
 */
export const INGEST_CLAIM_STALE_MINUTES = 15;

/**
 * How many times a message may be claimed before a transient `error` outcome is
 * promoted to the terminal `failed_permanent` state. This is the hard bound on
 * the automatic retry loop: every reclaim increments `attempts`, so at most
 * INGEST_MAX_ATTEMPTS attempts can ever run for a given message key
 * automatically. Only a deliberate act by the message's SNAPSHOTTED owner
 * (`requestIngestRetry`) can add more, and that is separately bounded by
 * INGEST_MAX_MANUAL_RETRIES.
 */
export const INGEST_MAX_ATTEMPTS = 3;

/**
 * How many owner-initiated retries a message may receive on top of the
 * automatic budget. Each buys exactly ONE more attempt — `attempts` is never
 * reset — and `manual_retries` is its own counter, so the lifetime ceiling is
 * INGEST_MAX_ATTEMPTS + INGEST_MAX_MANUAL_RETRIES claims regardless of how
 * many of the automatic attempts a permanent failure actually consumed.
 */
export const INGEST_MAX_MANUAL_RETRIES = 2;

/** Minimum wait between manual retries of the same message. */
export const INGEST_MANUAL_RETRY_COOLDOWN_MINUTES = 10;

/**
 * Base of the exponential backoff between automatic retries, in minutes.
 *
 * The claim predicate refuses to re-claim an `error` row until
 * `retryBackoffMinutes(attempts)` have elapsed since its last attempt. Together
 * with INGEST_MAX_ATTEMPTS this makes a spin impossible: each reclaim both
 * increments `attempts` (bounded) and stamps `processed_at = NOW()` (so the
 * next reclaim is gated behind a strictly positive, growing wait). Nothing here
 * re-polls on its own — retries only happen on the poller's existing cadence.
 */
export const INGEST_RETRY_BACKOFF_MINUTES = 5;

/** Minutes to wait before the (attempts + 1)-th try. Mirrors the SQL below. */
export function retryBackoffMinutes(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts) - 1);
  return INGEST_RETRY_BACKOFF_MINUTES * Math.pow(2, n);
}

export interface IngestMessageState {
  outcome: string;
  attempts: number;
  /**
   * True for a `processing` row whose worker never came back AND whose retry
   * budget is spent. Nothing will ever claim it again, so the poller must stop
   * being handed it — but its row is a READ-ONLY record surfaced by
   * `listIngestAttention`, so the poller settles the mailbox flag only.
   */
  stalled: boolean;
}

/**
 * Current state of the given dedupe keys, for the poller's skip decisions.
 *
 * A key is absent when it has never been seen, or when it is still live work.
 * A key is PRESENT when nothing further will ever happen to it automatically —
 * either it finished (success, skip, terminal failure) or it is a stalled
 * claim. Both cases mean the same thing to the poller: settle the mailbox flag
 * and move on.
 *
 * An in-flight 'processing' claim is arbitrated by `claimIngestMessage`, which
 * returns null while the claim is live and steals it once it is older than
 * INGEST_CLAIM_STALE_MINUTES. An 'error' row with attempts left, and a
 * `processing` row that is still fresh or still has budget, are reclaimable
 * rather than finished and are deliberately absent from this map — marking a
 * live claim seen would take the message out of the poller's reach.
 */
export async function getIngestMessageStates(
  keys: string[],
): Promise<Map<string, IngestMessageState>> {
  if (keys.length === 0) return new Map();
  await ensureEmailIngestTables();
  const rows = await prisma.$queryRaw<
    Array<{ message_key: string; outcome: string; attempts: number; stalled: boolean }>
  >`
    SELECT message_key, outcome, attempts,
           (outcome = 'processing') AS stalled
    FROM gnucash_web_ingest_messages
    WHERE message_key = ANY(${keys}::text[])
      AND (
        (
          outcome <> 'processing'
          -- A re-armed row is live work, not a finished one: the poller must
          -- still be handed it so claimIngestMessage can pick it up.
          AND outcome <> ${INGEST_OUTCOME_RETRY_REQUESTED}
          AND NOT (
            outcome = 'error'
            AND attempts < ${INGEST_MAX_ATTEMPTS}
          )
        ) OR (
          -- Exhausted, abandoned claim: no longer claimable, so the poller
          -- should stop being offered it. Reported, never rewritten.
          outcome = 'processing'
          AND attempts >= ${INGEST_MAX_ATTEMPTS}
          AND processed_at
              < (NOW() - ${INGEST_CLAIM_STALE_MINUTES} * INTERVAL '1 minute')::timestamp
        )
      )`;
  return new Map(rows.map(r => [
    r.message_key,
    { outcome: r.outcome, attempts: r.attempts ?? 0, stalled: r.stalled === true },
  ]));
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
    ON CONFLICT (message_key) DO UPDATE SET
      from_email = EXCLUDED.from_email,
      subject = EXCLUDED.subject,
      outcome = EXCLUDED.outcome,
      detail = EXCLUDED.detail,
      ingested_count = EXCLUDED.ingested_count,
      processed_at = CURRENT_TIMESTAMP`;
}

/**
 * Atomically claim a message before any attachment side effects occur.
 *
 * Returns the attempt number this claim represents (1 for a first claim) plus
 * the row's IMMUTABLE OWNER SNAPSHOT, or null when the caller did not win. A
 * fresh (live) claim, a finished row, an `error` row still inside its backoff
 * window, and a `processing` row whose budget is spent all yield no RETURNING
 * row, so the caller skips the message.
 *
 * OWNERSHIP is written here and only here. On the INSERT it comes from the
 * allowlist match the poller just made; on every DO UPDATE it is COALESCEd
 * against the stored value, so the FIRST claim's attribution wins forever and
 * a later allowlist edit cannot re-route an existing message. The caller must
 * route by the RETURNED snapshot, never by its own match.
 *
 * Concurrency: `ON CONFLICT ... DO UPDATE` takes a row lock on the conflicting
 * row, so two concurrent inserts of the same key serialize. The loser
 * re-evaluates the WHERE against the *updated* row — whose processed_at the
 * winner just bumped to now — so the stale/error predicate no longer holds and
 * the loser updates nothing and returns no row. Exactly one claimant wins, for
 * both a brand-new key and a stolen stale one.
 *
 * Termination: the only three reclaim paths are (a) a stale in-flight claim,
 * gated on INGEST_CLAIM_STALE_MINUTES of wall time AND
 * `attempts < INGEST_MAX_ATTEMPTS`, (b) a transient `error`, gated on BOTH
 * `attempts < INGEST_MAX_ATTEMPTS` and an exponentially growing backoff, and
 * (c) an explicit `retry_requested`, which only the snapshotted owner can set,
 * at most INGEST_MAX_MANUAL_RETRIES times, behind a cooldown. All three stamp
 * `processed_at = NOW()` and increment `attempts`, so none can be taken twice
 * without time passing and all are bounded. This cannot become a hot loop, and
 * a crash-loop cannot replay a message forever.
 */
export interface IngestClaim {
  attempt: number;
  /** The row's frozen routing decision — route by THIS, not by the allowlist. */
  owner: IngestOwnerSnapshot | null;
  /** True when this claim came from an owner-requested manual retry. */
  manual: boolean;
}

export async function claimIngestMessage(input: {
  messageKey: string;
  fromEmail?: string | null;
  subject?: string | null;
  /** Allowlist match for a FIRST ingest; ignored once a snapshot exists. */
  owner?: IngestOwnerSnapshot | null;
}): Promise<IngestClaim | null> {
  await ensureEmailIngestTables();
  const claimed = await prisma.$queryRaw<
    Array<{
      message_key: string;
      attempts: number;
      owner_user_id: number | null;
      owner_book_guid: string | null;
      owner_sender_id: number | null;
      owner_sender_email: string | null;
      was_manual: boolean;
    }>
  >`
    INSERT INTO gnucash_web_ingest_messages
      (message_key, from_email, subject, outcome, detail, ingested_count, attempts,
       owner_user_id, owner_book_guid, owner_sender_id, owner_sender_email)
    VALUES (
      ${input.messageKey.slice(0, 512)},
      ${input.fromEmail?.slice(0, 255) ?? null},
      ${input.subject?.slice(0, 500) ?? null},
      'processing',
      'Claimed for ingestion',
      0,
      1,
      ${input.owner?.userId ?? null},
      ${input.owner?.bookGuid ?? null},
      ${input.owner?.senderId ?? null},
      ${input.owner?.senderEmail?.slice(0, 255) ?? null}
    )
    ON CONFLICT (message_key) DO UPDATE SET
      from_email = EXCLUDED.from_email,
      subject = EXCLUDED.subject,
      outcome = 'processing',
      detail = CASE
        WHEN gnucash_web_ingest_messages.outcome = ${INGEST_OUTCOME_RETRY_REQUESTED}
          THEN 'Reclaimed for an owner-requested retry'
        ELSE 'Reclaimed after stale or failed attempt'
      END,
      ingested_count = 0,
      attempts = gnucash_web_ingest_messages.attempts + 1,
      -- WRITE-ONCE. COALESCE keeps the first claim's attribution no matter what
      -- the allowlist says now, which is the whole reason a retry is safe.
      owner_user_id = COALESCE(gnucash_web_ingest_messages.owner_user_id, EXCLUDED.owner_user_id),
      owner_book_guid = CASE
        WHEN gnucash_web_ingest_messages.owner_user_id IS NULL THEN EXCLUDED.owner_book_guid
        ELSE gnucash_web_ingest_messages.owner_book_guid
      END,
      owner_sender_id = CASE
        WHEN gnucash_web_ingest_messages.owner_user_id IS NULL THEN EXCLUDED.owner_sender_id
        ELSE gnucash_web_ingest_messages.owner_sender_id
      END,
      owner_sender_email = CASE
        WHEN gnucash_web_ingest_messages.owner_user_id IS NULL THEN EXCLUDED.owner_sender_email
        ELSE gnucash_web_ingest_messages.owner_sender_email
      END,
      processed_at = CURRENT_TIMESTAMP
    WHERE (
      gnucash_web_ingest_messages.outcome = 'processing'
      AND gnucash_web_ingest_messages.attempts < ${INGEST_MAX_ATTEMPTS}
      AND gnucash_web_ingest_messages.processed_at
          < (NOW() - ${INGEST_CLAIM_STALE_MINUTES} * INTERVAL '1 minute')::timestamp
    ) OR (
      gnucash_web_ingest_messages.outcome = 'error'
      AND gnucash_web_ingest_messages.attempts < ${INGEST_MAX_ATTEMPTS}
      AND gnucash_web_ingest_messages.processed_at
          < (NOW() - (${INGEST_RETRY_BACKOFF_MINUTES}
                      * POWER(2, GREATEST(gnucash_web_ingest_messages.attempts - 1, 0)))
                   * INTERVAL '1 minute')::timestamp
    ) OR (
      gnucash_web_ingest_messages.outcome = ${INGEST_OUTCOME_RETRY_REQUESTED}
    )
    RETURNING message_key, attempts, owner_user_id, owner_book_guid,
              owner_sender_id, owner_sender_email,
              (detail = 'Reclaimed for an owner-requested retry') AS was_manual`;
  if (claimed.length !== 1) return null;
  const row = claimed[0];
  return {
    attempt: row.attempts ?? 1,
    owner: ownerSnapshotOf(row),
    manual: row.was_manual === true,
  };
}

/**
 * Message keys the owner re-armed, which the poller must explicitly re-fetch.
 *
 * A terminal failure is flagged seen in the mailbox (leaving it unread would
 * re-list it on every poll forever), so a re-armed message is no longer in the
 * UNSEEN set and has to be located by Message-ID. Only Message-ID keys are
 * returned — a `fallback:` key means the message had no Message-ID and could
 * never be re-found, which is why `requestIngestRetry` refuses those outright.
 */
export async function listRetryRequestedKeys(limit = 50): Promise<string[]> {
  await ensureEmailIngestTables();
  const rows = await prisma.$queryRaw<Array<{ message_key: string }>>`
    SELECT message_key FROM gnucash_web_ingest_messages
    WHERE outcome = ${INGEST_OUTCOME_RETRY_REQUESTED}
      AND message_key NOT LIKE 'fallback:%'
    ORDER BY processed_at ASC
    LIMIT ${limit}`;
  return rows.map(r => r.message_key);
}

export type IngestRetryResult =
  /** Re-armed; the next poll will re-fetch and reprocess the message. */
  | { ok: true }
  /** Missing, or not visible to the caller. Callers MUST answer 404 for both. */
  | { ok: false; reason: 'not_found' }
  /** Visible to the caller, but not in a re-armable state. `detail` says why. */
  | { ok: false; reason: 'not_retriable'; detail: string }
  /** Too soon since the last manual retry. */
  | { ok: false; reason: 'cooldown'; retryAfterMinutes: number };

export interface RequestIngestRetryOptions {
  /**
   * Optional escalation: lets a book ADMIN re-arm a message owned by another
   * user in a book they administer. Called with the row's SNAPSHOTTED book
   * guid, never with a guid derived from the current allowlist.
   */
  canAdministerBook?: (bookGuid: string) => Promise<boolean>;
}

/**
 * Re-arm a terminally failed message so the next poll re-fetches and
 * reprocesses it.
 *
 * AUTHORIZATION comes from the row's own IMMUTABLE SNAPSHOT (`owner_user_id`),
 * not from the sender allowlist. That is the entire point: the allowlist is
 * mutable, so deriving ownership from it at retry time could hand a message to
 * whoever happens to own that sender address now. A row whose snapshot is NULL
 * — recorded before the columns existed, and whose routing sender the backfill
 * could not prove — is NEVER retriable, no matter who asks.
 *
 * VISIBILITY vs. AUTHORIZATION. A row the caller cannot see at all is reported
 * as `not_found` rather than as a permission error: answering "forbidden"
 * would confirm the row exists and turn this into an oracle for other users'
 * inbound mail. A row the caller CAN already see in their attention list (same
 * allowlist derivation `listIngestAttention` uses) but cannot re-arm gets the
 * real reason, because that leaks nothing they were not already shown.
 *
 * BOUNDS. `attempts` is never reset — a manual retry grants exactly one
 * further attempt — `manual_retries` is capped at INGEST_MAX_MANUAL_RETRIES,
 * and INGEST_MANUAL_RETRY_COOLDOWN_MINUTES rate-limits repeats. The final
 * UPDATE re-checks outcome, cap, and cooldown in its WHERE, so two concurrent
 * requests cannot both succeed.
 */
export async function requestIngestRetry(
  id: number,
  requesterUserId: number,
  options: RequestIngestRetryOptions = {},
): Promise<IngestRetryResult> {
  await ensureEmailIngestTables();

  const rows = await prisma.$queryRaw<MessageRow[]>`
    SELECT id, message_key, from_email, subject, outcome, detail, ingested_count,
           attempts, owner_user_id, owner_book_guid, owner_sender_id,
           owner_sender_email, manual_retries, last_manual_retry_at, processed_at
    FROM gnucash_web_ingest_messages
    WHERE id = ${id}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  const owner = ownerSnapshotOf(row);
  let authorized = owner?.userId === requesterUserId;
  if (!authorized && owner?.bookGuid && options.canAdministerBook) {
    authorized = await options.canAdministerBook(owner.bookGuid);
  }

  if (!authorized) {
    // Not the owner. The row may still be one the caller can SEE — the
    // attention list scopes by the allowlist — in which case an honest refusal
    // is safe. Otherwise it must look exactly like a missing row.
    const senders = await listIngestSenders();
    const visibleTo = row.from_email ? matchAllowedSender(row.from_email, senders) : null;
    if (!visibleTo || visibleTo.userId !== requesterUserId) {
      return { ok: false, reason: 'not_found' };
    }
    const blocked = retryBlockedReason(row);
    return {
      ok: false,
      reason: 'not_retriable',
      detail: blocked
        ?? 'This message belongs to another user; only its owner or a book admin can retry it',
    };
  }

  const blocked = retryBlockedReason(row);
  if (blocked) return { ok: false, reason: 'not_retriable', detail: blocked };

  // The cooldown rate-limits the PERSON, so it runs from their last manual
  // retry — not from `processed_at`, which is the time of the last automatic
  // attempt or poll outcome and moves on its own. Measuring against that made
  // a fresh failure look like a cooldown the user had just used up. A row that
  // has never been re-armed by hand has no cooldown to serve.
  const lastManual = row.last_manual_retry_at;
  if (lastManual) {
    const elapsedMinutes = (Date.now() - lastManual.getTime()) / 60_000;
    if (elapsedMinutes < INGEST_MANUAL_RETRY_COOLDOWN_MINUTES) {
      return {
        ok: false,
        reason: 'cooldown',
        retryAfterMinutes: Math.max(
          1,
          Math.ceil(INGEST_MANUAL_RETRY_COOLDOWN_MINUTES - elapsedMinutes),
        ),
      };
    }
  }

  // Atomic re-check under the row lock: outcome, owner, cap, and cooldown are
  // all re-evaluated, so a concurrent duplicate request updates nothing.
  const updated = await prisma.$executeRaw`
    UPDATE gnucash_web_ingest_messages
    SET outcome = ${INGEST_OUTCOME_RETRY_REQUESTED},
        detail = 'Manual retry requested; queued for the next mailbox poll',
        manual_retries = manual_retries + 1,
        last_manual_retry_at = NOW(),
        processed_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
      AND outcome = ${INGEST_OUTCOME_FAILED}
      AND owner_user_id IS NOT NULL
      AND message_key NOT LIKE 'fallback:%'
      AND manual_retries < ${INGEST_MAX_MANUAL_RETRIES}
      AND (last_manual_retry_at IS NULL
           OR last_manual_retry_at
              < NOW() - ${INGEST_MANUAL_RETRY_COOLDOWN_MINUTES} * INTERVAL '1 minute')`;
  if (updated === 0) return { ok: false, reason: 'cooldown', retryAfterMinutes: 1 };
  return { ok: true };
}

/**
 * A message needing an operator's attention, and why.
 *
 *   failed   terminal `failed_permanent` — no document was created, ever
 *   stalled  a claim whose worker never came back AND whose retry budget is
 *            spent, so nothing will pick it up again
 *   requeued the owner re-armed it; the next poll re-fetches and reprocesses
 *            it under the SNAPSHOTTED owner/book
 */
export type IngestAttentionCategory = 'failed' | 'stalled' | 'requeued';

export interface IngestAttentionEntry extends IngestLogEntry {
  category: IngestAttentionCategory;
}

export interface IngestAttentionList {
  items: IngestAttentionEntry[];
  /** TOTAL matching rows, not the truncated count — see the note below. */
  failedTotal: number;
  stalledTotal: number;
  /** Re-armed by their owner, waiting for the next poll. */
  requeuedTotal: number;
  /** True when `items` was truncated by `limit`. */
  truncated: boolean;
}

/**
 * Messages needing attention, scoped to one requester, newest first.
 *
 * STALLED rows are REPORTED, never rewritten. A `processing` row past the
 * stale window with its budget spent is not proof its worker died — a slow
 * intake looks identical — and rewriting the row would race that worker's own
 * final write, so a slow-but-healthy ingest could be recorded as failed.
 * `claimIngestMessage` already refuses to reclaim such a row, so the only real
 * problem was that it sat invisible. Surfacing it fixes that with no write at
 * all. (The poller does flag the message seen, but that is an IMAP flag only:
 * it neither deletes the message nor stops a live worker, which addresses it
 * by UID.)
 *
 * SCOPING prefers the row's IMMUTABLE OWNER SNAPSHOT: a message stays with the
 * user it was routed to even after the allowlist entry that routed it is
 * edited or deleted. Rows recorded before the snapshot existed (and whose
 * routing sender the backfill could not prove) have none, so for those — and
 * only those — scoping falls back to the allowlist derivation the poller uses,
 * mirroring `normalizeSenderEmail`: lowercase, plus-tag stripped. Such rows are
 * visible but not retriable, and say so.
 *
 * COUNTS are computed with a window function BEFORE the LIMIT, so a caller
 * always learns the true size of the backlog even when the list is truncated.
 * Silently capping outstanding action items is the same class of bug as the
 * silent failure this module exists to fix.
 */
export async function listIngestAttention(
  requesterUserId: number,
  limit = 50,
): Promise<IngestAttentionList> {
  await ensureEmailIngestTables();

  const senders = await listIngestSenders();
  const owned = [...new Set(
    senders
      .filter(sender => sender.userId === requesterUserId)
      .map(sender => normalizeSenderEmail(sender.email))
      .filter(Boolean),
  )];

  const rows = await prisma.$queryRaw<
    Array<MessageRow & { category: string; failed_total: number; stalled_total: number; requeued_total: number }>
  >`
    WITH scoped AS (
      SELECT id, message_key, from_email, subject, outcome, detail, ingested_count,
             attempts, owner_user_id, owner_book_guid, owner_sender_id,
             owner_sender_email, manual_retries, processed_at,
             CASE
               WHEN outcome = ${INGEST_OUTCOME_FAILED} THEN 'failed'
               WHEN outcome = ${INGEST_OUTCOME_RETRY_REQUESTED} THEN 'requeued'
               ELSE 'stalled'
             END AS category
      FROM gnucash_web_ingest_messages
      WHERE (
          owner_user_id = ${requesterUserId}
          OR (
            owner_user_id IS NULL
            AND from_email IS NOT NULL
            AND regexp_replace(lower(from_email), ${'\\+[^@]*@'}, '@') = ANY(${owned}::text[])
          )
        )
        AND (
          outcome = ${INGEST_OUTCOME_FAILED}
          -- A re-armed message stays listed until the poll settles it, so the
          -- item does not silently vanish the moment Retry is pressed.
          OR outcome = ${INGEST_OUTCOME_RETRY_REQUESTED}
          OR (
            outcome = 'processing'
            AND attempts >= ${INGEST_MAX_ATTEMPTS}
            AND processed_at
                < (NOW() - ${INGEST_CLAIM_STALE_MINUTES} * INTERVAL '1 minute')::timestamp
          )
        )
    )
    SELECT *,
           COUNT(*) FILTER (WHERE category = 'failed') OVER ()::int   AS failed_total,
           COUNT(*) FILTER (WHERE category = 'stalled') OVER ()::int  AS stalled_total,
           COUNT(*) FILTER (WHERE category = 'requeued') OVER ()::int AS requeued_total
    FROM scoped
    ORDER BY processed_at DESC, id DESC
    LIMIT ${limit}`;

  // Both counts are unpartitioned windows over the WHOLE `scoped` set, so they
  // are correct even when the LIMIT returns rows from only one category. A
  // PARTITION BY category window would have reported zero for any category the
  // truncated page happened to exclude — understating the backlog, which is the
  // same silent-undercount bug this module exists to prevent.
  const failedTotal = rows[0]?.failed_total ?? 0;
  const stalledTotal = rows[0]?.stalled_total ?? 0;
  const requeuedTotal = rows[0]?.requeued_total ?? 0;

  return {
    items: rows.map(row => {
      const category: IngestAttentionCategory =
        row.category === 'stalled' ? 'stalled'
          : row.category === 'requeued' ? 'requeued'
            : 'failed';
      return {
        ...rowToLogEntry(row),
        category,
        detail: category === 'stalled'
          ? (row.detail
              ? `${row.detail} — processing never completed and the retry budget is spent`
              : 'Processing never completed and the retry budget is spent')
          : row.detail,
      };
    }),
    failedTotal,
    stalledTotal,
    requeuedTotal,
    truncated: failedTotal + stalledTotal + requeuedTotal > rows.length,
  };
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
  /**
   * Re-find already-seen messages by Message-ID, for owner-requested retries.
   *
   * Terminal failures are flagged seen like everything else — leaving them
   * unread would make every poll re-list them forever — so a re-armed message
   * has to be located explicitly. Message-ID is used rather than a stored UID
   * because a UID is only meaningful alongside the folder's UIDVALIDITY, which
   * the server may invalidate at any time.
   */
  findByMessageIds(messageIds: string[]): Promise<IngestEnvelope[]>;
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

  const fetchEnvelopes = async (uids: number[]): Promise<IngestEnvelope[]> => {
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
  };

  return {
    async listUnseen() {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return [];
      return fetchEnvelopes(uids);
    },

    async findByMessageIds(messageIds) {
      const found: IngestEnvelope[] = [];
      // One search per id: IMAP HEADER search takes a single value, and the
      // caller only ever passes the handful of messages an owner re-armed.
      for (const messageId of messageIds) {
        try {
          const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
          if (!uids || uids.length === 0) continue;
          found.push(...await fetchEnvelopes(uids));
        } catch (err) {
          console.warn(`[email-ingest] Could not re-find message ${messageId}:`, err);
        }
      }
      return found;
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
  /** Failures parked for an automatic retry (subset of `errors`). */
  retrying: number;
  /** Failures that landed in the terminal state (subset of `errors`). */
  failedPermanently: number;
}

/**
 * Persist a failed message AND surface it.
 *
 * The reason never lives only in a console.error: it goes into the ingest
 * log's `detail` column (rendered on the Settings → Email ingest panel and
 * returned by `listIngestLog`), and — for terminal failures — into an `error`
 * notification for the owning user via the app's existing notification feed,
 * the same `createNotification` surface this module already uses to announce
 * successful ingests.
 *
 * Returns the outcome that was written.
 */
/**
 * Record a failure WITHOUT ever downgrading a terminal success.
 *
 * `recordProcessedMessage` is an unconditional upsert, which makes it unsafe
 * on the failure path: anything that throws after `ingested` was persisted
 * (mailbox flagging, notification delivery) would otherwise rewrite the row to
 * a retryable `error`, and that row then satisfies the transient reclaim
 * predicate and replays a message whose documents already exist. The WHERE
 * clause makes that transition impossible.
 *
 * Returns false when the write was refused because the row is already
 * `ingested`.
 */
async function recordFailureOutcome(input: {
  messageKey: string;
  fromEmail: string | null;
  subject: string | null;
  outcome: string;
  detail: string;
}): Promise<boolean> {
  await ensureEmailIngestTables();
  const written = await prisma.$executeRaw`
    INSERT INTO gnucash_web_ingest_messages
      (message_key, from_email, subject, outcome, detail, ingested_count)
    VALUES (
      ${input.messageKey.slice(0, 512)},
      ${input.fromEmail?.slice(0, 255) ?? null},
      ${input.subject?.slice(0, 500) ?? null},
      ${input.outcome},
      ${input.detail},
      0
    )
    ON CONFLICT (message_key) DO UPDATE SET
      from_email = EXCLUDED.from_email,
      subject = EXCLUDED.subject,
      outcome = EXCLUDED.outcome,
      detail = EXCLUDED.detail,
      processed_at = CURRENT_TIMESTAMP
    WHERE gnucash_web_ingest_messages.outcome <> ${INGEST_OUTCOME_INGESTED}`;
  return written > 0;
}

/**
 * Flag a message seen. Mailbox hygiene only — a failure here must never turn a
 * recorded ingest into a retryable one, so it is swallowed and logged. Worst
 * case the message is listed again and skipped by its finished row.
 */
async function markSeenQuietly(client: IngestMailClient, uid: number): Promise<void> {
  try {
    await client.markSeen(uid);
  } catch (err) {
    console.warn(`[email-ingest] Could not flag message uid ${uid} as seen:`, err);
  }
}

async function recordIngestFailure(input: {
  messageKey: string;
  fromEmail: string | null;
  subject: string | null;
  reason: string;
  kind: IngestFailureKind;
  attempt: number;
  /** Owning user/book, when the sender was resolved. */
  userId?: number | null;
  bookGuid?: string | null;
}): Promise<
  typeof INGEST_OUTCOME_RETRYING | typeof INGEST_OUTCOME_FAILED | typeof INGEST_OUTCOME_INGESTED
> {
  const attemptsLeft = input.kind === 'transient' && input.attempt < INGEST_MAX_ATTEMPTS;
  const outcome = attemptsLeft ? INGEST_OUTCOME_RETRYING : INGEST_OUTCOME_FAILED;

  const detail = attemptsLeft
    ? `${input.reason} — transient; retry ${input.attempt + 1} of ${INGEST_MAX_ATTEMPTS} in ~${retryBackoffMinutes(input.attempt)} min`
    : `${input.reason} — ${
        input.kind === 'permanent'
          ? 'permanent failure, no automatic retry'
          : `gave up after ${input.attempt} of ${INGEST_MAX_ATTEMPTS} attempts`
      }`;

  const written = await recordFailureOutcome({
    messageKey: input.messageKey,
    fromEmail: input.fromEmail,
    subject: input.subject,
    outcome,
    detail,
  });
  if (!written) {
    // The row is already `ingested` — this failure came from something AFTER
    // the documents landed (mailbox flagging, notification). Nothing to report.
    console.warn(
      `[email-ingest] Ignoring post-success failure for ${input.messageKey}: ${input.reason}`,
    );
    return INGEST_OUTCOME_INGESTED;
  }

  // Terminal failures are the ones that mean "an inbound document is not in
  // your book" — those get a notification. In-flight retries stay in the log
  // only, so a flaky network doesn't spam the feed.
  if (outcome === INGEST_OUTCOME_FAILED && input.userId) {
    try {
      await createNotification({
        userId: input.userId,
        bookGuid: input.bookGuid ?? null,
        type: 'email_ingest',
        severity: 'error',
        title: 'Email ingest failed',
        message:
          `Could not ingest the email from ${input.fromEmail ?? '(unknown sender)'}` +
          `${input.subject ? ` — "${input.subject}"` : ''}. ${detail}. ` +
          'Fix the cause, then press Retry under Settings → Email ingest (or forward the email again).',
        href: '/settings',
        source: 'email-ingest',
        sourceId: input.messageKey.slice(0, 255),
      });
    } catch (notifyErr) {
      console.warn('[email-ingest] Failed to create failure notification:', notifyErr);
    }
  }

  return outcome;
}

async function ingestOneAttachment(
  kind: IngestKind,
  input: { bookGuid: string; userId: number; filename: string; buffer: Buffer; subject?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (kind === 'receipt') {
    const result = await intakeReceipt({ ...input, transactionGuid: null });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (kind === 'payslip') {
    const result = await intakePayslip(input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (kind === 'bill') {
    // Bill capture: receipt intake + a tracked draft-bill row on business
    // books (drafted after the OCR/extraction job completes). Loaded lazily
    // so the invoice engine is only pulled in when a bill actually arrives.
    const { captureBillFromEmail } = await import('@/lib/business/bill-capture');
    const result = await captureBillFromEmail(input);
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
 * IDEMPOTENCY — and its one known hole. Two layers protect the ORDERLY paths:
 *
 *  1. The unique `message_key` row is CLAIMED before a single attachment is
 *     downloaded or handed to the intake core, and only one claimant wins. A
 *     concurrent or overlapping poll performs no side effects.
 *  2. A message that ingested ANY attachment is recorded terminal (`ingested`)
 *     and is never retried, even if a sibling attachment failed. This matters
 *     because `intakeReceipt`/`intakeStatement`/`intakePayslip` are NOT
 *     content-addressed — they have no hash-based dedupe, so replaying a
 *     successful attachment WOULD create a second document. Every failure path
 *     that can be retried therefore leaves zero documents behind.
 *
 * KNOWN HOLE (pre-existing, tracked separately): a hard CRASH between a
 * successful `intakeOneAttachment` and `recordProcessedMessage` leaves the row
 * in `processing` with documents already created. `claimIngestMessage` reclaims
 * a stale `processing` row on elapsed time alone — there is no per-attachment
 * checkpoint — so the next worker replays every attachment and duplicates the
 * ones that had already landed. Layer 2 does not cover this, because the
 * "ingested" record is exactly what the crash destroyed. Closing it properly
 * needs content-addressed intake plus per-attachment checkpointing, which is
 * out of scope here. What this module does do is BOUND the damage: the stale
 * reclaim honours `attempts < INGEST_MAX_ATTEMPTS`, so a crash loop can
 * duplicate at most INGEST_MAX_ATTEMPTS times and then stops. The exhausted
 * claim is then reported as `stalled` by `listIngestAttention` — reported, not
 * rewritten, because an overdue claim is not proof its worker died and a write
 * here would race that worker's own final write.
 *
 * A partial success is reported as `ingested` with the failed attachment named
 * in `detail` and a `warning` notification, so the gap is visible even though
 * it is not auto-retried.
 *
 * `clientFactory` exists for tests; production callers omit it and get the
 * imapflow-backed client.
 */
let emailPollInFlight = false;

export async function pollEmailIngest(
  clientFactory?: () => Promise<IngestMailClient>,
): Promise<PollEmailIngestResult> {
  if (emailPollInFlight) {
    return {
      configured: getEmailIngestConfig() !== null,
      checked: 0,
      ingested: 0,
      skipped: 0,
      errors: 0,
      retrying: 0,
      failedPermanently: 0,
    };
  }
  emailPollInFlight = true;
  try {
    return await pollEmailIngestPass(clientFactory);
  } finally {
    emailPollInFlight = false;
  }
}

async function pollEmailIngestPass(
  clientFactory?: () => Promise<IngestMailClient>,
): Promise<PollEmailIngestResult> {
  const config = getEmailIngestConfig();
  const result: PollEmailIngestResult = {
    configured: config !== null,
    checked: 0,
    ingested: 0,
    skipped: 0,
    errors: 0,
    retrying: 0,
    failedPermanently: 0,
  };
  if (!config) return result;

  await ensureEmailIngestTables();

  const client = await (clientFactory ? clientFactory() : createImapIngestClient(config));
  try {
    const senders = await listIngestSenders();

    const unseen = await client.listUnseen();

    // Messages the owner re-armed are already flagged seen (terminal mail is
    // never left unread — that would re-list it on every poll forever), so
    // they have to be re-found explicitly by Message-ID.
    const rearmedKeys = await listRetryRequestedKeys();
    const rearmed = rearmedKeys.length > 0
      ? await client.findByMessageIds(rearmedKeys)
      : [];

    // A re-armed message may also still be unseen; dedupe by uid.
    const byUid = new Map<number, IngestEnvelope>();
    for (const envelope of [...unseen, ...rearmed]) byUid.set(envelope.uid, envelope);
    const envelopes = [...byUid.values()];
    if (envelopes.length === 0) return result;

    const states = await getIngestMessageStates(envelopes.map(e => messageDedupeKey(e)));
    const seenThisRun = new Set<string>();

    /**
     * Tally a failure the poller has already persisted, and settle the
     * mailbox flag: a TERMINAL failure is flagged seen so ordinary polls stop
     * re-listing it forever (an owner-requested retry re-finds it by
     * Message-ID instead), while a transient one stays unread so the next
     * poll can pick it up.
     */
    const finishFailure = async (outcome: string, uid: number) => {
      if (outcome === INGEST_OUTCOME_INGESTED) {
        // recordIngestFailure refused to downgrade a persisted success.
        await markSeenQuietly(client, uid);
        return;
      }
      result.errors++;
      if (outcome === INGEST_OUTCOME_FAILED) {
        result.failedPermanently++;
        await markSeenQuietly(client, uid);
      } else {
        result.retrying++;
      }
    };

    for (const envelope of envelopes) {
      result.checked++;
      const key = messageDedupeKey(envelope);
      // Resolved up front so the catch block below can still name the owner.
      const sender = envelope.from ? matchAllowedSender(envelope.from, senders) : null;
      let attempt = 0;
      // The row's frozen attribution, once the claim reveals it. Preferred over
      // `sender` on the failure paths so a retry's notification goes to the
      // user the message actually belongs to.
      let claimedOwner: IngestOwnerSnapshot | null = null;

      try {
        // Idempotency: skip anything already settled (or repeated in-batch).
        // Live and reclaimable rows are absent from `states` — the claim below
        // decides those.
        const settled = states.get(key);
        if (settled || seenThisRun.has(key)) {
          if (settled?.stalled) {
            // An exhausted, abandoned claim. NO DB WRITE: the row stays exactly
            // as it is, a read-only `stalled` record in the attention list. All
            // that happens here is the mailbox flag, so ordinary polls stop
            // being handed a message nothing will ever pick up again.
            console.warn(
              `[email-ingest] Stalled claim for ${key} (uid ${envelope.uid}) after ` +
              `${settled.attempts} attempts — see Settings → Email ingest`,
            );
          }
          // Every settled message — success, skip, terminal failure, or a
          // stalled claim — is flagged seen so an ordinary poll never selects
          // it again. A re-armed failure comes back through findByMessageIds.
          await markSeenQuietly(client, envelope.uid);
          result.skipped++;
          continue;
        }
        seenThisRun.add(key);

        // Cross-job/process idempotency: acquire the unique dedupe row before
        // downloading or ingesting attachments. A concurrent poll that lost
        // this race performs no side effects — and deliberately does NOT mark
        // the message seen: the live claimant marks it when it finishes, and
        // if that claimant dies the message must stay unread so the stale
        // claim can be reclaimed on a later poll. A transient failure still
        // inside its backoff window also loses here, and waits.
        const claim = await claimIngestMessage({
          messageKey: key,
          fromEmail: envelope.from,
          subject: envelope.subject,
          // Attribution for a FIRST ingest only. An existing row keeps its own
          // snapshot (COALESCE in the SQL), which is what makes a retry after
          // an allowlist edit land in the ORIGINAL user's book.
          owner: sender
            ? {
                userId: sender.userId,
                bookGuid: sender.bookGuid ?? config.defaultBookGuid,
                senderId: sender.id,
                senderEmail: sender.email,
              }
            : null,
        });
        if (claim === null) {
          result.skipped++;
          continue;
        }
        attempt = claim.attempt;

        // ROUTE BY THE SNAPSHOT, never by the allowlist match above. For a
        // first ingest the two are the same row; for a retry the snapshot is
        // the only trustworthy answer, because the allowlist may since have
        // been edited, re-pointed at another user, or deleted outright.
        const owner = claim.owner;
        claimedOwner = owner;
        if (!owner) {
          // Either the sender was never allowlisted, or a re-armed message
          // lost its owner because that user account was deleted (the FK is
          // ON DELETE SET NULL). Both mean the same thing here: there is no
          // book to file this into, and guessing one from the current
          // allowlist is exactly what the snapshot exists to prevent.
          console.log(
            `[email-ingest] Skipping message with no owner (sender ${envelope.from ?? '(unknown)'}): "${envelope.subject}"`,
          );
          await recordProcessedMessage({
            messageKey: key,
            fromEmail: envelope.from,
            subject: envelope.subject,
            outcome: 'skipped_sender',
            detail: claim.manual
              ? 'The owner recorded for this message no longer exists'
              : 'Sender is not on the allowlist',
          });
          await markSeenQuietly(client, envelope.uid);
          result.skipped++;
          continue;
        }

        // The sender RULE is still consulted for presentation-level config
        // (its default kind), which is not authority and is safe to re-read.
        // Falls back to auto-detection when the rule is gone.
        const ownerDefaultKind: IngestDefaultKind =
          senders.find(s => s.id === owner.senderId)?.defaultKind ?? 'auto';

        const bookGuid = owner.bookGuid ?? config.defaultBookGuid;
        if (!bookGuid) {
          // Permanent as far as this poll is concerned — retrying the same
          // config produces the same answer. The user is told, and can re-arm
          // the message once a book is set.
          const outcome = await recordIngestFailure({
            messageKey: key,
            fromEmail: envelope.from,
            subject: envelope.subject,
            reason: 'No book configured for this sender and INGEST_DEFAULT_BOOK is unset',
            kind: 'permanent',
            attempt,
            userId: owner.userId,
            bookGuid: null,
          });
          await finishFailure(outcome, envelope.uid);
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
          await markSeenQuietly(client, envelope.uid);
          result.skipped++;
          continue;
        }

        const ingestedItems: string[] = [];
        const failedItems: string[] = [];
        // 'permanent' only if EVERY failure is permanent — one retryable
        // attachment is enough to make another attempt worthwhile.
        let failureKind: IngestFailureKind = 'permanent';
        for (const att of attachments) {
          const filename = att.filename || `attachment-${envelope.uid}`;
          const kind = classifyKind({
            filename,
            subject: envelope.subject,
            defaultKind: ownerDefaultKind,
          });
          const outcome = await ingestOneAttachment(kind, {
            bookGuid,
            userId: owner.userId,
            filename,
            buffer: att.content,
            subject: envelope.subject,
          });
          if (outcome.ok) {
            ingestedItems.push(`${filename} → ${kind}`);
          } else {
            failedItems.push(`${filename}: ${outcome.error}`);
            if (classifyIngestFailure(outcome.error) === 'transient') failureKind = 'transient';
          }
        }

        // Nothing landed: the message is a candidate for another attempt,
        // because no document was created and a retry cannot duplicate one.
        if (ingestedItems.length === 0) {
          console.error(
            `[email-ingest] No attachment ingested for message ${key} (uid ${envelope.uid}): ${failedItems.join('; ')}`,
          );
          const outcome = await recordIngestFailure({
            messageKey: key,
            fromEmail: envelope.from,
            subject: envelope.subject,
            reason: `Failed: ${failedItems.join(', ')}`,
            kind: failureKind,
            attempt,
            userId: owner.userId,
            bookGuid,
          });
          await finishFailure(outcome, envelope.uid);
          continue;
        }

        // At least one document landed — terminal, never retried (see the
        // idempotency note on pollEmailIngest).
        const detailParts: string[] = [`Ingested: ${ingestedItems.join(', ')}`];
        if (failedItems.length) detailParts.push(`Failed: ${failedItems.join(', ')}`);

        await recordProcessedMessage({
          messageKey: key,
          fromEmail: envelope.from,
          subject: envelope.subject,
          outcome: INGEST_OUTCOME_INGESTED,
          detail: detailParts.join(' · '),
          ingestedCount: ingestedItems.length,
        });
        await markSeenQuietly(client, envelope.uid);
        result.ingested += ingestedItems.length;

        try {
          await createNotification({
            userId: owner.userId,
            bookGuid,
            type: 'email_ingest',
            severity: failedItems.length > 0 ? 'warning' : 'success',
            title: `Email ingested: ${ingestedItems.length} document${ingestedItems.length === 1 ? '' : 's'}`,
            message: `From ${envelope.from}${envelope.subject ? ` — "${envelope.subject}"` : ''}. ${detailParts.join(' · ')}`,
            href: '/settings',
            source: 'email-ingest',
            sourceId: key.slice(0, 255),
          });
        } catch (notifyErr) {
          console.warn('[email-ingest] Failed to create notification:', notifyErr);
        }
      } catch (err) {
        // The reason is persisted, not just logged: recordIngestFailure writes
        // it to the ingest log and (when terminal) notifies the owning user.
        console.error(`[email-ingest] Failed to process message ${key} (uid ${envelope.uid}):`, err);
        try {
          const outcome = await recordIngestFailure({
            messageKey: key,
            fromEmail: envelope.from,
            subject: envelope.subject,
            reason: describeIngestError(err),
            kind: classifyIngestFailure(err),
            attempt,
            userId: claimedOwner?.userId ?? sender?.userId ?? null,
            bookGuid: claimedOwner
              ? (claimedOwner.bookGuid ?? config.defaultBookGuid)
              : (sender?.bookGuid ?? config.defaultBookGuid),
          });
          await finishFailure(outcome, envelope.uid);
        } catch (recordErr) {
          // Could not even persist the failure — do not lose the count.
          result.errors++;
          console.error(`[email-ingest] Failed to record the failure for ${key}:`, recordErr);
        }
      }
    }

    return result;
  } finally {
    try { await client.close(); } catch { /* best effort */ }
  }
}
