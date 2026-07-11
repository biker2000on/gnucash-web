import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStatementExtraction } from '../statement-ingest';
import * as statementService from '../services/statement.service';
import { getStorageBackend } from '../storage/storage-backend';
import { getAiConfig } from '../ai-config';
import { extractTextFromPdf } from '../pdf-text-extract';
import { extractStatementFromText } from '../statement-parse/ai-extract';

// Mock the service (DB) layer — we assert on how the orchestrator calls it.
vi.mock('../services/statement.service', () => ({
  getBatch: vi.fn(),
  setBatchStatus: vi.fn().mockResolvedValue(null),
  replaceLines: vi.fn().mockResolvedValue(0),
  upsertStatementAcctMap: vi.fn().mockResolvedValue(undefined),
  getMappedAccountGuid: vi.fn().mockResolvedValue(null),
}));

// Mock storage so no filesystem/S3 access happens.
const storageGet = vi.fn();
vi.mock('../storage/storage-backend', () => ({
  getStorageBackend: vi.fn(),
}));

// Mock the PDF/AI dependencies (deterministic csv/ofx parsers run for real).
vi.mock('../ai-config', () => ({ getAiConfig: vi.fn() }));
vi.mock('../pdf-text-extract', () => ({ extractTextFromPdf: vi.fn() }));
vi.mock('../statement-parse/ai-extract', () => ({ extractStatementFromText: vi.fn() }));

const batchBase = {
  id: 1,
  bookGuid: 'book1',
  accountGuid: null,
  originalFilename: 'stmt',
  storageKey: 'key/stmt',
  thumbnailKey: null,
  status: 'uploaded' as const,
  statementStartDate: null,
  statementEndDate: null,
  openingBalance: null,
  closingBalance: null,
  currency: null,
  ofxAcctId: null,
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStorageBackend).mockResolvedValue({
    get: storageGet,
    put: vi.fn(),
    delete: vi.fn(),
    getUrl: vi.fn(),
  } as never);
});

describe('runStatementExtraction — CSV', () => {
  it('parses a CSV batch, writes lines, and marks it parsed with period', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'csv' });
    const csv = 'Date,Description,Amount\n2024-03-01,Paycheck,2500.00\n2024-03-02,Store,-30.00\n';
    storageGet.mockResolvedValue(Buffer.from(csv, 'utf-8'));

    await runStatementExtraction(1, 'book1', '[test]');

    expect(statementService.replaceLines).toHaveBeenCalledTimes(1);
    const [batchId, lines] = vi.mocked(statementService.replaceLines).mock.calls[0];
    expect(batchId).toBe(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ date: '2024-03-01', amount: 2500 });

    // Last setBatchStatus call marks it parsed with the derived period.
    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    const last = calls[calls.length - 1];
    expect(last[1]).toBe('parsed');
    expect(last[2]).toMatchObject({ statementStartDate: '2024-03-01', statementEndDate: '2024-03-02' });
  });

  it('marks the batch as error when the CSV has no recognizable transactions', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'csv' });
    storageGet.mockResolvedValue(Buffer.from('garbage with no structure', 'utf-8'));

    await runStatementExtraction(1, 'book1', '[test]');

    expect(statementService.replaceLines).not.toHaveBeenCalled();
    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    const last = calls[calls.length - 1];
    expect(last[1]).toBe('error');
    expect(String(last[2]?.error)).toContain('No transactions');
  });
});

describe('runStatementExtraction — OFX', () => {
  it('parses an OFX batch into signed lines', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'ofx' });
    const ofx = `<OFX><STMTTRN><DTPOSTED>20240301<TRNAMT>-19.99<NAME>Netflix</NAME></STMTTRN></OFX>`;
    storageGet.mockResolvedValue(Buffer.from(ofx, 'utf-8'));

    await runStatementExtraction(1, 'book1', '[test]');

    const [, lines] = vi.mocked(statementService.replaceLines).mock.calls[0];
    expect(lines[0]).toMatchObject({ date: '2024-03-01', amount: -19.99, description: 'Netflix' });
  });

  const OFX_WITH_ACCTID =
    `<OFX><BANKACCTFROM><ACCTID>123456789</ACCTID></BANKACCTFROM>` +
    `<STMTTRN><DTPOSTED>20240301<TRNAMT>-19.99<NAME>Netflix</NAME></STMTTRN></OFX>`;

  it('stores the detected ACCTID and remembers the pairing when the batch has an account', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({
      ...batchBase, source: 'ofx', accountGuid: 'acct-1',
    });
    storageGet.mockResolvedValue(Buffer.from(OFX_WITH_ACCTID, 'utf-8'));

    await runStatementExtraction(1, 'book1', '[test]');

    expect(statementService.upsertStatementAcctMap).toHaveBeenCalledWith('book1', '123456789', 'acct-1');
    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    const last = calls[calls.length - 1];
    expect(last[1]).toBe('parsed');
    expect(last[2]).toMatchObject({ ofxAcctId: '123456789' });
    expect(last[2]).not.toHaveProperty('accountGuid'); // already assigned — no patch
  });

  it('auto-assigns the account from a remembered mapping when the batch has none', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'ofx' });
    vi.mocked(statementService.getMappedAccountGuid).mockResolvedValueOnce('acct-mapped');
    storageGet.mockResolvedValue(Buffer.from(OFX_WITH_ACCTID, 'utf-8'));

    await runStatementExtraction(1, 'book1', '[test]');

    expect(statementService.getMappedAccountGuid).toHaveBeenCalledWith('book1', '123456789');
    expect(statementService.upsertStatementAcctMap).not.toHaveBeenCalled();
    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    const last = calls[calls.length - 1];
    expect(last[2]).toMatchObject({ ofxAcctId: '123456789', accountGuid: 'acct-mapped' });
  });

  it('leaves the batch unassigned when the ACCTID has no mapping yet', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'ofx' });
    storageGet.mockResolvedValue(Buffer.from(OFX_WITH_ACCTID, 'utf-8'));

    await runStatementExtraction(1, 'book1', '[test]');

    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    const last = calls[calls.length - 1];
    expect(last[1]).toBe('parsed');
    expect(last[2]).toMatchObject({ ofxAcctId: '123456789' });
    expect(last[2]).not.toHaveProperty('accountGuid');
  });

  it('records a null ofxAcctId when the OFX file has no ACCTID', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'ofx' });
    const ofx = `<OFX><STMTTRN><DTPOSTED>20240301<TRNAMT>-19.99<NAME>Netflix</NAME></STMTTRN></OFX>`;
    storageGet.mockResolvedValue(Buffer.from(ofx, 'utf-8'));

    await runStatementExtraction(1, 'book1', '[test]');

    expect(statementService.getMappedAccountGuid).not.toHaveBeenCalled();
    expect(statementService.upsertStatementAcctMap).not.toHaveBeenCalled();
    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    expect(calls[calls.length - 1][2]).toMatchObject({ ofxAcctId: null });
  });
});

describe('runStatementExtraction — PDF (AI)', () => {
  it('extracts text then calls AI and stores the returned lines', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'pdf' });
    storageGet.mockResolvedValue(Buffer.from('%PDF-1.4 fake', 'utf-8'));
    vi.mocked(extractTextFromPdf).mockResolvedValue('some statement text');
    vi.mocked(getAiConfig).mockResolvedValue({
      provider: 'custom', base_url: 'http://ai', api_key: null, model: 'm', enabled: true,
    });
    vi.mocked(extractStatementFromText).mockResolvedValue({
      startDate: '2024-03-01',
      endDate: '2024-03-31',
      currency: 'USD',
      lines: [{ date: '2024-03-10', description: 'Amazon', amount: -42.0 }],
    });

    await runStatementExtraction(1, 'book1', '[test]', 7);

    expect(extractTextFromPdf).toHaveBeenCalled();
    expect(getAiConfig).toHaveBeenCalledWith(7);
    const [, lines] = vi.mocked(statementService.replaceLines).mock.calls[0];
    expect(lines[0]).toMatchObject({ date: '2024-03-10', amount: -42 });
    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    expect(calls[calls.length - 1][2]).toMatchObject({ currency: 'USD' });
  });

  it('records an error (and does not throw) when AI is disabled', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'pdf' });
    storageGet.mockResolvedValue(Buffer.from('%PDF-1.4 fake', 'utf-8'));
    vi.mocked(extractTextFromPdf).mockResolvedValue('text');
    vi.mocked(getAiConfig).mockResolvedValue(null);
    vi.mocked(extractStatementFromText).mockRejectedValue(new Error('AI is not configured.'));

    await expect(runStatementExtraction(1, 'book1', '[test]')).resolves.toBeUndefined();

    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    expect(calls[calls.length - 1][1]).toBe('error');
  });
});

describe('runStatementExtraction — resilience', () => {
  it('does nothing (no throw) when the batch is missing', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue(null);
    await expect(runStatementExtraction(99, 'book1', '[test]')).resolves.toBeUndefined();
    expect(statementService.setBatchStatus).not.toHaveBeenCalled();
  });

  it('records an error when storage retrieval fails', async () => {
    vi.mocked(statementService.getBatch).mockResolvedValue({ ...batchBase, source: 'csv' });
    storageGet.mockRejectedValue(new Error('storage down'));

    await expect(runStatementExtraction(1, 'book1', '[test]')).resolves.toBeUndefined();
    const calls = vi.mocked(statementService.setBatchStatus).mock.calls;
    const last = calls[calls.length - 1];
    expect(last[1]).toBe('error');
    expect(String(last[2]?.error)).toContain('storage down');
  });
});
