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
  INGEST_OUTCOME_RETRYING,
  INGEST_OUTCOME_RETRY_REQUESTED,
  classifyIngestFailure,
  describeIngestError,
  requestIngestRetry,
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
  describe('pollEmailIngest', () => {
    const ENV = { INGEST_IMAP_HOST: 'imap.example.com', INGEST_IMAP_USER: 'u', INGEST_IMAP_PASS: 'p' };
    const savedEnv: Record<string, string | undefined> = {};

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
        if (sql.includes('FROM gnucash_web_ingest_messages')) {
          return Promise.resolve(
            (options.processedKeys ?? []).map(k => ({
              message_key: k,
              outcome: 'ingested',
              attempts: 1,
            })),
          );
        }
        return Promise.resolve([]);
      });
    }

    interface FakeMessageRow {
      message_key: string;
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
     */
    function primeStatefulDb(options: { senders?: unknown[]; messages?: FakeMessageRow[] }) {
      const rows: FakeMessageRow[] = (options.messages ?? []).map(row => ({ ...row }));
      const queries: string[] = [];

      db.$executeRawUnsafe.mockResolvedValue(0); // ensure tables

      // recordProcessedMessage: finalizes (or inserts) the row.
      // requestIngestRetry: re-arms a terminally failed row.
      db.$executeRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        queries.push(sql);
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
            rows.push({ message_key: key, outcome, detail, processed_at: new Date(), attempts: 0 });
          }
        }
        if (sql.includes('UPDATE gnucash_web_ingest_messages')) {
          // SET outcome = ?, ... WHERE id = ? AND outcome = ?
          const requested = values[0] as string;
          const id = values[1] as number;
          const requiredOutcome = values[2] as string;
          // The fake indexes rows positionally; `id` is 1-based.
          const target = rows[id - 1];
          if (!target || target.outcome !== requiredOutcome) return Promise.resolve(0);
          target.outcome = requested;
          target.attempts = 0;
          target.detail = 'Manual retry requested; queued for the next mailbox poll';
          target.processed_at = new Date();
          return Promise.resolve(1);
        }
        return Promise.resolve(1);
      });

      db.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        queries.push(sql);

        // claimIngestMessage: INSERT ... ON CONFLICT DO UPDATE ... WHERE
        // stale-claim OR (transient error AND budget left AND backoff elapsed)
        // OR user-requested retry.
        if (sql.includes('INSERT INTO gnucash_web_ingest_messages')) {
          const key = values[0] as string;
          const staleMinutes = values[3] as number;
          const maxAttempts = values[4] as number;
          const backoffBase = values[5] as number;
          const retryRequested = values[6] as string;
          const existing = rows.find(r => r.message_key === key);
          if (!existing) {
            rows.push({ message_key: key, outcome: 'processing', processed_at: new Date(), attempts: 1 });
            return Promise.resolve([{ message_key: key, attempts: 1 }]);
          }
          const staleBefore = minutesAgo(staleMinutes);
          // Mirrors the SQL: base * 2^(attempts - 1), floored at attempts = 1.
          const backoffFor = (attempts: number) =>
            backoffBase * Math.pow(2, Math.max(attempts - 1, 0));
          const reclaimable =
            (existing.outcome === 'processing' && existing.processed_at < staleBefore)
            || (existing.outcome === 'error'
              && existing.attempts < maxAttempts
              && existing.processed_at < minutesAgo(backoffFor(existing.attempts)))
            || existing.outcome === retryRequested;
          if (!reclaimable) return Promise.resolve([]); // live claim / backing off
          existing.outcome = 'processing';
          existing.processed_at = new Date();
          existing.attempts += 1;
          return Promise.resolve([{ message_key: key, attempts: existing.attempts }]);
        }

        if (sql.includes('FROM gnucash_web_ingest_senders')) {
          return Promise.resolve(options.senders ?? []);
        }

        // getIngestMessageStates: finished rows only.
        if (sql.includes('FROM gnucash_web_ingest_messages')) {
          const keys = values[0] as string[];
          const retryRequested = values[1] as string;
          const maxAttempts = values[2] as number;
          return Promise.resolve(
            rows
              .filter(r =>
                keys.includes(r.message_key)
                && r.outcome !== 'processing'
                && r.outcome !== retryRequested
                && !(r.outcome === 'error' && r.attempts < maxAttempts))
              .map(r => ({ message_key: r.message_key, outcome: r.outcome, attempts: r.attempts })),
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

      const selectSql = queries.find(q =>
        q.includes('SELECT message_key, outcome, attempts FROM gnucash_web_ingest_messages'));
      expect(selectSql).toContain("outcome <> 'processing'");
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

        // Left unread so the user's manual retry has something to re-fetch.
        expect(seen).toEqual([]);

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
        expect(seen).toEqual([]);
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

      it('skips an already-terminal failure without side effects or marking it seen', async () => {
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
        // Deliberately still unread: this is the retry surface.
        expect(seen).toEqual([]);
      });

      it('re-arms a terminal failure on request and reprocesses it on the next poll', async () => {
        const { rows } = primeStatefulDb({
          senders: [senderRow],
          messages: [{
            message_key: 'rearm@x',
            outcome: INGEST_OUTCOME_FAILED,
            detail: 'ECONNRESET — gave up after 3 of 3 attempts',
            processed_at: minutesAgo(120),
            attempts: INGEST_MAX_ATTEMPTS,
          }],
        });

        expect(await requestIngestRetry(1)).toBe(true);
        expect(rows[0]).toMatchObject({ outcome: INGEST_OUTCOME_RETRY_REQUESTED, attempts: 0 });

        intakeReceiptMock.mockResolvedValue({ ok: true, id: 77, filename: 'receipt.pdf' });
        const { client, seen } = makeFakeClient(
          [envelopeFor(35, 'rearm@x')], attachmentsFor(35),
        );
        const result = await pollEmailIngest(async () => client);

        expect(result).toMatchObject({ checked: 1, ingested: 1, errors: 0 });
        expect(rows[0]).toMatchObject({ outcome: 'ingested', attempts: 1 });
        expect(seen).toEqual([35]);
      });

      it('refuses to re-arm anything that is not a terminal failure', async () => {
        primeStatefulDb({
          senders: [senderRow],
          messages: [{
            message_key: 'done@x',
            outcome: 'ingested',
            processed_at: minutesAgo(5),
            attempts: 1,
          }],
        });
        // Re-ingesting a succeeded message would duplicate its documents.
        expect(await requestIngestRetry(1)).toBe(false);
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
