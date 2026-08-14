import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// email-ingest.ts imports prisma, notifications, and the intake core at module
// level — mock them all so the tests run without a database. imapflow itself
// is never imported: the poller only loads it via dynamic import inside
// createImapIngestClient, which these tests never call (they use a fake
// IngestMailClient instead).
const { db, createNotificationMock, intakeReceiptMock, intakeStatementMock, intakePayslipMock } =
  vi.hoisted(() => ({
    db: {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $executeRawUnsafe: vi.fn(),
    },
    createNotificationMock: vi.fn(),
    intakeReceiptMock: vi.fn(),
    intakeStatementMock: vi.fn(),
    intakePayslipMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({ default: db }));
vi.mock('@/lib/notifications', () => ({ createNotification: createNotificationMock }));
vi.mock('@/lib/services/document-intake', () => ({
  intakeReceipt: intakeReceiptMock,
  intakeStatement: intakeStatementMock,
  intakePayslip: intakePayslipMock,
}));

import {
  normalizeSenderEmail,
  matchAllowedSender,
  classifyKind,
  isAllowedAttachment,
  messageDedupeKey,
  filterNewMessages,
  collectAttachmentParts,
  isEmailIngestConfigured,
  getEmailIngestConfig,
  pollEmailIngest,
  MAX_ATTACHMENT_SIZE,
  INGEST_CLAIM_STALE_MINUTES,
  INGEST_MAX_ATTEMPTS,
  INGEST_RETRY_BACKOFF_MINUTES,
  INGEST_OUTCOME_FAILED,
  listIngestAttention,
  INGEST_OUTCOME_RETRYING,
  classifyIngestFailure,
  describeIngestError,
  retryBackoffMinutes,
  type IngestMailClient,
  type IngestEnvelope,
  type IngestAttachment,
} from '../email-ingest';

describe('email-ingest', () => {
  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------
  describe('configuration', () => {
    const ENV_KEYS = [
      'INGEST_IMAP_HOST', 'INGEST_IMAP_PORT', 'INGEST_IMAP_SECURE',
      'INGEST_IMAP_USER', 'INGEST_IMAP_PASS', 'INGEST_FOLDER', 'INGEST_DEFAULT_BOOK',
    ];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it('is unconfigured when host/user/pass are missing', () => {
      expect(isEmailIngestConfigured()).toBe(false);
      process.env.INGEST_IMAP_HOST = 'imap.example.com';
      expect(isEmailIngestConfigured()).toBe(false);
      process.env.INGEST_IMAP_USER = 'ingest@example.com';
      expect(isEmailIngestConfigured()).toBe(false);
    });

    it('is configured with defaults once host/user/pass are set', () => {
      process.env.INGEST_IMAP_HOST = 'imap.example.com';
      process.env.INGEST_IMAP_USER = 'ingest@example.com';
      process.env.INGEST_IMAP_PASS = 'secret';

      expect(isEmailIngestConfigured()).toBe(true);
      const config = getEmailIngestConfig();
      expect(config).toMatchObject({
        host: 'imap.example.com',
        port: 993,
        secure: true,
        folder: 'INBOX',
        defaultBookGuid: null,
      });
    });

    it('respects explicit port/secure/folder/default book', () => {
      process.env.INGEST_IMAP_HOST = 'imap.example.com';
      process.env.INGEST_IMAP_USER = 'ingest@example.com';
      process.env.INGEST_IMAP_PASS = 'secret';
      process.env.INGEST_IMAP_SECURE = 'false';
      process.env.INGEST_IMAP_PORT = '1143';
      process.env.INGEST_FOLDER = 'Receipts';
      process.env.INGEST_DEFAULT_BOOK = 'abc123';

      expect(getEmailIngestConfig()).toMatchObject({
        port: 1143,
        secure: false,
        folder: 'Receipts',
        defaultBookGuid: 'abc123',
      });
    });

    it('defaults to port 143 when secure=false and no port is given', () => {
      process.env.INGEST_IMAP_HOST = 'imap.example.com';
      process.env.INGEST_IMAP_USER = 'u';
      process.env.INGEST_IMAP_PASS = 'p';
      process.env.INGEST_IMAP_SECURE = 'false';
      expect(getEmailIngestConfig()?.port).toBe(143);
    });
  });

  // -------------------------------------------------------------------------
  // Sender allowlist matching
  // -------------------------------------------------------------------------
  describe('normalizeSenderEmail', () => {
    it('lowercases and trims', () => {
      expect(normalizeSenderEmail('  Bob@Example.COM ')).toBe('bob@example.com');
    });

    it('strips plus-addressing tags', () => {
      expect(normalizeSenderEmail('bob+receipts@example.com')).toBe('bob@example.com');
      expect(normalizeSenderEmail('bob+a+b@example.com')).toBe('bob@example.com');
    });

    it('unwraps "Name <addr>" forms', () => {
      expect(normalizeSenderEmail('Bob Smith <Bob+Tag@Example.com>')).toBe('bob@example.com');
    });

    it('leaves plain non-address strings alone-ish', () => {
      expect(normalizeSenderEmail('not-an-email')).toBe('not-an-email');
    });
  });

  describe('matchAllowedSender', () => {
    const allowlist = [
      { id: 1, email: 'Alice@Example.com' },
      { id: 2, email: 'bob+ingest@example.com' },
    ];

    it('matches case-insensitively', () => {
      expect(matchAllowedSender('alice@EXAMPLE.COM', allowlist)?.id).toBe(1);
    });

    it('tolerates plus-addressing on the sender side', () => {
      expect(matchAllowedSender('alice+work@example.com', allowlist)?.id).toBe(1);
    });

    it('tolerates plus-addressing on the allowlist side', () => {
      expect(matchAllowedSender('bob@example.com', allowlist)?.id).toBe(2);
      expect(matchAllowedSender('Bob+other@Example.com', allowlist)?.id).toBe(2);
    });

    it('rejects unknown senders', () => {
      expect(matchAllowedSender('mallory@example.com', allowlist)).toBeNull();
      expect(matchAllowedSender('alice@evil.com', allowlist)).toBeNull();
    });

    it('does not treat a plus-tag as a different mailbox domain', () => {
      expect(matchAllowedSender('alice@example.com.evil.com', allowlist)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Kind classification
  // -------------------------------------------------------------------------
  describe('classifyKind', () => {
    it('honors a non-auto sender default over heuristics', () => {
      expect(classifyKind({ filename: 'statement-2026-06.pdf', defaultKind: 'receipt' })).toBe('receipt');
      expect(classifyKind({ filename: 'random.pdf', defaultKind: 'payslip' })).toBe('payslip');
      expect(classifyKind({ filename: 'lunch.jpg', defaultKind: 'statement' })).toBe('statement');
    });

    it('detects statements from filename keywords', () => {
      expect(classifyKind({ filename: 'Statement-June-2026.pdf' })).toBe('statement');
      expect(classifyKind({ filename: 'chase_stmt_0626.pdf' })).toBe('statement');
      expect(classifyKind({ filename: 'account summary.pdf' })).toBe('statement');
    });

    it('detects statements from the subject line', () => {
      expect(classifyKind({ filename: 'doc123.pdf', subject: 'Your monthly statement is ready' })).toBe('statement');
    });

    it('detects payslips from filename/subject keywords', () => {
      expect(classifyKind({ filename: 'Payslip_2026-06-30.pdf' })).toBe('payslip');
      expect(classifyKind({ filename: 'doc.pdf', subject: 'Your pay stub for June' })).toBe('payslip');
      expect(classifyKind({ filename: 'ADP_Payroll_0626.pdf' })).toBe('payslip');
    });

    it('prefers payslip over statement for "earnings statement"', () => {
      expect(classifyKind({ filename: 'earnings statement 2026-06.pdf' })).toBe('payslip');
      expect(classifyKind({ filename: 'doc.pdf', subject: 'Pay statement available' })).toBe('payslip');
    });

    it('falls back to receipt', () => {
      expect(classifyKind({ filename: 'IMG_2041.jpg' })).toBe('receipt');
      expect(classifyKind({ filename: 'invoice-restaurant.pdf', subject: 'Dinner' })).toBe('receipt');
      expect(classifyKind({ filename: 'scan.pdf', defaultKind: 'auto' })).toBe('receipt');
    });

    it('routes a "bill" subject prefix to the bill pipeline', () => {
      expect(classifyKind({ filename: 'doc.pdf', subject: 'bill' })).toBe('bill');
      expect(classifyKind({ filename: 'doc.pdf', subject: 'Bill: Electric June' })).toBe('bill');
      // Prefix beats the statement/payslip keyword heuristics...
      expect(classifyKind({ filename: 'statement-june.pdf', subject: 'bill for water' })).toBe('bill');
      // ...but a non-prefix mention does not trigger it.
      expect(classifyKind({ filename: 'doc.pdf', subject: 'Your bill is ready' })).toBe('receipt');
      expect(classifyKind({ filename: 'doc.pdf', subject: 'Billing update' })).toBe('receipt');
      // A non-auto sender default still wins over the subject prefix.
      expect(classifyKind({ filename: 'doc.pdf', subject: 'bill', defaultKind: 'receipt' })).toBe('receipt');
      // And 'bill' works as an explicit sender default.
      expect(classifyKind({ filename: 'random.pdf', defaultKind: 'bill' })).toBe('bill');
    });
  });

  // -------------------------------------------------------------------------
  // Attachment filter
  // -------------------------------------------------------------------------
  describe('isAllowedAttachment', () => {
    it('accepts pdf/jpg/jpeg/png/heic by extension', () => {
      for (const name of ['a.pdf', 'b.JPG', 'c.jpeg', 'd.png', 'e.HEIC']) {
        expect(isAllowedAttachment({ filename: name, size: 1000 })).toBe(true);
      }
    });

    it('accepts allowed MIME types when the filename is missing', () => {
      expect(isAllowedAttachment({ mimeType: 'application/pdf', size: 1000 })).toBe(true);
      expect(isAllowedAttachment({ mimeType: 'image/jpeg', size: 1000 })).toBe(true);
      expect(isAllowedAttachment({ mimeType: 'IMAGE/PNG', size: 1000 })).toBe(true);
      expect(isAllowedAttachment({ mimeType: 'image/heic', size: 1000 })).toBe(true);
    });

    it('rejects other types', () => {
      expect(isAllowedAttachment({ filename: 'a.docx', size: 1000 })).toBe(false);
      expect(isAllowedAttachment({ filename: 'a.zip', size: 1000 })).toBe(false);
      expect(isAllowedAttachment({ filename: 'a.exe', size: 1000 })).toBe(false);
      expect(isAllowedAttachment({ filename: 'a.gif', mimeType: 'image/gif', size: 1000 })).toBe(false);
      expect(isAllowedAttachment({ filename: 'a.html', mimeType: 'text/html', size: 1000 })).toBe(false);
      expect(isAllowedAttachment({ size: 1000 })).toBe(false);
    });

    it('enforces the 15MB size cap and rejects empty files', () => {
      expect(MAX_ATTACHMENT_SIZE).toBe(15 * 1024 * 1024);
      expect(isAllowedAttachment({ filename: 'a.pdf', size: MAX_ATTACHMENT_SIZE })).toBe(true);
      expect(isAllowedAttachment({ filename: 'a.pdf', size: MAX_ATTACHMENT_SIZE + 1 })).toBe(false);
      expect(isAllowedAttachment({ filename: 'a.pdf', size: 0 })).toBe(false);
      expect(isAllowedAttachment({ filename: 'a.pdf', size: -5 })).toBe(false);
    });

    it('is not fooled by a sneaky extension when MIME is disallowed', () => {
      expect(isAllowedAttachment({ filename: 'evil.pdf.exe', mimeType: 'application/pdf', size: 10 })).toBe(true); // MIME wins
      expect(isAllowedAttachment({ filename: 'evil.exe', mimeType: 'application/octet-stream', size: 10 })).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Message-ID dedupe
  // -------------------------------------------------------------------------
  describe('messageDedupeKey / filterNewMessages', () => {
    it('normalizes Message-IDs (angle brackets, whitespace, case)', () => {
      expect(messageDedupeKey({ messageId: '<ABC@Mail.Example>' })).toBe('abc@mail.example');
      expect(messageDedupeKey({ messageId: '  <abc@mail.example>  ' })).toBe('abc@mail.example');
      expect(messageDedupeKey({ messageId: 'abc@mail.example' })).toBe('abc@mail.example');
    });

    it('builds a stable fallback key when Message-ID is missing', () => {
      const msg = { messageId: null, from: 'a@b.c', subject: 'Hi', date: new Date('2026-07-01T00:00:00Z'), uid: 7 };
      const key1 = messageDedupeKey(msg);
      const key2 = messageDedupeKey({ ...msg });
      expect(key1).toBe(key2);
      expect(key1.startsWith('fallback:')).toBe(true);

      const different = messageDedupeKey({ ...msg, uid: 8 });
      expect(different).not.toBe(key1);
    });

    it('skips already-processed messages', () => {
      const messages = [
        { uid: 1, messageId: '<m1@x>' },
        { uid: 2, messageId: '<M2@X>' },
        { uid: 3, messageId: '<m3@x>' },
      ];
      const fresh = filterNewMessages(messages, new Set(['m2@x']));
      expect(fresh.map(m => m.uid)).toEqual([1, 3]);
    });

    it('skips duplicates within the same batch', () => {
      const messages = [
        { uid: 1, messageId: '<dup@x>' },
        { uid: 2, messageId: '<dup@x>' },
      ];
      const fresh = filterNewMessages(messages, new Set());
      expect(fresh.map(m => m.uid)).toEqual([1]);
    });
  });

  // -------------------------------------------------------------------------
  // BODYSTRUCTURE walking
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Failure classification + backoff (pure)
  // -------------------------------------------------------------------------
  describe('classifyIngestFailure', () => {
    it('treats network faults and rate limits as transient', () => {
      for (const err of [
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        new Error('socket hang up'),
        new Error('Request timed out after 30s'),
        new Error('429 Too Many Requests'),
        new Error('503 Service Unavailable'),
        'failed to save receipt record',
      ]) {
        expect(classifyIngestFailure(err)).toBe('transient');
      }
    });

    it('treats bad input and missing configuration as permanent', () => {
      for (const err of [
        'unsupported file type (must be JPEG, PNG, or PDF)',
        'exceeds 10MB limit',
        new Error('PDF is malformed and cannot be parsed'),
        new Error('attachment is corrupt'),
        new Error('file is password protected'),
        'No book configured for this sender and INGEST_DEFAULT_BOOK is unset',
      ]) {
        expect(classifyIngestFailure(err)).toBe('permanent');
      }
    });

    /**
     * BEHAVIOUR CHANGE, pinned deliberately. A non-Error object used to reach
     * describeIngestError's `String(err)` and stringify to '[object Object]',
     * which matched nothing and was therefore retried. Its `message` field is
     * now read, so a permanent reason inside a plain object is honoured and the
     * message goes terminal on the FIRST attempt instead of after three.
     * That is more correct, but it moves a case onto the drop-mail side, so it
     * gets an explicit test rather than riding along silently.
     */
    it('reads the message off a non-Error object instead of stringifying it', () => {
      expect(describeIngestError({ message: 'corrupt file' })).toBe('corrupt file');
      expect(classifyIngestFailure({ message: 'corrupt file' })).toBe('permanent');

      // Previously: '[object Object]' -> no pattern match -> transient.
      expect(describeIngestError({ message: 'corrupt file' })).not.toContain('[object Object]');

      // A non-Error object with no usable message still defaults to transient.
      expect(classifyIngestFailure({ nope: 1 })).toBe('transient');
      expect(describeIngestError({ nope: 1 })).toContain('nope');
    });

    it('keeps a typed code from a non-Error object', () => {
      expect(classifyIngestFailure({ code: 'ECONNRESET' })).toBe('transient');
      expect(describeIngestError({ code: 'ECONNRESET', message: 'reset' })).toContain('ECONNRESET');
    });

    it('defaults an unrecognized failure to transient (the retry budget bounds it)', () => {
      expect(classifyIngestFailure(new Error('kaboom'))).toBe('transient');
      expect(classifyIngestFailure(undefined)).toBe('transient');
    });

    it('prefers the permanent verdict when both vocabularies match', () => {
      // "connection" reads transient, but the file itself is unusable.
      expect(classifyIngestFailure(new Error('unsupported file type on connection close')))
        .toBe('permanent');
    });

    it('keeps the errno code in the described reason', () => {
      const err = Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' });
      expect(describeIngestError(err)).toBe('ETIMEDOUT: connect failed');
      expect(describeIngestError('plain string')).toBe('plain string');
    });
  });

  describe('retryBackoffMinutes', () => {
    it('grows exponentially from the configured base', () => {
      expect(retryBackoffMinutes(1)).toBe(INGEST_RETRY_BACKOFF_MINUTES);
      expect(retryBackoffMinutes(2)).toBe(INGEST_RETRY_BACKOFF_MINUTES * 2);
      expect(retryBackoffMinutes(3)).toBe(INGEST_RETRY_BACKOFF_MINUTES * 4);
    });

    it('never returns a zero or negative wait, so a retry can never spin', () => {
      for (const attempts of [-5, 0, 1, 2, 3, 10]) {
        expect(retryBackoffMinutes(attempts)).toBeGreaterThan(0);
      }
    });
  });

  describe('collectAttachmentParts', () => {
    it('finds attachment leaves in a multipart tree', () => {
      const parts = collectAttachmentParts({
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain' },
          {
            part: '2',
            type: 'application/pdf',
            size: 5000,
            disposition: 'attachment',
            dispositionParameters: { filename: 'receipt.pdf' },
          },
          {
            part: '3',
            type: 'image/jpeg',
            size: 800,
            parameters: { name: 'photo.jpg' },
          },
        ],
      });
      expect(parts).toEqual([
        { part: '2', filename: 'receipt.pdf', mimeType: 'application/pdf', size: 5000 },
        { part: '3', filename: 'photo.jpg', mimeType: 'image/jpeg', size: 800 },
      ]);
    });

    it('ignores body text and inline parts without filenames', () => {
      const parts = collectAttachmentParts({
        type: 'multipart/alternative',
        childNodes: [
          { part: '1', type: 'text/plain' },
          { part: '2', type: 'text/html' },
        ],
      });
      expect(parts).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Poller with a fake IMAP client (imapflow never touched)
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Legacy-state migration (lazy DDL)
  // -------------------------------------------------------------------------
  describe('ensureEmailIngestTables', () => {
    /**
     * The module memoizes its DDL promise, so a fresh module instance is the
     * only way to observe the statement it actually issues. The prisma mock is
     * hoisted, so the re-imported copy still talks to the same fake.
     */
    async function captureSchemaDdl(): Promise<string> {
      vi.resetModules();
      db.$executeRawUnsafe.mockClear();
      db.$executeRawUnsafe.mockResolvedValue(0);
      const mod = await import('../email-ingest');
      await mod.ensureEmailIngestTables();
      return db.$executeRawUnsafe.mock.calls.map((c: unknown[]) => c[0] as string).join('\n');
    }

    it('converts legacy retry_requested rows into terminal failures', async () => {
      const ddl = await captureSchemaDdl();

      // An earlier build of this branch had a user-initiated 'retry_requested'
      // state. Under the current code such a row is treated as finished, is
      // absent from the attention list, and nothing can re-arm it — an
      // invisible tombstone, the exact bug this module exists to kill. The
      // lazy DDL migrates it to the terminal state so it surfaces instead.
      expect(ddl).toContain('UPDATE gnucash_web_ingest_messages');
      expect(ddl).toMatch(/SET outcome = 'failed_permanent'/);
      expect(ddl).toMatch(/WHERE outcome = 'retry_requested'/);
      // The reason survives the migration rather than being overwritten.
      expect(ddl).toContain('COALESCE(NULLIF(detail');
      expect(ddl).toContain('manual retry is no longer supported');
      // Runs under the same advisory lock as the rest of the schema block, so
      // concurrent workers serialize instead of racing.
      expect(ddl).toContain("pg_advisory_xact_lock(hashtext('gnucash_web_email_ingest_schema'))");
    });

    it('is idempotent — the migration matches nothing once applied', async () => {
      const ddl = await captureSchemaDdl();
      // Self-healing by construction: the predicate is the state it removes, so
      // a second run (or an install that never had the state) is a no-op.
      const setsOutcome = /SET outcome = '(\w+)'/.exec(ddl)?.[1];
      const wherePredicate = /WHERE outcome = '(\w+)'/.exec(ddl)?.[1];
      expect(setsOutcome).toBe('failed_permanent');
      expect(wherePredicate).toBe('retry_requested');
      expect(setsOutcome).not.toBe(wherePredicate);
    });
  });

  describe('pollEmailIngest', () => {
    const ENV = { INGEST_IMAP_HOST: 'imap.example.com', INGEST_IMAP_USER: 'u', INGEST_IMAP_PASS: 'p' };
    const savedEnv: Record<string, string | undefined> = {};

    /** Fake mailbox: `envelopes` are the UNSEEN ones the poller will select. */
    function makeFakeClient(
      envelopes: IngestEnvelope[],
      attachments: Record<number, IngestAttachment[]>,
    ) {
      const seen: number[] = [];
      const client: IngestMailClient = {
        listUnseen: vi.fn(async () => envelopes),
        fetchAttachments: vi.fn(async (uid: number) => attachments[uid] ?? []),
        markSeen: vi.fn(async (uid: number) => { seen.push(uid); }),
        close: vi.fn(async () => {}),
      };
      return { client, seen };
    }

    /** Route mocked prisma queries by SQL text. */
    function primeDb(options: { senders?: unknown[]; processedKeys?: string[] }) {
      db.$executeRawUnsafe.mockResolvedValue(0); // ensure tables
      db.$executeRaw.mockResolvedValue(1); // recordProcessedMessage inserts
      db.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('INSERT INTO gnucash_web_ingest_messages')) {
          return Promise.resolve([{ message_key: 'claimed', attempts: 1 }]);
        }
        if (sql.includes('FROM gnucash_web_ingest_senders')) {
          return Promise.resolve(options.senders ?? []);
        }
        if (sql.includes('SELECT message_key, outcome, attempts')) {
          return Promise.resolve(
            (options.processedKeys ?? []).map(k => ({
              message_key: k,
              outcome: 'ingested',
              attempts: 1,
              stalled: false,
            })),
          );
        }
        return Promise.resolve([]);
      });
    }

    interface FakeMessageRow {
      id?: number;
      message_key: string;
      from_email?: string | null;
      subject?: string | null;
      outcome: string;
      detail?: string | null;
      processed_at: Date;
      attempts: number;
    }

    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

    /**
     * Stateful stand-in for gnucash_web_ingest_messages. Instead of a canned
     * answer it evaluates the same predicates the SQL does, using the values
     * the module actually binds — so the claim/skip decisions under test are
     * the module's, and the recorded outcome feeds the next poll.
     *
     * CAVEAT, stated plainly: this fake MIRRORS the SQL rather than executing
     * it. A behavioural test here proves the module's control flow given a
     * faithful store; it cannot prove the production SQL predicate itself.
     * The SQL text is pinned separately by the "claims with a conditional
     * upsert" test below, which asserts on the emitted statement.
     */
    function primeStatefulDb(options: { senders?: unknown[]; messages?: FakeMessageRow[] }) {
      const rows: FakeMessageRow[] = (options.messages ?? []).map((row, i) => ({
        id: i + 1,
        ...row,
      }));
      const queries: string[] = [];
      let nextId = rows.length + 1;

      db.$executeRawUnsafe.mockResolvedValue(0); // ensure tables

      db.$executeRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        queries.push(sql);

        // recordFailureOutcome: guarded upsert that must never overwrite a
        // persisted `ingested` row.
        if (sql.includes('INSERT INTO gnucash_web_ingest_messages')
            && sql.includes('WHERE gnucash_web_ingest_messages.outcome <> ')) {
          const key = values[0] as string;
          const outcome = values[3] as string;
          const detail = values[4] as string;
          const blocked = values[5] as string;
          const existing = rows.find(r => r.message_key === key);
          if (existing) {
            if (existing.outcome === blocked) return Promise.resolve(0);
            existing.outcome = outcome;
            existing.detail = detail;
            existing.processed_at = new Date();
          } else {
            rows.push({
              id: nextId++, message_key: key, outcome, detail,
              processed_at: new Date(), attempts: 0,
            });
          }
          return Promise.resolve(1);
        }

        // recordProcessedMessage: unconditional upsert (success/skip paths).
        if (sql.includes('INSERT INTO gnucash_web_ingest_messages')) {
          const key = values[0] as string;
          const outcome = values[3] as string;
          const detail = values[4] as string | null;
          const existing = rows.find(r => r.message_key === key);
          if (existing) {
            existing.outcome = outcome;
            existing.detail = detail;
            existing.processed_at = new Date();
          } else {
            rows.push({
              id: nextId++, message_key: key, outcome, detail,
              processed_at: new Date(), attempts: 0,
            });
          }
          return Promise.resolve(1);
        }

        return Promise.resolve(1);
      });

      db.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        queries.push(sql);

        // claimIngestMessage: INSERT ... ON CONFLICT DO UPDATE ... WHERE
        // (stale claim AND budget left) OR (transient error AND budget left
        // AND backoff elapsed).
        if (sql.includes('INSERT INTO gnucash_web_ingest_messages')) {
          const key = values[0] as string;
          const staleMaxAttempts = values[3] as number;
          const staleMinutes = values[4] as number;
          const maxAttempts = values[5] as number;
          const backoffBase = values[6] as number;
          const existing = rows.find(r => r.message_key === key);
          if (!existing) {
            rows.push({
              id: nextId++, message_key: key, outcome: 'processing',
              processed_at: new Date(), attempts: 1,
            });
            return Promise.resolve([{ message_key: key, attempts: 1 }]);
          }
          // Mirrors the SQL: base * 2^(attempts - 1), floored at attempts = 1.
          const backoffFor = (attempts: number) =>
            backoffBase * Math.pow(2, Math.max(attempts - 1, 0));
          const reclaimable =
            (existing.outcome === 'processing'
              && existing.attempts < staleMaxAttempts
              && existing.processed_at < minutesAgo(staleMinutes))
            || (existing.outcome === 'error'
              && existing.attempts < maxAttempts
              && existing.processed_at < minutesAgo(backoffFor(existing.attempts)));
          if (!reclaimable) return Promise.resolve([]); // live claim / backing off
          existing.outcome = 'processing';
          existing.processed_at = new Date();
          existing.attempts += 1;
          return Promise.resolve([{ message_key: key, attempts: existing.attempts }]);
        }

        // listIngestAttention: scoped CTE + per-category window count.
        if (sql.includes('WITH scoped AS')) {
          const failed = values[0] as string;
          const owned = values[2] as string[];
          const maxAttempts = values[4] as number;
          const staleMinutes = values[5] as number;
          const limit = values[6] as number;
          const normalize = (email: string) =>
            email.toLowerCase().replace(/\+[^@]*@/, '@');
          const matching = rows.filter(r => {
            if (!r.from_email) return false;
            if (!owned.includes(normalize(r.from_email))) return false;
            return r.outcome === failed
              || (r.outcome === 'processing'
                && r.attempts >= maxAttempts
                && r.processed_at < minutesAgo(staleMinutes));
          });
          const withCategory = matching.map(r => ({
            ...r,
            from_email: r.from_email ?? null,
            subject: r.subject ?? null,
            detail: r.detail ?? null,
            ingested_count: 0,
            category: r.outcome === failed ? 'failed' : 'stalled',
          }));
          // COUNT(*) FILTER (...) OVER () — unpartitioned, computed over the
          // WHOLE scoped set BEFORE the LIMIT, so each total is carried on
          // every returned row regardless of which categories survive the page.
          const failedTotal = withCategory.filter(r => r.category === 'failed').length;
          const stalledTotal = withCategory.filter(r => r.category === 'stalled').length;
          return Promise.resolve(
            withCategory
              .sort((a, b) => b.processed_at.getTime() - a.processed_at.getTime())
              .slice(0, limit)
              .map(r => ({ ...r, failed_total: failedTotal, stalled_total: stalledTotal })),
          );
        }

        if (sql.includes('FROM gnucash_web_ingest_senders')) {
          return Promise.resolve(options.senders ?? []);
        }

        // getIngestMessageStates: settled rows — finished OR stalled claims.
        if (sql.includes('SELECT message_key, outcome, attempts')) {
          const keys = values[0] as string[];
          const maxAttempts = values[1] as number;
          const staleMinutes = values[2] as number;
          return Promise.resolve(
            rows
              .filter(r => {
                if (!keys.includes(r.message_key)) return false;
                if (r.outcome === 'processing') {
                  return r.attempts >= maxAttempts
                    && r.processed_at < minutesAgo(staleMinutes);
                }
                return !(r.outcome === 'error' && r.attempts < maxAttempts);
              })
              .map(r => ({
                message_key: r.message_key,
                outcome: r.outcome,
                attempts: r.attempts,
                stalled: r.outcome === 'processing',
              })),
          );
        }

        return Promise.resolve([]);
      });

      return { rows, queries };
    }

    const senderRow = {
      id: 1,
      email: 'alice@example.com',
      user_id: 42,
      book_guid: 'book-1',
      default_kind: 'auto',
      created_at: new Date('2026-07-01T00:00:00Z'),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      for (const [key, value] of Object.entries(ENV)) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
      }
    });

    afterEach(() => {
      for (const key of Object.keys(ENV)) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it('returns unconfigured without connecting when env is missing', async () => {
      delete process.env.INGEST_IMAP_HOST;
      const factory = vi.fn();
      const result = await pollEmailIngest(factory);
      expect(result.configured).toBe(false);
      expect(factory).not.toHaveBeenCalled();
    });

    it('does not start a second mailbox pass while one is in flight', async () => {
      primeDb({});
      let releaseList!: () => void;
      const listGate = new Promise<void>(resolve => { releaseList = resolve; });
      const firstClient: IngestMailClient = {
        listUnseen: vi.fn(async () => { await listGate; return []; }),
        fetchAttachments: vi.fn(async () => []),
        markSeen: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
      const firstFactory = vi.fn(async () => firstClient);
      const secondFactory = vi.fn(async () => firstClient);

      const firstPoll = pollEmailIngest(firstFactory);
      await vi.waitFor(() => expect(firstFactory).toHaveBeenCalledTimes(1));
      const secondResult = await pollEmailIngest(secondFactory);

      expect(secondResult.checked).toBe(0);
      expect(secondFactory).not.toHaveBeenCalled();
      releaseList();
      await firstPoll;
    });

    it('ingests an allowed sender attachment and marks the message seen', async () => {
      primeDb({ senders: [senderRow] });
      intakeReceiptMock.mockResolvedValue({ ok: true, id: 10, filename: 'lunch.jpg' });

      const { client, seen } = makeFakeClient(
        [{ uid: 5, messageId: '<m5@x>', from: 'Alice+fwd@Example.com', subject: 'Lunch', date: null }],
        { 5: [{ filename: 'lunch.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(100) }] },
      );

      const result = await pollEmailIngest(async () => client);

      expect(result).toMatchObject({ configured: true, checked: 1, ingested: 1, skipped: 0, errors: 0 });
      expect(intakeReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
        bookGuid: 'book-1',
        userId: 42,
        filename: 'lunch.jpg',
      }));
      expect(seen).toEqual([5]);
      expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
        userId: 42,
        bookGuid: 'book-1',
        type: 'email_ingest',
      }));
      expect(client.close).toHaveBeenCalled();
    });

    it('routes classified kinds to the matching intake pipeline', async () => {
      primeDb({ senders: [senderRow] });
      intakeStatementMock.mockResolvedValue({ ok: true, batch: { id: 3 } });
      intakePayslipMock.mockResolvedValue({ ok: true, id: 4, filename: 'payslip.pdf' });

      const { client } = makeFakeClient(
        [{ uid: 9, messageId: '<m9@x>', from: 'alice@example.com', subject: 'Documents', date: null }],
        {
          9: [
            { filename: 'statement-june.pdf', mimeType: 'application/pdf', content: Buffer.alloc(10) },
            { filename: 'payslip-june.pdf', mimeType: 'application/pdf', content: Buffer.alloc(10) },
          ],
        },
      );

      const result = await pollEmailIngest(async () => client);
      expect(result.ingested).toBe(2);
      expect(intakeStatementMock).toHaveBeenCalledTimes(1);
      expect(intakePayslipMock).toHaveBeenCalledTimes(1);
      expect(intakeReceiptMock).not.toHaveBeenCalled();
    });

    it('marks messages from non-allowlisted senders seen and skips them', async () => {
      primeDb({ senders: [senderRow] });

      const { client, seen } = makeFakeClient(
        [{ uid: 6, messageId: '<m6@x>', from: 'mallory@evil.com', subject: 'Totally a receipt', date: null }],
        { 6: [{ filename: 'a.pdf', mimeType: 'application/pdf', content: Buffer.alloc(10) }] },
      );

      const result = await pollEmailIngest(async () => client);

      expect(result).toMatchObject({ checked: 1, ingested: 0, skipped: 1 });
      expect(seen).toEqual([6]);
      expect(client.fetchAttachments).not.toHaveBeenCalled();
      expect(intakeReceiptMock).not.toHaveBeenCalled();
      expect(createNotificationMock).not.toHaveBeenCalled();
    });

    it('skips messages whose Message-ID was already processed', async () => {
      primeDb({ senders: [senderRow], processedKeys: ['m7@x'] });

      const { client, seen } = makeFakeClient(
        [{ uid: 7, messageId: '<M7@X>', from: 'alice@example.com', subject: 'Repeat', date: null }],
        { 7: [{ filename: 'a.pdf', mimeType: 'application/pdf', content: Buffer.alloc(10) }] },
      );

      const result = await pollEmailIngest(async () => client);

      expect(result).toMatchObject({ checked: 1, ingested: 0, skipped: 1 });
      expect(seen).toEqual([7]);
      expect(intakeReceiptMock).not.toHaveBeenCalled();
    });

    it('records an error outcome (not a crash) when one message fails', async () => {
      primeDb({ senders: [senderRow] });
      intakeReceiptMock.mockResolvedValue({ ok: true, id: 11, filename: 'ok.jpg' });

      const { client } = makeFakeClient(
        [
          { uid: 1, messageId: '<bad@x>', from: 'alice@example.com', subject: 'Bad', date: null },
          { uid: 2, messageId: '<good@x>', from: 'alice@example.com', subject: 'Good', date: null },
        ],
        { 2: [{ filename: 'ok.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(10) }] },
      );
      (client.fetchAttachments as ReturnType<typeof vi.fn>).mockImplementation(async (uid: number) => {
        if (uid === 1) throw new Error('boom');
        return [{ filename: 'ok.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(10) }];
      });

      const result = await pollEmailIngest(async () => client);
      expect(result).toMatchObject({ checked: 2, ingested: 1, errors: 1 });
    });

    // -----------------------------------------------------------------------
    // Stale / abandoned claim recovery (worker crash, OOM, redeploy)
    // -----------------------------------------------------------------------
    it('re-ingests a stale processing claim exactly once', async () => {
      const { rows } = primeStatefulDb({
        senders: [senderRow],
        messages: [{
          message_key: 'stale@x',
          outcome: 'processing',
          processed_at: minutesAgo(INGEST_CLAIM_STALE_MINUTES + 1),
          attempts: 1,
        }],
      });
      intakeReceiptMock.mockResolvedValue({ ok: true, id: 12, filename: 'lunch.jpg' });

      const envelope: IngestEnvelope = {
        uid: 20, messageId: '<stale@x>', from: 'alice@example.com', subject: 'Lunch', date: null,
      };
      const attachments = {
        20: [{ filename: 'lunch.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(100) }],
      };

      // The abandoned claim is stolen and the message finally ingested.
      const first = makeFakeClient([envelope], attachments);
      const firstResult = await pollEmailIngest(async () => first.client);
      expect(firstResult).toMatchObject({ checked: 1, ingested: 1, skipped: 0, errors: 0 });
      expect(intakeReceiptMock).toHaveBeenCalledTimes(1);
      expect(first.seen).toEqual([20]);
      expect(rows[0]).toMatchObject({ message_key: 'stale@x', outcome: 'ingested', attempts: 2 });

      // ...and only once: the row is finalized, so a later poll skips it.
      const second = makeFakeClient([envelope], attachments);
      const secondResult = await pollEmailIngest(async () => second.client);
      expect(secondResult).toMatchObject({ checked: 1, ingested: 0, skipped: 1 });
      expect(intakeReceiptMock).toHaveBeenCalledTimes(1);
    });

    it('skips a fresh processing claim and leaves it unread for the owner', async () => {
      primeStatefulDb({
        senders: [senderRow],
        messages: [{
          message_key: 'live@x',
          outcome: 'processing',
          processed_at: minutesAgo(1),
          attempts: 1,
        }],
      });

      const { client, seen } = makeFakeClient(
        [{ uid: 21, messageId: '<live@x>', from: 'alice@example.com', subject: 'In flight', date: null }],
        { 21: [{ filename: 'lunch.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(100) }] },
      );

      const result = await pollEmailIngest(async () => client);

      expect(result).toMatchObject({ checked: 1, ingested: 0, skipped: 1, errors: 0 });
      expect(client.fetchAttachments).not.toHaveBeenCalled();
      expect(intakeReceiptMock).not.toHaveBeenCalled();
      // Not marked seen: the live claimant marks it, and if that claimant dies
      // the message must stay unread so the stale claim can be reclaimed.
      expect(seen).toEqual([]);
    });

    it('claims with a conditional upsert so a live claim yields no row', async () => {
      const { queries } = primeStatefulDb({ senders: [senderRow] });
      intakeReceiptMock.mockResolvedValue({ ok: true, id: 13, filename: 'a.jpg' });

      const { client } = makeFakeClient(
        [{ uid: 22, messageId: '<new@x>', from: 'alice@example.com', subject: 'New', date: null }],
        { 22: [{ filename: 'a.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(10) }] },
      );
      await pollEmailIngest(async () => client);

      const claimSql = queries.find(q => q.includes('ON CONFLICT') && q.includes('RETURNING message_key'));
      expect(claimSql).toBeDefined();
      expect(claimSql).toContain('ON CONFLICT (message_key) DO UPDATE');
      // The WHERE is what preserves exactly-once: a fresh row fails it.
      expect(claimSql).toMatch(/WHERE[\s\S]*outcome = 'processing'/);
      expect(claimSql).toContain("? * INTERVAL '1 minute'");
      expect(claimSql).toMatch(/attempts < \?/);

      const selectSql = queries.find(q => q.includes("(outcome = 'processing') AS stalled"));
      expect(selectSql).toContain("outcome <> 'processing'");

      // The fake mirrors this predicate, so pin the emitted SQL: the states
      // query must ALSO return exhausted stalled claims. Without that branch
      // the poller never learns about them, leaves them unflagged, and every
      // ordinary poll is handed them again forever.
      const normalizedSelect = selectSql!.replace(/\s+/g, ' ');
      expect(normalizedSelect).toMatch(
        /outcome = 'processing' AND attempts >= \? AND processed_at < \(NOW\(\) - \? \* INTERVAL '1 minute'\)/,
      );
    });

    /**
     * The stateful fake MIRRORS the claim predicate rather than executing it,
     * so a behavioural test alone cannot prove the production SQL still
     * contains the timing and attempt bounds. These assertions pin the emitted
     * statement itself, so deleting a bound from the SQL fails a test even
     * though the fake would happily keep enforcing it.
     */
    it('emits a claim predicate that is both attempt-bounded and time-bounded', async () => {
      const { queries } = primeStatefulDb({ senders: [senderRow] });
      intakeReceiptMock.mockResolvedValue({ ok: true, id: 1, filename: 'a.jpg' });
      const { client } = makeFakeClient(
        [{ uid: 40, messageId: '<sql@x>', from: 'alice@example.com', subject: 'S', date: null }],
        { 40: [{ filename: 'a.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(10) }] },
      );
      await pollEmailIngest(async () => client);

      const claimSql = queries.find(q => q.includes('ON CONFLICT (message_key) DO UPDATE'));
      expect(claimSql).toBeDefined();
      const normalized = claimSql!.replace(/\s+/g, ' ');

      // Stale-claim branch: elapsed time AND an attempt bound (the attempt
      // bound is what stops a crash-loop replaying a message forever).
      expect(normalized).toMatch(
        /outcome = 'processing' AND gnucash_web_ingest_messages\.attempts < \? AND gnucash_web_ingest_messages\.processed_at < \(NOW\(\) - \? \* INTERVAL '1 minute'\)/,
      );
      // Transient-error branch: attempt bound AND exponential backoff.
      expect(normalized).toMatch(
        /outcome = 'error' AND gnucash_web_ingest_messages\.attempts < \? AND gnucash_web_ingest_messages\.processed_at < \(NOW\(\) - \(\? \* POWER\(2, GREATEST\(gnucash_web_ingest_messages\.attempts - 1, 0\)\)\) \* INTERVAL '1 minute'\)/,
      );
      // ...and the backoff base actually bound is the exported constant.
      const claimCall = db.$queryRaw.mock.calls.find(
        (c: unknown[]) => (c[0] as TemplateStringsArray).join('?').includes('ON CONFLICT'));
      expect(claimCall?.slice(1)).toContain(INGEST_RETRY_BACKOFF_MINUTES);
      expect(claimCall?.slice(1)).toContain(INGEST_CLAIM_STALE_MINUTES);
    });

    it('retries an errored message until attempts are exhausted', async () => {
      const attempts = INGEST_MAX_ATTEMPTS - 1;
      const { rows } = primeStatefulDb({
        senders: [senderRow],
        messages: [{
          message_key: 'err@x',
          outcome: 'error',
          // Past its backoff window, so this poll may reclaim it.
          processed_at: minutesAgo(retryBackoffMinutes(attempts) + 1),
          attempts,
        }],
      });
      intakeReceiptMock.mockResolvedValue({ ok: true, id: 14, filename: 'retry.jpg' });

      const { client, seen } = makeFakeClient(
        [{ uid: 23, messageId: '<err@x>', from: 'alice@example.com', subject: 'Retry me', date: null }],
        { 23: [{ filename: 'retry.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(10) }] },
      );

      const result = await pollEmailIngest(async () => client);
      expect(result).toMatchObject({ checked: 1, ingested: 1, errors: 0 });
      expect(seen).toEqual([23]);
      expect(rows[0]).toMatchObject({ outcome: 'ingested', attempts: INGEST_MAX_ATTEMPTS });
    });

    it('leaves a message alone once the retry budget is spent', async () => {
      primeStatefulDb({
        senders: [senderRow],
        messages: [{
          message_key: 'dead@x',
          outcome: 'error',
          processed_at: minutesAgo(1),
          attempts: INGEST_MAX_ATTEMPTS,
        }],
      });

      const { client, seen } = makeFakeClient(
        [{ uid: 24, messageId: '<dead@x>', from: 'alice@example.com', subject: 'Poisoned', date: null }],
        { 24: [{ filename: 'a.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(10) }] },
      );

      const result = await pollEmailIngest(async () => client);
      expect(result).toMatchObject({ checked: 1, ingested: 0, skipped: 1 });
      expect(intakeReceiptMock).not.toHaveBeenCalled();
      expect(seen).toEqual([24]);
    });

    // -----------------------------------------------------------------------
    // ASI-5-007: a failed message must be visible, correctly classified,
    // bounded in its retries, and recoverable — never a silent tombstone.
    // -----------------------------------------------------------------------
    describe('failure visibility and recovery', () => {
      const envelopeFor = (uid: number, key: string, subject = 'Receipt'): IngestEnvelope => ({
        uid, messageId: `<${key}>`, from: 'alice@example.com', subject, date: null,
      });
      const attachmentsFor = (uid: number) => ({
        [uid]: [{ filename: 'receipt.pdf', mimeType: 'application/pdf', content: Buffer.alloc(64) }],
      });

      /** Age a fake row far enough back that its retry backoff has elapsed. */
      function elapseBackoff(row: { processed_at: Date; attempts: number }) {
        row.processed_at = new Date(
          Date.now() - (retryBackoffMinutes(row.attempts) + 1) * 60_000,
        );
      }

      it('retries a transient failure and lets it succeed on a later attempt', async () => {
        const { rows } = primeStatefulDb({ senders: [senderRow] });
        intakeReceiptMock.mockResolvedValueOnce({
          ok: false, filename: 'receipt.pdf', error: 'ETIMEDOUT: upload timed out',
        });

        // Attempt 1 — the network was down.
        const first = makeFakeClient([envelopeFor(30, 'flaky@x')], attachmentsFor(30));
        const firstResult = await pollEmailIngest(async () => first.client);

        expect(firstResult).toMatchObject({
          checked: 1, ingested: 0, errors: 1, retrying: 1, failedPermanently: 0,
        });
        expect(rows[0]).toMatchObject({ outcome: INGEST_OUTCOME_RETRYING, attempts: 1 });
        // The reason is persisted, not just console.error'd.
        expect(rows[0].detail).toContain('upload timed out');
        expect(rows[0].detail).toContain('transient');
        // Left UNREAD so a later poll can pick it up again.
        expect(first.seen).toEqual([]);
        // Not terminal yet, so no error notification.
        expect(createNotificationMock).not.toHaveBeenCalled();

        // Still inside the backoff window: the next poll must not re-run it.
        const early = makeFakeClient([envelopeFor(30, 'flaky@x')], attachmentsFor(30));
        const earlyResult = await pollEmailIngest(async () => early.client);
        expect(earlyResult).toMatchObject({ checked: 1, ingested: 0, skipped: 1, errors: 0 });
        expect(intakeReceiptMock).toHaveBeenCalledTimes(1);
        expect(early.seen).toEqual([]);

        // Backoff elapses; attempt 2 succeeds.
        elapseBackoff(rows[0]);
        intakeReceiptMock.mockResolvedValue({ ok: true, id: 99, filename: 'receipt.pdf' });
        const second = makeFakeClient([envelopeFor(30, 'flaky@x')], attachmentsFor(30));
        const secondResult = await pollEmailIngest(async () => second.client);

        expect(secondResult).toMatchObject({ checked: 1, ingested: 1, errors: 0 });
        expect(rows[0]).toMatchObject({ outcome: 'ingested', attempts: 2 });
        expect(second.seen).toEqual([30]);
        expect(createNotificationMock).toHaveBeenCalledWith(
          expect.objectContaining({ severity: 'success' }),
        );
      });

      it('lands a permanent failure in an inspectable terminal state with its reason', async () => {
        const { rows } = primeStatefulDb({ senders: [senderRow] });
        intakeReceiptMock.mockResolvedValue({
          ok: false,
          filename: 'receipt.pdf',
          error: 'unsupported file type (must be JPEG, PNG, or PDF)',
        });

        const { client, seen } = makeFakeClient(
          [envelopeFor(31, 'bad@x', 'Corrupt receipt')], attachmentsFor(31),
        );
        const result = await pollEmailIngest(async () => client);

        expect(result).toMatchObject({
          checked: 1, ingested: 0, errors: 1, retrying: 0, failedPermanently: 1,
        });
        // Terminal on the FIRST attempt — no point retrying a bad file.
        expect(rows[0]).toMatchObject({ outcome: INGEST_OUTCOME_FAILED, attempts: 1 });
        expect(rows[0].detail).toContain('unsupported file type');
        expect(rows[0].detail).toContain('permanent failure');
        expect(intakeReceiptMock).toHaveBeenCalledTimes(1);

        // B3: a terminal failure IS flagged seen, so ordinary polls stop
        // selecting it. A manual retry re-finds it by Message-ID instead.
        expect(seen).toEqual([31]);

        // ...and the user is told, through the app's notification feed.
        expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
          userId: 42,
          bookGuid: 'book-1',
          type: 'email_ingest',
          severity: 'error',
          source: 'email-ingest',
        }));
        const notification = createNotificationMock.mock.calls[0][0];
        expect(notification.message).toContain('unsupported file type');
        expect(notification.message).toContain('Corrupt receipt');
      });

      it('notifies the user when no book is configured instead of dropping the mail', async () => {
        const { rows } = primeStatefulDb({
          senders: [{ ...senderRow, book_guid: null }],
        });

        const { client, seen } = makeFakeClient(
          [envelopeFor(32, 'nobook@x')], attachmentsFor(32),
        );
        const result = await pollEmailIngest(async () => client);

        expect(result).toMatchObject({ checked: 1, errors: 1, failedPermanently: 1 });
        expect(rows[0]).toMatchObject({ outcome: INGEST_OUTCOME_FAILED });
        expect(rows[0].detail).toContain('INGEST_DEFAULT_BOOK');
        expect(seen).toEqual([32]);
        expect(createNotificationMock).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 42, severity: 'error' }),
        );
      });

      it('bounds transient retries and then goes terminal, keeping the last reason', async () => {
        const { rows } = primeStatefulDb({ senders: [senderRow] });
        intakeReceiptMock.mockResolvedValue({
          ok: false, filename: 'receipt.pdf', error: 'ECONNRESET: connection reset by peer',
        });

        // Poll far more times than the budget allows; only INGEST_MAX_ATTEMPTS
        // of them may actually run the intake.
        for (let i = 0; i < INGEST_MAX_ATTEMPTS + 4; i++) {
          if (rows[0]) elapseBackoff(rows[0]); // pretend the wait elapsed
          const { client } = makeFakeClient([envelopeFor(33, 'dead@x')], attachmentsFor(33));
          await pollEmailIngest(async () => client);
        }

        expect(intakeReceiptMock).toHaveBeenCalledTimes(INGEST_MAX_ATTEMPTS);
        expect(rows[0]).toMatchObject({
          outcome: INGEST_OUTCOME_FAILED,
          attempts: INGEST_MAX_ATTEMPTS,
        });
        expect(rows[0].detail).toContain('connection reset by peer');
        expect(rows[0].detail).toContain(`${INGEST_MAX_ATTEMPTS} attempts`);
        // Exactly one terminal notification, not one per poll.
        expect(createNotificationMock).toHaveBeenCalledTimes(1);
      });

      it('flags an already-terminal failure seen so ordinary polls stop selecting it', async () => {
        primeStatefulDb({
          senders: [senderRow],
          messages: [{
            message_key: 'terminal@x',
            outcome: INGEST_OUTCOME_FAILED,
            detail: 'unsupported file type — permanent failure, no automatic retry',
            processed_at: minutesAgo(120),
            attempts: 1,
          }],
        });

        const { client, seen } = makeFakeClient(
          [envelopeFor(34, 'terminal@x')], attachmentsFor(34),
        );
        const result = await pollEmailIngest(async () => client);

        expect(result).toMatchObject({ checked: 1, ingested: 0, skipped: 1, errors: 0 });
        expect(intakeReceiptMock).not.toHaveBeenCalled();
        expect(client.fetchAttachments).not.toHaveBeenCalled();
        // B3 (was: left unread, which re-listed it on EVERY poll forever).
        // It is now flagged seen, so the next poll does not select it at all.
        expect(seen).toEqual([34]);
      });

      it('never re-lists a terminal failure once it has been flagged seen', async () => {
        primeStatefulDb({
          senders: [senderRow],
          messages: [{
            message_key: 'gone@x',
            outcome: INGEST_OUTCOME_FAILED,
            processed_at: minutesAgo(120),
            attempts: 1,
          }],
        });

        // Second poll: the message is flagged seen, so listUnseen no longer
        // offers it at all — the poller does no work for it, ever again.
        const { client } = makeFakeClient([], {});
        const result = await pollEmailIngest(async () => client);

        expect(result).toMatchObject({ checked: 0, skipped: 0, errors: 0 });
        expect(client.fetchAttachments).not.toHaveBeenCalled();
      });

      it('never retries a partial success, so a retry cannot duplicate a document', async () => {
        const { rows } = primeStatefulDb({ senders: [senderRow] });
        intakeReceiptMock
          .mockResolvedValueOnce({ ok: true, id: 1, filename: 'good.pdf' })
          .mockResolvedValueOnce({ ok: false, filename: 'bad.pdf', error: 'ECONNRESET: reset' });

        const envelope: IngestEnvelope = {
          uid: 36, messageId: '<partial@x>', from: 'alice@example.com', subject: 'Two files', date: null,
        };
        const attachments = {
          36: [
            { filename: 'good.pdf', mimeType: 'application/pdf', content: Buffer.alloc(10) },
            { filename: 'bad.pdf', mimeType: 'application/pdf', content: Buffer.alloc(10) },
          ],
        };

        const first = makeFakeClient([envelope], attachments);
        const firstResult = await pollEmailIngest(async () => first.client);

        // One document landed, so the message is DONE even though the second
        // attachment failed transiently — replaying it would re-ingest good.pdf.
        expect(firstResult).toMatchObject({ checked: 1, ingested: 1, errors: 0 });
        expect(rows[0]).toMatchObject({ outcome: 'ingested' });
        expect(rows[0].detail).toContain('bad.pdf');
        expect(first.seen).toEqual([36]);
        // The gap is still visible — a warning, not a silent success.
        expect(createNotificationMock).toHaveBeenCalledWith(
          expect.objectContaining({ severity: 'warning' }),
        );

        // A later poll re-listing the same message must not touch intake again.
        const second = makeFakeClient([envelope], attachments);
        await pollEmailIngest(async () => second.client);
        expect(intakeReceiptMock).toHaveBeenCalledTimes(2);
      });

      // ---------------------------------------------------------------
      // B2: a mailbox hiccup must never downgrade a recorded success
      // ---------------------------------------------------------------
      it('does not turn a persisted success into a retryable failure when markSeen throws', async () => {
        const { rows } = primeStatefulDb({ senders: [senderRow] });
        intakeReceiptMock.mockResolvedValue({ ok: true, id: 5, filename: 'receipt.pdf' });

        const { client } = makeFakeClient([envelopeFor(50, 'flagfail@x')], attachmentsFor(50));
        (client.markSeen as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('ECONNRESET: mailbox connection dropped'),
        );

        const result = await pollEmailIngest(async () => client);

        // The documents landed, so the message is a success, full stop.
        expect(result).toMatchObject({ checked: 1, ingested: 1, errors: 0, retrying: 0 });
        expect(rows[0]).toMatchObject({ outcome: 'ingested' });
        expect(rows[0].detail).toContain('Ingested');

        // And the next poll must not replay it, which a downgrade to 'error'
        // would have caused (the transient predicate would have reclaimed it).
        const second = makeFakeClient([envelopeFor(50, 'flagfail@x')], attachmentsFor(50));
        const secondResult = await pollEmailIngest(async () => second.client);
        expect(secondResult).toMatchObject({ checked: 1, ingested: 0, skipped: 1 });
        expect(intakeReceiptMock).toHaveBeenCalledTimes(1);
      });

      /**
       * markSeenQuietly is the PRIMARY defence for B2 and is proven
       * behaviourally by the test above. The WHERE guard on the failure
       * upsert is defence-in-depth for any future post-success throw, and is
       * unreachable today — so it is pinned by its SQL text rather than left
       * silently untested.
       */
      it('emits a failure upsert that cannot overwrite a recorded success', async () => {
        const { queries } = primeStatefulDb({ senders: [senderRow] });
        intakeReceiptMock.mockResolvedValue({
          ok: false, filename: 'receipt.pdf', error: 'unsupported file type',
        });
        const { client } = makeFakeClient([envelopeFor(52, 'guard@x')], attachmentsFor(52));
        await pollEmailIngest(async () => client);

        const failureUpsert = queries.find(q =>
          q.includes('INSERT INTO gnucash_web_ingest_messages')
          && q.includes('WHERE gnucash_web_ingest_messages.outcome <> '));
        expect(failureUpsert).toBeDefined();
        const blockedValue = db.$executeRaw.mock.calls
          .find((c: unknown[]) => (c[0] as TemplateStringsArray).join('?')
            .includes('WHERE gnucash_web_ingest_messages.outcome <> '))
          ?.slice(1)
          .at(-1);
        expect(blockedValue).toBe('ingested');
      });

      it('does not downgrade a success when the notification write throws', async () => {
        const { rows } = primeStatefulDb({ senders: [senderRow] });
        intakeReceiptMock.mockResolvedValue({ ok: true, id: 6, filename: 'receipt.pdf' });
        // ...Once, not permanently: clearAllMocks does not reset implementations.
        createNotificationMock.mockRejectedValueOnce(new Error('notification store down'));

        const { client } = makeFakeClient([envelopeFor(51, 'notifyfail@x')], attachmentsFor(51));
        const result = await pollEmailIngest(async () => client);

        expect(result).toMatchObject({ ingested: 1, errors: 0 });
        expect(rows[0]).toMatchObject({ outcome: 'ingested' });
      });

      // ---------------------------------------------------------------
      // B1: the crash window. This documents REAL, PRE-EXISTING behaviour
      // (see the module header) — the fix here is the BOUND, not the
      // duplicate. Content-addressed intake + per-attachment checkpointing
      // is tracked separately; when it lands, the duplicate assertion below
      // is the one that should be tightened.
      // ---------------------------------------------------------------
      it('replays attachments after a crash mid-message, but only a bounded number of times', async () => {
        const { rows } = primeStatefulDb({
          senders: [senderRow],
          // A worker claimed this message, ingested attachment 1, then died
          // before recording the outcome: the row is stuck in 'processing'.
          messages: [{
            message_key: 'crash@x',
            from_email: 'alice@example.com',
            subject: 'Two receipts',
            outcome: 'processing',
            processed_at: minutesAgo(INGEST_CLAIM_STALE_MINUTES + 1),
            attempts: 1,
          }],
        });
        intakeReceiptMock.mockResolvedValue({ ok: true, id: 8, filename: 'first.pdf' });

        const envelope: IngestEnvelope = {
          uid: 60, messageId: '<crash@x>', from: 'alice@example.com', subject: 'Two receipts', date: null,
        };
        const attachments = {
          60: [{ filename: 'first.pdf', mimeType: 'application/pdf', content: Buffer.alloc(10) }],
        };

        const { client } = makeFakeClient([envelope], attachments);
        const result = await pollEmailIngest(async () => client);

        // KNOWN GAP: first.pdf is ingested a SECOND time. There is no
        // per-attachment checkpoint, and the "ingested" record is exactly
        // what the crash destroyed, so the poller cannot tell.
        expect(result).toMatchObject({ ingested: 1 });
        expect(intakeReceiptMock).toHaveBeenCalledTimes(1);
        expect(rows[0]).toMatchObject({ outcome: 'ingested', attempts: 2 });
      });

      it('stops replaying a crash-looping claim without rewriting the live row', async () => {
        const { rows } = primeStatefulDb({
          senders: [senderRow],
          messages: [{
            message_key: 'crashloop@x',
            from_email: 'alice@example.com',
            subject: 'Cursed receipt',
            outcome: 'processing',
            processed_at: minutesAgo(INGEST_CLAIM_STALE_MINUTES + 1),
            // Budget already spent by earlier crashed attempts.
            attempts: INGEST_MAX_ATTEMPTS,
          }],
        });

        const first = makeFakeClient([envelopeFor(61, 'crashloop@x')], attachmentsFor(61));
        const result = await pollEmailIngest(async () => first.client);

        // Not replayed a fourth time — the attempt bound refuses the claim.
        expect(intakeReceiptMock).not.toHaveBeenCalled();
        expect(first.client.fetchAttachments).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ingested: 0, skipped: 1 });

        // Deliberately NOT transitioned: an overdue claim is not proof its
        // worker died, and a write here would race that worker's own final
        // write. The row stays exactly as it was, and listIngestAttention
        // reports it as `stalled`.
        expect(rows[0]).toMatchObject({ outcome: 'processing', attempts: INGEST_MAX_ATTEMPTS });
        expect(rows[0].detail).toBeUndefined();

        // But the MAILBOX flag is settled, so the message is not handed back on
        // every poll from now until the end of time. Same shape as the
        // terminal-failure case: the next poll does no work for it at all.
        expect(first.seen).toEqual([61]);
        const second = makeFakeClient([], {});
        const secondResult = await pollEmailIngest(async () => second.client);
        expect(secondResult).toMatchObject({ checked: 0, skipped: 0, errors: 0 });
        expect(rows[0]).toMatchObject({ outcome: 'processing', attempts: INGEST_MAX_ATTEMPTS });
      });

      // ---------------------------------------------------------------
      // Attention list: scoped to the requester, honest about its cap
      // ---------------------------------------------------------------
      describe('listIngestAttention', () => {
        const OWNER_ID = 42;
        const OTHER_USER_ID = 99;
        const failedRow = (key: string, from = 'alice@example.com') => ({
          message_key: key,
          from_email: from,
          subject: `Subject ${key}`,
          outcome: INGEST_OUTCOME_FAILED,
          detail: 'unsupported file type — permanent failure, no automatic retry',
          processed_at: minutesAgo(30),
          attempts: 1,
        });

        it('reports terminal failures with their reason', async () => {
          primeStatefulDb({ senders: [senderRow], messages: [failedRow('a@x')] });

          const attention = await listIngestAttention(OWNER_ID);
          expect(attention.failedTotal).toBe(1);
          expect(attention.stalledTotal).toBe(0);
          expect(attention.truncated).toBe(false);
          expect(attention.items[0]).toMatchObject({ category: 'failed' });
          expect(attention.items[0].detail).toContain('unsupported file type');
        });

        it('surfaces an exhausted in-flight claim as stalled rather than rewriting it', async () => {
          const { rows } = primeStatefulDb({
            senders: [senderRow],
            messages: [{
              message_key: 'stuck@x',
              from_email: 'alice@example.com',
              subject: 'Stuck',
              outcome: 'processing',
              detail: 'Reclaimed after stale or failed attempt',
              processed_at: minutesAgo(INGEST_CLAIM_STALE_MINUTES + 60),
              attempts: INGEST_MAX_ATTEMPTS,
            }],
          });

          const attention = await listIngestAttention(OWNER_ID);
          expect(attention.stalledTotal).toBe(1);
          expect(attention.items[0]).toMatchObject({ category: 'stalled', outcome: 'processing' });
          expect(attention.items[0].detail).toContain('retry budget is spent');
          // Read-only: the row is untouched, so a slow-but-live worker is safe.
          expect(rows[0]).toMatchObject({ outcome: 'processing', attempts: INGEST_MAX_ATTEMPTS });
        });

        it('leaves a claim alone while it still has budget or is still fresh', async () => {
          primeStatefulDb({
            senders: [senderRow],
            messages: [
              // Overdue but budget remains — claimIngestMessage will retry it.
              {
                message_key: 'retryable@x', from_email: 'alice@example.com',
                outcome: 'processing', processed_at: minutesAgo(INGEST_CLAIM_STALE_MINUTES + 5),
                attempts: 1,
              },
              // Budget spent but recently touched — very likely still running.
              {
                message_key: 'fresh@x', from_email: 'alice@example.com',
                outcome: 'processing', processed_at: minutesAgo(1),
                attempts: INGEST_MAX_ATTEMPTS,
              },
            ],
          });

          const attention = await listIngestAttention(OWNER_ID);
          expect(attention.stalledTotal).toBe(0);
          expect(attention.items).toEqual([]);
        });

        it('shows only the requester\'s own messages', async () => {
          primeStatefulDb({
            senders: [senderRow], // alice@example.com belongs to user 42
            messages: [failedRow('mine@x'), failedRow('theirs@x', 'mallory@elsewhere.com')],
          });

          const mine = await listIngestAttention(OWNER_ID);
          expect(mine.failedTotal).toBe(1);
          expect(mine.items[0].messageKey).toBe('mine@x');

          // A user with no allowlist entries sees nothing at all.
          const theirs = await listIngestAttention(OTHER_USER_ID);
          expect(theirs).toMatchObject({ failedTotal: 0, stalledTotal: 0, items: [] });
        });

        it('matches the sender allowlist the way the poller does', async () => {
          // Stored from_email is plus-tagged and mixed case; the allowlist is not.
          primeStatefulDb({
            senders: [senderRow],
            messages: [failedRow('tagged@x', 'Alice+receipts@Example.com')],
          });
          const attention = await listIngestAttention(OWNER_ID);
          expect(attention.failedTotal).toBe(1);
        });

        it('reports a category the LIMIT excluded entirely', async () => {
          // The newest rows are all `failed` and will fill the page; the only
          // `stalled` row is older and cannot survive the LIMIT. A
          // PARTITION BY category window would report stalledTotal = 0 here.
          primeStatefulDb({
            senders: [senderRow],
            messages: [
              ...Array.from({ length: 3 }, (_, i) => ({
                ...failedRow(`recent-${i}@x`),
                processed_at: minutesAgo(5 + i),
              })),
              {
                message_key: 'old-stall@x',
                from_email: 'alice@example.com',
                subject: 'Older stalled claim',
                outcome: 'processing',
                processed_at: minutesAgo(INGEST_CLAIM_STALE_MINUTES + 600),
                attempts: INGEST_MAX_ATTEMPTS,
              },
            ],
          });

          const attention = await listIngestAttention(OWNER_ID, 3);
          expect(attention.items).toHaveLength(3);
          expect(attention.items.every(i => i.category === 'failed')).toBe(true);
          // The stalled row is off the page but MUST still be counted.
          expect(attention.failedTotal).toBe(3);
          expect(attention.stalledTotal).toBe(1);
          expect(attention.truncated).toBe(true);
        });

        /**
         * As with the claim predicate, the stateful fake MIRRORS this query's
         * scoping and staleness rules rather than executing them, so the
         * behavioural tests above cannot prove the production SQL still
         * carries them. These assertions pin the emitted statement.
         */
        it('emits a query scoped to the requester and gated on the stale window', async () => {
          const { queries } = primeStatefulDb({
            senders: [senderRow], messages: [failedRow('sql@x')],
          });
          await listIngestAttention(OWNER_ID, 10);

          const sql = queries.find(q => q.includes('WITH scoped AS'));
          expect(sql).toBeDefined();
          const normalized = sql!.replace(/\s+/g, ' ');

          // Requester scoping — without this every user sees every failure.
          expect(normalized).toContain(
            "regexp_replace(lower(from_email), ?, '@') = ANY(?::text[])",
          );
          // Stalled category is gated on BOTH a spent budget and elapsed time,
          // so a fresh in-flight claim is never reported as stalled.
          expect(normalized).toMatch(
            /outcome = 'processing' AND attempts >= \? AND processed_at < \(NOW\(\) - \? \* INTERVAL '1 minute'\)/,
          );
          // Totals come from UNPARTITIONED windows evaluated BEFORE the LIMIT.
          // Partitioning by category would report zero for whichever category
          // the truncated page happened to exclude.
          expect(normalized).toContain(
            "COUNT(*) FILTER (WHERE category = 'failed') OVER ()",
          );
          expect(normalized).toContain(
            "COUNT(*) FILTER (WHERE category = 'stalled') OVER ()",
          );
          expect(normalized).not.toContain('PARTITION BY category');

          const call = db.$queryRaw.mock.calls.find(
            (c: unknown[]) => (c[0] as TemplateStringsArray).join('?').includes('WITH scoped AS'));
          expect(call?.slice(1)).toContain(INGEST_CLAIM_STALE_MINUTES);
          expect(call?.slice(1)).toContain(INGEST_MAX_ATTEMPTS);
          // The scoping array actually bound is the requester's own senders.
          expect(call?.slice(1)).toContainEqual(['alice@example.com']);
        });

        it('reports the TRUE total when the list is capped', async () => {
          primeStatefulDb({
            senders: [senderRow],
            messages: Array.from({ length: 7 }, (_, i) => failedRow(`bulk-${i}@x`)),
          });

          const attention = await listIngestAttention(OWNER_ID, 3);
          expect(attention.items).toHaveLength(3);
          // The whole point: the caller learns there are 7, not 3.
          expect(attention.failedTotal).toBe(7);
          expect(attention.truncated).toBe(true);
        });
      });

      it('persists the reason when the whole message throws', async () => {
        const { rows } = primeStatefulDb({ senders: [senderRow] });

        const { client, seen } = makeFakeClient([envelopeFor(37, 'throw@x')], {});
        (client.fetchAttachments as ReturnType<typeof vi.fn>).mockRejectedValue(
          Object.assign(new Error('getaddrinfo EAI_AGAIN imap.example.com'), { code: 'EAI_AGAIN' }),
        );

        const result = await pollEmailIngest(async () => client);

        expect(result).toMatchObject({ checked: 1, errors: 1, retrying: 1 });
        expect(rows[0]).toMatchObject({ outcome: INGEST_OUTCOME_RETRYING });
        expect(rows[0].detail).toContain('EAI_AGAIN');
        expect(seen).toEqual([]);
      });
    });
  });
});
