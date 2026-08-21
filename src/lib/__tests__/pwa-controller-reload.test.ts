import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROLLER_RELOAD_GUARD_KEY,
  CONTROLLER_RELOAD_GUARD_MS,
  hasRecentControllerReload,
  markControllerReload,
  shouldReloadOnControllerChange,
} from '@/lib/pwa-controller-reload';

function memoryStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(CONTROLLER_RELOAD_GUARD_KEY, initial);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    read: () => map.get(CONTROLLER_RELOAD_GUARD_KEY) ?? null,
  };
}

describe('shouldReloadOnControllerChange', () => {
  it('reloads when the document already had a controller, even without the waiting flag', () => {
    // The finding-7 case: sw.js skipWaiting()s at install, the page never
    // records registration.waiting, and the old code skipped the reload.
    expect(
      shouldReloadOnControllerChange({
        hadController: true,
        reloadRequested: false,
        alreadyReloaded: false,
      }),
    ).toBe(true);
  });

  it('still reloads on the explicit SKIP_WAITING prompt path', () => {
    expect(
      shouldReloadOnControllerChange({
        hadController: false,
        reloadRequested: true,
        alreadyReloaded: false,
      }),
    ).toBe(true);
  });

  it('does not reload on a first-ever registration', () => {
    expect(
      shouldReloadOnControllerChange({
        hadController: false,
        reloadRequested: false,
        alreadyReloaded: false,
      }),
    ).toBe(false);
  });

  it('never reloads twice inside the guard window', () => {
    expect(
      shouldReloadOnControllerChange({
        hadController: true,
        reloadRequested: true,
        alreadyReloaded: true,
      }),
    ).toBe(false);
  });
});

describe('controller reload guard', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('reports no recent reload when nothing was recorded', () => {
    expect(hasRecentControllerReload(1_000, memoryStorage())).toBe(false);
  });

  it('suppresses a second reload inside the window and allows one after it', () => {
    const storage = memoryStorage();
    markControllerReload(1_000, storage);

    expect(storage.read()).toBe('1000');
    expect(hasRecentControllerReload(1_000, storage)).toBe(true);
    expect(
      hasRecentControllerReload(1_000 + CONTROLLER_RELOAD_GUARD_MS - 1, storage),
    ).toBe(true);
    expect(
      hasRecentControllerReload(1_000 + CONTROLLER_RELOAD_GUARD_MS, storage),
    ).toBe(false);
  });

  it('ignores a corrupt or future-dated guard value', () => {
    expect(hasRecentControllerReload(5_000, memoryStorage('not-a-number'))).toBe(false);
    expect(hasRecentControllerReload(5_000, memoryStorage('9999999999999'))).toBe(false);
  });

  it('falls back to the real sessionStorage by default', () => {
    markControllerReload(2_000);
    expect(window.sessionStorage.getItem(CONTROLLER_RELOAD_GUARD_KEY)).toBe('2000');
    expect(hasRecentControllerReload(2_500)).toBe(true);
  });

  it('never throws when storage rejects the write', () => {
    expect(() =>
      markControllerReload(1_000, {
        setItem: () => {
          throw new Error('quota exceeded');
        },
      }),
    ).not.toThrow();
  });
});
