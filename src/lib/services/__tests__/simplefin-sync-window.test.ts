/**
 * SimpleFin fetch-window computation — pure tests for computeSyncStart.
 */

import { describe, expect, it } from 'vitest';
import { computeSyncStart } from '../simplefin-sync.service';

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
