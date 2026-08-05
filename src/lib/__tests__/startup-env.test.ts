import { describe, expect, it } from 'vitest';
import { validateStartupEnvironment } from '../startup-env';

describe('startup environment validation', () => {
  it('names a missing DATABASE_URL', () => {
    expect(() => validateStartupEnvironment({
      NEXTAUTH_SECRET: 'x'.repeat(32),
    })).toThrow('DATABASE_URL is required');
  });

  it('names a missing session secret', () => {
    expect(() => validateStartupEnvironment({
      DATABASE_URL: 'postgresql://db/book',
    })).toThrow('SESSION_SECRET or NEXTAUTH_SECRET is required');
  });

  it('rejects a short session secret', () => {
    expect(() => validateStartupEnvironment({
      DATABASE_URL: 'postgresql://db/book',
      SESSION_SECRET: 'short',
    })).toThrow('must be at least 32 characters');
  });

  it('accepts NEXTAUTH_SECRET as the fallback', () => {
    expect(() => validateStartupEnvironment({
      DATABASE_URL: 'postgresql://db/book',
      NEXTAUTH_SECRET: 'x'.repeat(32),
    })).not.toThrow();
  });
});
