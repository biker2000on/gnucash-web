/**
 * SimpleFin fetch-window computation — pure tests for computeSyncStart.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY_LOOKBACK_DAYS,
  computeSafeSyncCursor,
  computeSyncStart,
  describeFailedImports,
  simpleFinErrorFingerprint,
} from '../simplefin-sync.service';

const NOW = new Date('2026-07-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('computeSyncStart', () => {
  it('bootstraps 90 days back when no accounts are mapped', () => {
    expect(computeSyncStart([], NOW).getTime()).toBe(NOW.getTime() - 90 * DAY);
  });

  it('bootstraps 90 days back when any account has never synced', () => {
    const recent = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    expect(computeSyncStart([recent, null], NOW).getTime()).toBe(NOW.getTime() - 90 * DAY);
  });

  it('uses the oldest last-sync minus a 7-day overlap for freshly synced accounts', () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const yesterday = new Date(NOW.getTime() - 1 * DAY);
    const start = computeSyncStart([twoHoursAgo, yesterday], NOW);
    expect(start.getTime()).toBe(yesterday.getTime() - 7 * DAY);
    // Well inside SimpleFin's 45-day recommended range.
    expect(NOW.getTime() - start.getTime()).toBeLessThan(45 * DAY);
  });

  it('widens naturally for stale accounts (old last-sync drives the window)', () => {
    const staleSync = new Date(NOW.getTime() - 120 * DAY);
    const start = computeSyncStart([staleSync], NOW);
    expect(start.getTime()).toBe(staleSync.getTime() - 7 * DAY);
  });
});

describe('computeSafeSyncCursor', () => {
  it('advances to now when every fetched transaction succeeded', () => {
    expect(computeSafeSyncCursor(NOW, [])).toBe(NOW);
  });

  it('stays at the oldest failed posting date so the next run re-fetches it', () => {
    const oldFailure = new Date('2026-07-05T00:00:00.000Z');
    const newFailure = new Date('2026-07-20T00:00:00.000Z');
    expect(computeSafeSyncCursor(NOW, [newFailure, oldFailure])).toBe(oldFailure);
  });

  it('still pins the cursor for a failure just inside the retry lookback', () => {
    const failure = new Date(NOW.getTime() - (MAX_RETRY_LOOKBACK_DAYS - 1) * DAY);
    expect(computeSafeSyncCursor(NOW, [failure])).toBe(failure);
  });

  it('clamps the cursor once the failure is older than the retry lookback', () => {
    const ancientFailure = new Date(NOW.getTime() - 400 * DAY);
    const cursor = computeSafeSyncCursor(NOW, [ancientFailure]);
    expect(cursor.getTime()).toBe(NOW.getTime() - MAX_RETRY_LOOKBACK_DAYS * DAY);
  });

  it('bounds the fetch window a permanently failing transaction can open', () => {
    // A row that fails on every run used to drag the cursor back indefinitely,
    // widening the window for EVERY account on the connection. The clamp caps
    // that at lookback + overlap, still inside SimpleFin's 45-day range.
    const stuckSince = new Date(NOW.getTime() - 400 * DAY);
    const cursor = computeSafeSyncCursor(NOW, [stuckSince]);
    const start = computeSyncStart([cursor], NOW);
    expect(NOW.getTime() - start.getTime()).toBe((MAX_RETRY_LOOKBACK_DAYS + 7) * DAY);
    expect(NOW.getTime() - start.getTime()).toBeLessThan(45 * DAY);
  });
});

describe('simpleFinErrorFingerprint', () => {
  const errors = [
    { account: 'Checking', error: 'Failed to import transaction ACT-99: Error: bad payload' },
  ];

  it('is stable across repeated identical failures so notifications dedupe', () => {
    expect(simpleFinErrorFingerprint(errors)).toBe(simpleFinErrorFingerprint([...errors]));
  });

  it('ignores volatile guids and timestamps in the error text', () => {
    const runA = [{
      account: 'Checking',
      error: 'Failed to import transaction ACT-99: split 0123456789abcdef0123456789abcdef at 2026-07-22T12:00:00.000Z',
    }];
    const runB = [{
      account: 'Checking',
      error: 'Failed to import transaction ACT-99: split fedcba9876543210fedcba9876543210 at 2026-07-22T14:00:00.000Z',
    }];
    expect(simpleFinErrorFingerprint(runA)).toBe(simpleFinErrorFingerprint(runB));
  });

  it('is order-independent but distinguishes a genuinely different failure', () => {
    const other = { account: 'Savings', error: 'Failed to import transaction ACT-100: Error: bad payload' };
    expect(simpleFinErrorFingerprint([...errors, other]))
      .toBe(simpleFinErrorFingerprint([other, ...errors]));
    expect(simpleFinErrorFingerprint([other])).not.toBe(simpleFinErrorFingerprint(errors));
  });
});

describe('describeFailedImports', () => {
  it('is empty when nothing failed to import', () => {
    expect(describeFailedImports([])).toBe('');
  });

  it('names the account and posting-date range that will stop being retried', () => {
    const text = describeFailedImports([{
      account: 'Checking',
      earliest: new Date('2026-07-01T00:00:00.000Z'),
      latest: new Date('2026-07-03T00:00:00.000Z'),
      count: 2,
    }]);
    expect(text).toContain('2 transactions for Checking');
    expect(text).toContain('2026-07-01 to 2026-07-03');
    expect(text).toContain(`${MAX_RETRY_LOOKBACK_DAYS} days`);
  });

  it('collapses a single-day range to one date', () => {
    const day = new Date('2026-07-01T00:00:00.000Z');
    const text = describeFailedImports([{ account: 'Savings', earliest: day, latest: day, count: 1 }]);
    expect(text).toContain('1 transaction for Savings dated 2026-07-01.');
  });
});
