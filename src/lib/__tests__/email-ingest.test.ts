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
        if (sql.includes('FROM gnucash_web_ingest_senders')) {
          return Promise.resolve(options.senders ?? []);
        }
        if (sql.includes('FROM gnucash_web_ingest_messages')) {
          return Promise.resolve((options.processedKeys ?? []).map(k => ({ message_key: k })));
        }
        return Promise.resolve([]);
      });
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
  });
});
