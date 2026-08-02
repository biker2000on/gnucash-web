import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueExtractStatement: vi.fn(),
  getBatch: vi.fn(),
  setBatchStatus: vi.fn(),
}));
vi.mock('../queues', () => ({ enqueueExtractStatement: mocks.enqueueExtractStatement }));
vi.mock('@/lib/services/statement.service', () => ({
  getBatch: mocks.getBatch,
  setBatchStatus: mocks.setBatchStatus,
}));
import {
  MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS,
  formatStatementRecoveryError,
  nextStatementRecoveryAttempt,
  parseStatementRecoveryState,
  scheduleStatementRecovery,
} from '../statement-recovery';

const NOW = new Date('2026-08-02T16:00:00.000Z');

function batch(overrides: Record<string, unknown> = {}) {
  return {
    source: 'pdf' as const,
    status: 'error' as const,
    error: 'Cannot find PDF.js worker module',
    updatedAt: new Date('2026-08-02T15:00:00.000Z'),
    ...overrides,
  };
}

describe('statement automatic recovery policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueExtractStatement.mockImplementation(async data => `job-${data.batchId}`);
    mocks.setBatchStatus.mockResolvedValue(null);
  });

  it('selects old PDF errors and stuck parsing batches but not fresh or non-PDF errors', () => {
    expect(nextStatementRecoveryAttempt(batch(), NOW)).toBe(1);
    expect(nextStatementRecoveryAttempt(batch({ status: 'parsing' }), NOW)).toBe(1);
    expect(nextStatementRecoveryAttempt(batch({ source: 'csv' }), NOW)).toBeNull();
    expect(nextStatementRecoveryAttempt(batch({ updatedAt: new Date('2026-08-02T15:55:00.000Z') }), NOW)).toBeNull();
  });

  it('records and respects retry backoff', () => {
    const next = new Date('2026-08-02T16:15:00.000Z');
    const error = formatStatementRecoveryError('PDF failed', 1, next);
    expect(parseStatementRecoveryState(error)).toEqual({
      attempt: 1,
      nextRetryAt: next,
      message: 'PDF failed',
    });
    expect(nextStatementRecoveryAttempt(batch({ error }), NOW)).toBeNull();
    expect(nextStatementRecoveryAttempt(batch({ error, updatedAt: new Date('2026-08-02T15:00:00.000Z') }), new Date('2026-08-02T16:16:00.000Z'))).toBe(2);
  });

  it('never schedules beyond the bounded retry budget', () => {
    const exhausted = formatStatementRecoveryError(
      'Still broken',
      MAX_STATEMENT_AUTO_RECOVERY_ATTEMPTS,
      null,
    );
    expect(nextStatementRecoveryAttempt(batch({ error: exhausted }), NOW)).toBeNull();
    expect(parseStatementRecoveryState(exhausted).attempt).toBe(2);
  });

  it('uses deterministic job IDs, records the attempt, and limits each sweep', async () => {
    const batches = [1, 2, 3, 4].map(id => ({
      id,
      bookGuid: 'b'.repeat(32),
      accountGuid: null,
      source: 'pdf' as const,
      originalFilename: `${id}.pdf`,
      storageKey: `${id}.pdf`,
      thumbnailKey: null,
      status: 'error' as const,
      statementStartDate: null,
      statementEndDate: null,
      openingBalance: null,
      closingBalance: null,
      currency: null,
      ofxAcctId: null,
      error: 'legacy PDF.js packaging failure',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-02T15:00:00.000Z'),
      lineCount: 0,
    }));
    await expect(scheduleStatementRecovery({
      batches,
      bookGuid: 'b'.repeat(32),
      userId: 9,
      now: NOW,
    })).resolves.toEqual([1, 2, 3]);

    expect(mocks.enqueueExtractStatement).toHaveBeenCalledTimes(3);
    expect(mocks.enqueueExtractStatement).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ batchId: 1, autoRecoveryAttempt: 1 }),
      { jobId: 'statement-recovery-1-1', delay: 2_000 },
    );
    expect(mocks.setBatchStatus).toHaveBeenCalledWith(1, 'error', {
      error: expect.stringContaining('[auto-recovery attempt 1/2; next '),
    });
  });
});
