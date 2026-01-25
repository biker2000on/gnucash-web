/**
 * Smoke Test
 *
 * Verifies that the test environment is working correctly
 */

import { describe, it, expect } from 'vitest';

describe('Test Environment', () => {
  it('should run a basic test', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have access to DOM APIs (jsdom)', () => {
    const div = document.createElement('div');
    div.textContent = 'Hello, World!';
    expect(div.textContent).toBe('Hello, World!');
  });

  it('should support BigInt serialization', () => {
    const bigValue = BigInt('9007199254740991');
    expect(JSON.stringify({ value: bigValue })).toBe('{"value":"9007199254740991"}');
  });

  it('should have mocked localStorage', () => {
    localStorage.setItem('test', 'value');
    expect(localStorage.getItem('test')).toBe('value');
    localStorage.removeItem('test');
    expect(localStorage.getItem('test')).toBeNull();
  });

  it('should have mocked IntersectionObserver', () => {
    const callback = () => {};
    const observer = new IntersectionObserver(callback);
    expect(observer).toBeDefined();
    expect(typeof observer.observe).toBe('function');
  });
});
