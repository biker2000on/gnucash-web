/**
 * Multi-window pop-out panes.
 *
 * A "surface" is a pane that can be popped out into a separate same-origin
 * browser window (transaction detail, Explain drill-through, Action Center
 * resolution). Each surface gets one named window per browsing-context group,
 * a BroadcastChannel for host→child state sync, and per-surface window
 * geometry remembered in localStorage so a two-monitor arrangement restores
 * in one action.
 *
 * Close/crash detection is poll-based on the host (`win.closed`) rather than
 * child-notified: a child navigating within its own window fires pagehide
 * without the window closing, so only the host's poll is authoritative.
 */

export type PopoutSurface = 'transaction' | 'explain' | 'resolution';

export interface PopoutGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PopoutRedockHandler = (lastPayload: unknown) => void;

interface PopoutMessage {
  type: 'show' | 'child-ready';
  payload?: unknown;
}

const GEOMETRY_KEY_PREFIX = 'gnucash-web:popout-geometry:';
const CHANNEL_PREFIX = 'gnucash-web:popout:';
const WINDOW_NAME_PREFIX = 'gnucash-popout-';
const CLOSED_POLL_MS = 700;

const DEFAULT_SIZE: Record<PopoutSurface, { width: number; height: number }> = {
  transaction: { width: 840, height: 700 },
  explain: { width: 680, height: 780 },
  resolution: { width: 1180, height: 820 },
};

export function loadPopoutGeometry(surface: PopoutSurface): PopoutGeometry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(GEOMETRY_KEY_PREFIX + surface);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PopoutGeometry>;
    if (
      typeof parsed.left !== 'number'
      || typeof parsed.top !== 'number'
      || typeof parsed.width !== 'number'
      || typeof parsed.height !== 'number'
      || parsed.width <= 0
      || parsed.height <= 0
    ) {
      return null;
    }
    return { left: parsed.left, top: parsed.top, width: parsed.width, height: parsed.height };
  } catch {
    return null;
  }
}

export function savePopoutGeometry(surface: PopoutSurface, geometry: PopoutGeometry): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(GEOMETRY_KEY_PREFIX + surface, JSON.stringify(geometry));
  } catch {
    // Storage may be full or unavailable; geometry memory is best-effort.
  }
}

function windowFeatures(surface: PopoutSurface): string {
  const saved = loadPopoutGeometry(surface);
  const width = saved?.width ?? DEFAULT_SIZE[surface].width;
  const height = saved?.height ?? DEFAULT_SIZE[surface].height;
  const parts = ['popup=yes', `width=${Math.round(width)}`, `height=${Math.round(height)}`];
  if (saved) {
    parts.push(`left=${Math.round(saved.left)}`, `top=${Math.round(saved.top)}`);
  }
  return parts.join(',');
}

/**
 * Host-side controller for one pop-out surface. Singleton per surface so the
 * pop-out window survives host component unmounts (page navigation) and any
 * later host can reattach.
 */
export class PopoutHostManager {
  private win: Window | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private channel: BroadcastChannel | null = null;
  private lastPayload: unknown = undefined;
  private lastSavedGeometry: string | null = null;
  private changeListeners = new Set<() => void>();
  private redockListeners = new Set<PopoutRedockHandler>();

  constructor(private readonly surface: PopoutSurface) {}

  isOpen(): boolean {
    return Boolean(this.win && !this.win.closed);
  }

  /** Open (or re-navigate) the surface's named window. Returns false when blocked. */
  open(url: string, payload?: unknown): boolean {
    if (typeof window === 'undefined') return false;
    if (payload !== undefined) this.lastPayload = payload;
    const win = window.open(url, WINDOW_NAME_PREFIX + this.surface, windowFeatures(this.surface));
    if (!win) return false;
    this.win = win;
    try {
      win.focus();
    } catch {
      // Some browsers throw on focus() for popups; non-fatal.
    }
    this.ensureChannel();
    this.startPolling();
    this.notifyChange();
    return true;
  }

  /** Push a new payload to the already-open child window. Returns false if closed. */
  show(payload: unknown): boolean {
    if (!this.isOpen()) return false;
    this.lastPayload = payload;
    this.post({ type: 'show', payload });
    try {
      this.win?.focus();
    } catch {
      // Non-fatal.
    }
    return true;
  }

  close(): void {
    try {
      this.win?.close();
    } catch {
      // Non-fatal; poll cleanup will follow.
    }
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Fired when the pop-out window is detected closed; receives the last payload. */
  onRedock(listener: PopoutRedockHandler): () => void {
    this.redockListeners.add(listener);
    return () => this.redockListeners.delete(listener);
  }

  private post(message: PopoutMessage): void {
    this.ensureChannel();
    this.channel?.postMessage(message);
  }

  private ensureChannel(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel(CHANNEL_PREFIX + this.surface);
    this.channel.addEventListener('message', (event: MessageEvent) => {
      const message = event.data as PopoutMessage | undefined;
      // A freshly loaded child asks for state; replay the current payload so
      // the open → load → ready race never leaves the pane empty.
      if (message?.type === 'child-ready' && this.isOpen() && this.lastPayload !== undefined) {
        this.channel?.postMessage({ type: 'show', payload: this.lastPayload } satisfies PopoutMessage);
      }
    });
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      const win = this.win;
      if (!win) {
        this.stopPolling();
        return;
      }
      if (win.closed) {
        this.handleClosed();
        return;
      }
      this.captureGeometry(win);
    }, CLOSED_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private captureGeometry(win: Window): void {
    try {
      const geometry: PopoutGeometry = {
        left: win.screenX,
        top: win.screenY,
        width: win.outerWidth,
        height: win.outerHeight,
      };
      if (!Number.isFinite(geometry.width) || geometry.width <= 0) return;
      const serialized = JSON.stringify(geometry);
      if (serialized === this.lastSavedGeometry) return;
      this.lastSavedGeometry = serialized;
      savePopoutGeometry(this.surface, geometry);
    } catch {
      // Cross-window reads can fail transiently during navigation; skip.
    }
  }

  private handleClosed(): void {
    if (!this.win) return;
    this.win = null;
    this.stopPolling();
    const payload = this.lastPayload;
    this.lastPayload = undefined;
    this.notifyChange();
    this.redockListeners.forEach(listener => listener(payload));
  }

  private notifyChange(): void {
    this.changeListeners.forEach(listener => listener());
  }
}

const managers = new Map<PopoutSurface, PopoutHostManager>();

export function getPopoutManager(surface: PopoutSurface): PopoutHostManager {
  let manager = managers.get(surface);
  if (!manager) {
    manager = new PopoutHostManager(surface);
    managers.set(surface, manager);
  }
  return manager;
}

/**
 * Child-side connection for a pop-out page. Announces readiness (so the host
 * replays the current payload) and invokes `onShow` for every pushed payload.
 */
export function connectPopoutChild(
  surface: PopoutSurface,
  onShow: (payload: unknown) => void,
): () => void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return () => undefined;
  }
  const channel = new BroadcastChannel(CHANNEL_PREFIX + surface);
  const handleMessage = (event: MessageEvent) => {
    const message = event.data as PopoutMessage | undefined;
    if (message?.type === 'show') onShow(message.payload);
  };
  channel.addEventListener('message', handleMessage);
  channel.postMessage({ type: 'child-ready' } satisfies PopoutMessage);
  return () => {
    channel.removeEventListener('message', handleMessage);
    channel.close();
  };
}
