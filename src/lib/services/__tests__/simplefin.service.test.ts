import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {},
  generateGuid: vi.fn(() => '0'.repeat(32)),
}));

import { fetchAccounts, SimpleFinAccessRevokedError } from '../simplefin.service';
import { isNonFatalSimpleFinWarning } from '../simplefin-sync.service';

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

describe('isNonFatalSimpleFinWarning', () => {
  it('treats recommended date range messages as warnings', () => {
    expect(isNonFatalSimpleFinWarning(
      'Requested date range exceeds recommended range of 45 days. In the future, this may be capped.',
    )).toBe(true);
  });

  it('does not hide unrelated SimpleFin errors', () => {
    expect(isNonFatalSimpleFinWarning('Access has been revoked')).toBe(false);
  });
});
