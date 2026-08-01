import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PopoutHostManager,
  connectPopoutChild,
  loadPopoutGeometry,
  savePopoutGeometry,
} from '../popout';

/**
 * Minimal BroadcastChannel stand-in (jsdom does not provide one). Delivers
 * messages synchronously to every other open channel with the same name.
 */
class FakeBroadcastChannel {
  static registry = new Map<string, Set<FakeBroadcastChannel>>();
  private listeners = new Set<(event: MessageEvent) => void>();
  private closed = false;

  constructor(public readonly name: string) {
    let peers = FakeBroadcastChannel.registry.get(name);
    if (!peers) {
      peers = new Set();
      FakeBroadcastChannel.registry.set(name, peers);
    }
    peers.add(this);
  }

  postMessage(data: unknown): void {
    const peers = FakeBroadcastChannel.registry.get(this.name) ?? new Set();
    for (const peer of peers) {
      if (peer === this || peer.closed) continue;
      peer.listeners.forEach(listener => listener({ data } as MessageEvent));
    }
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }
}

interface FakeWindow {
  closed: boolean;
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  focus: () => void;
  close: () => void;
}

function makeFakeWindow(overrides: Partial<FakeWindow> = {}): FakeWindow {
  const fake: FakeWindow = {
    closed: false,
    screenX: 120,
    screenY: 40,
    outerWidth: 900,
    outerHeight: 700,
    focus: vi.fn(),
    close: vi.fn(() => {
      fake.closed = true;
    }),
    ...overrides,
  };
  return fake;
}

describe('popout geometry persistence', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips saved geometry', () => {
    savePopoutGeometry('transaction', { left: 10, top: 20, width: 800, height: 600 });
    expect(loadPopoutGeometry('transaction')).toEqual({ left: 10, top: 20, width: 800, height: 600 });
  });

  it('returns null for missing or malformed data', () => {
    expect(loadPopoutGeometry('explain')).toBeNull();
    window.localStorage.setItem('gnucash-web:popout-geometry:explain', 'not json');
    expect(loadPopoutGeometry('explain')).toBeNull();
    window.localStorage.setItem('gnucash-web:popout-geometry:explain', JSON.stringify({ left: 1 }));
    expect(loadPopoutGeometry('explain')).toBeNull();
    window.localStorage.setItem(
      'gnucash-web:popout-geometry:explain',
      JSON.stringify({ left: 0, top: 0, width: -5, height: 100 }),
    );
    expect(loadPopoutGeometry('explain')).toBeNull();
  });
});

describe('PopoutHostManager', () => {
  let fakeWindow: FakeWindow;
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    FakeBroadcastChannel.registry.clear();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    fakeWindow = makeFakeWindow();
    openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWindow as unknown as Window);
  });

  afterEach(() => {
    openSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens a named window with size features and reports open', () => {
    const manager = new PopoutHostManager('transaction');
    expect(manager.isOpen()).toBe(false);
    expect(manager.open('/popout/transaction?tx=abc', 'abc')).toBe(true);
    expect(manager.isOpen()).toBe(true);
    const [url, name, features] = openSpy.mock.calls[0];
    expect(url).toBe('/popout/transaction?tx=abc');
    expect(name).toBe('gnucash-popout-transaction');
    expect(String(features)).toContain('width=');
    expect(String(features)).toContain('height=');
    expect(fakeWindow.focus).toHaveBeenCalled();
  });

  it('reuses saved geometry for the window features', () => {
    savePopoutGeometry('transaction', { left: 5, top: 6, width: 700, height: 500 });
    const manager = new PopoutHostManager('transaction');
    manager.open('/popout/transaction');
    const features = String(openSpy.mock.calls[0][2]);
    expect(features).toContain('left=5');
    expect(features).toContain('top=6');
    expect(features).toContain('width=700');
    expect(features).toContain('height=500');
  });

  it('returns false when the popup is blocked', () => {
    openSpy.mockReturnValue(null);
    const manager = new PopoutHostManager('transaction');
    expect(manager.open('/popout/transaction')).toBe(false);
    expect(manager.isOpen()).toBe(false);
  });

  it('pushes payloads to a connected child', () => {
    const manager = new PopoutHostManager('transaction');
    manager.open('/popout/transaction?tx=first', 'first');

    const received: unknown[] = [];
    const disconnect = connectPopoutChild('transaction', payload => received.push(payload));
    // child-ready replays the current payload immediately
    expect(received).toEqual(['first']);

    expect(manager.show('second')).toBe(true);
    expect(received).toEqual(['first', 'second']);
    disconnect();
  });

  it('show() returns false once the window is closed', () => {
    const manager = new PopoutHostManager('transaction');
    manager.open('/popout/transaction', 'x');
    fakeWindow.closed = true;
    expect(manager.show('y')).toBe(false);
  });

  it('detects a closed window, fires redock with the last payload, and saves geometry', () => {
    const manager = new PopoutHostManager('transaction');
    const redocked: unknown[] = [];
    const changes: boolean[] = [];
    manager.onRedock(payload => redocked.push(payload));
    manager.onChange(() => changes.push(manager.isOpen()));

    manager.open('/popout/transaction?tx=abc', 'abc');
    expect(changes).toEqual([true]);

    // One poll tick with the window open captures its geometry.
    vi.advanceTimersByTime(800);
    expect(loadPopoutGeometry('transaction')).toEqual({
      left: 120,
      top: 40,
      width: 900,
      height: 700,
    });

    fakeWindow.closed = true;
    vi.advanceTimersByTime(800);
    expect(manager.isOpen()).toBe(false);
    expect(redocked).toEqual(['abc']);
    expect(changes).toEqual([true, false]);

    // No further redock events after cleanup.
    vi.advanceTimersByTime(2000);
    expect(redocked).toEqual(['abc']);
  });
});
