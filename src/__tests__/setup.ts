import { vi } from 'vitest';

// The vault preview's pdf.js loader natively imports the vendored runtime at
// the URL '/pdf.min.mjs' (a webpackIgnore literal — see src/lib/pdfjs-client.ts).
// Vite's import analysis refuses literal public/ asset imports, so the module
// is mocked GLOBALLY and never transformed under Vitest. Tests that exercise
// rendering re-mock '@/lib/pdfjs-client' locally with their own doubles.
vi.mock('@/lib/pdfjs-client', () => ({
  loadPdfJs: async () => {
    throw new Error('pdf.js is unavailable under Vitest — mock @/lib/pdfjs-client in this test.');
  },
}));
/**
 * Vitest Test Setup
 *
 * Global configuration and mocks for all tests
 */

import '@testing-library/jest-dom';

// session-config.ts refuses to load without a secret (a weak one would let
// anyone mint an authenticated cookie), so give the suite a throwaway value.
// Never a real secret: tests must not depend on deployment configuration.
process.env.SESSION_SECRET ||= 'test-only-session-secret-not-used-in-any-deployment';

// Mock IntersectionObserver for components using infinite scroll
class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];

  constructor(
    private callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    void options;
  }

  observe(target: Element): void {
    void target;
  }
  unobserve(target: Element): void {
    void target;
  }
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

// Mock window.matchMedia for responsive components
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// BigInt JSON serialization support
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

// Suppress console errors in tests unless debugging
if (process.env.DEBUG !== 'true') {
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    // Filter out expected React warnings in tests
    if (
      typeof args[0] === 'string' &&
      (args[0].includes('Warning:') || args[0].includes('act(...)'))
    ) {
      return;
    }
    originalError.apply(console, args);
  };
}
