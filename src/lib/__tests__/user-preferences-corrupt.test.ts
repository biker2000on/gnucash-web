/**
 * A corrupt preference must not fall back SILENTLY.
 *
 * `getPreference` returns its caller-supplied default both when a preference
 * was never set and when the stored text fails to parse as JSON. The two are
 * indistinguishable at the call site — the worker's price-refresh recovery,
 * for one, turns both into the documented 21:00 default. Substituting a
 * default for a value the user actually did set is a decision, and the only
 * evidence it happened is a log line, so pin that the line is emitted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findUnique = vi.fn();
vi.mock('@/lib/prisma', () => ({
  default: { gnucash_web_user_preferences: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

import { getPreference } from '@/lib/user-preferences';

describe('getPreference with a corrupt stored value', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    findUnique.mockReset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('logs the substitution when the stored value is not valid JSON', async () => {
    findUnique.mockResolvedValue({ preference_value: '{not json' });

    const value = await getPreference<string | null>(7, 'refresh_time', null);

    expect(value).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('user 7');
    expect(message).toContain('refresh_time');
    expect(message).toContain('not valid JSON');
  });

  it('does not log the raw stored value — preferences are user content', async () => {
    findUnique.mockResolvedValue({ preference_value: 'sekrit-garbage-not-json' });

    await getPreference<string | null>(7, 'refresh_time', null);

    // Not the value, and not the parser's own message either: JSON.parse
    // quotes a prefix of the input in its error text.
    const [message] = warn.mock.calls[0] as [string];
    expect(message).not.toContain('sekrit');
    expect(message).toContain('23 chars');
  });

  it('stays silent when the preference is simply unset', async () => {
    findUnique.mockResolvedValue(null);

    expect(await getPreference(7, 'refresh_time', '21:00')).toBe('21:00');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when the stored value parses', async () => {
    findUnique.mockResolvedValue({ preference_value: '"06:30"' });

    expect(await getPreference(7, 'refresh_time', '21:00')).toBe('06:30');
    expect(warn).not.toHaveBeenCalled();
  });
});
