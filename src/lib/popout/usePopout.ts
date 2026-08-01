'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  connectPopoutChild,
  getPopoutManager,
  type PopoutRedockHandler,
  type PopoutSurface,
} from './popout';

/**
 * Host-side hook for a pop-out surface. `onRedock` (memoize it) fires with
 * the last shown payload when the pop-out window closes, so the host can
 * restore the pane inline without losing state.
 */
export function usePopoutHost(surface: PopoutSurface, onRedock?: PopoutRedockHandler) {
  const manager = getPopoutManager(surface);
  const subscribe = useCallback((listener: () => void) => manager.onChange(listener), [manager]);
  const isPopoutOpen = useSyncExternalStore(subscribe, () => manager.isOpen(), () => false);

  useEffect(() => {
    if (!onRedock) return undefined;
    return manager.onRedock(onRedock);
  }, [manager, onRedock]);

  const open = useCallback((url: string, payload?: unknown) => manager.open(url, payload), [manager]);
  const show = useCallback((payload: unknown) => manager.show(payload), [manager]);
  const close = useCallback(() => manager.close(), [manager]);

  return { isPopoutOpen, open, show, close };
}

/** Child-side hook for a pop-out page. `onShow` must be memoized by the caller. */
export function usePopoutChild(surface: PopoutSurface, onShow: (payload: unknown) => void): void {
  useEffect(() => connectPopoutChild(surface, onShow), [surface, onShow]);
}
