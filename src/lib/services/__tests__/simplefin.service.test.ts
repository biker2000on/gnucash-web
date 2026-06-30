import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAccounts, SimpleFinAccessRevokedError } from '../simplefin.service';

describe('fetchAccounts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([401, 403])('throws access revoked for HTTP %s', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status,
      statusText: 'Unauthorized',
    } as Response);

    await expect(fetchAccounts('https://user:pass@example.com/access')).rejects.toBeInstanceOf(
      SimpleFinAccessRevokedError,
    );
  });
});
