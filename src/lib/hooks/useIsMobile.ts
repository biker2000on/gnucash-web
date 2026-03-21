'use client';

import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768; // matches Tailwind md:

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
      const handler = () => onStoreChange();
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    },
    () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches,
    () => false
  );
}
