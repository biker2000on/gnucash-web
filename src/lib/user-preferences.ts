/**
 * User Preferences Service
 *
 * CRUD operations for the gnucash_web_user_preferences key-value table.
 * Stores arbitrary JSON-encoded preferences per user.
 */

import prisma from '@/lib/prisma';

export interface ChartDefaults {
  sp500Enabled: boolean;
  djiaEnabled: boolean;
  nasdaqEnabled: boolean;
  russell2000Enabled: boolean;
  defaultPeriod: string;
  defaultMode: 'dollar' | 'twr' | 'mwr';
}

const CHART_DEFAULT_VALUES: ChartDefaults = {
  sp500Enabled: false,
  djiaEnabled: false,
  nasdaqEnabled: false,
  russell2000Enabled: false,
  defaultPeriod: '1Y',
  defaultMode: 'dollar',
};

const CHART_PREF_KEYS: Record<keyof ChartDefaults, string> = {
  sp500Enabled: 'performance_chart.sp500_default',
  djiaEnabled: 'performance_chart.djia_default',
  nasdaqEnabled: 'performance_chart.nasdaq_default',
  russell2000Enabled: 'performance_chart.russell2000_default',
  defaultPeriod: 'performance_chart.default_period',
  defaultMode: 'performance_chart.default_mode',
};

/**
 * Get a single preference value, parsed from JSON.
 * Returns the default if no preference is stored.
 *
 * A stored value that is not valid JSON also yields the default, but that is a
 * DECISION, not an accident, so it is logged. Callers cannot tell "unset" from
 * "corrupt" by the return value alone — the worker's price-refresh recovery,
 * for one, turns both into the 21:00 default — and a row silently substituting
 * a default for a value the user did set is exactly the kind of thing that is
 * only ever noticed as "my setting keeps reverting". The log line is the only
 * evidence the corruption happened.
 *
 * The raw value is not logged; preferences are user content. The row is
 * identified by user + key + length, which is enough to inspect or repair it.
 */
export async function getPreference<T>(
  userId: number,
  key: string,
  defaultValue: T
): Promise<T> {
  const pref = await prisma.gnucash_web_user_preferences.findUnique({
    where: { user_id_preference_key: { user_id: userId, preference_key: key } },
    select: { preference_value: true },
  });

  if (!pref) return defaultValue;

  try {
    return JSON.parse(pref.preference_value) as T;
  } catch {
    // The raw value is deliberately NOT logged (nor the parser's message,
    // which quotes a prefix of it): preferences are user content, and
    // user + key + length is enough to find and repair the row.
    console.warn(
      `[preferences] user ${userId}: stored value for '${key}' is not valid JSON ` +
      `(${pref.preference_value.length} chars) — falling back to the default`,
    );
    return defaultValue;
  }
}

/**
 * Get all preferences for a user, optionally filtered by key prefix.
 */
export async function getAllPreferences(
  userId: number,
  keyPrefix?: string
): Promise<Record<string, unknown>> {
  const where: { user_id: number; preference_key?: { startsWith: string } } = {
    user_id: userId,
  };
  if (keyPrefix) {
    where.preference_key = { startsWith: keyPrefix };
  }

  const prefs = await prisma.gnucash_web_user_preferences.findMany({
    where,
    select: { preference_key: true, preference_value: true },
  });

  const result: Record<string, unknown> = {};
  for (const p of prefs) {
    try {
      result[p.preference_key] = JSON.parse(p.preference_value);
    } catch {
      result[p.preference_key] = p.preference_value;
    }
  }
  return result;
}

/**
 * Set a single preference (upsert).
 */
export async function setPreference(
  userId: number,
  key: string,
  value: unknown
): Promise<void> {
  const serialized = JSON.stringify(value);
  await prisma.gnucash_web_user_preferences.upsert({
    where: { user_id_preference_key: { user_id: userId, preference_key: key } },
    create: {
      user_id: userId,
      preference_key: key,
      preference_value: serialized,
      updated_at: new Date(),
    },
    update: {
      preference_value: serialized,
      updated_at: new Date(),
    },
  });
}

/**
 * Set multiple preferences at once (upsert each).
 */
export async function setPreferences(
  userId: number,
  preferences: Record<string, unknown>
): Promise<void> {
  const ops = Object.entries(preferences).map(([key, value]) => {
    const serialized = JSON.stringify(value);
    return prisma.gnucash_web_user_preferences.upsert({
      where: { user_id_preference_key: { user_id: userId, preference_key: key } },
      create: {
        user_id: userId,
        preference_key: key,
        preference_value: serialized,
        updated_at: new Date(),
      },
      update: {
        preference_value: serialized,
        updated_at: new Date(),
      },
    });
  });

  await prisma.$transaction(ops);
}

/**
 * Get performance chart defaults for a user.
 * Returns stored values merged with defaults.
 */
export async function getChartDefaults(userId: number): Promise<ChartDefaults> {
  const prefs = await getAllPreferences(userId, 'performance_chart.');
  const rawDefaultMode = prefs[CHART_PREF_KEYS.defaultMode];

  const defaultMode =
    rawDefaultMode === 'dollar' || rawDefaultMode === 'twr' || rawDefaultMode === 'mwr'
      ? rawDefaultMode
      : rawDefaultMode === 'percent'
        ? 'twr'
        : CHART_DEFAULT_VALUES.defaultMode;

  return {
    sp500Enabled:
      typeof prefs[CHART_PREF_KEYS.sp500Enabled] === 'boolean'
        ? (prefs[CHART_PREF_KEYS.sp500Enabled] as boolean)
        : CHART_DEFAULT_VALUES.sp500Enabled,
    djiaEnabled:
      typeof prefs[CHART_PREF_KEYS.djiaEnabled] === 'boolean'
        ? (prefs[CHART_PREF_KEYS.djiaEnabled] as boolean)
        : CHART_DEFAULT_VALUES.djiaEnabled,
    nasdaqEnabled:
      typeof prefs[CHART_PREF_KEYS.nasdaqEnabled] === 'boolean'
        ? (prefs[CHART_PREF_KEYS.nasdaqEnabled] as boolean)
        : CHART_DEFAULT_VALUES.nasdaqEnabled,
    russell2000Enabled:
      typeof prefs[CHART_PREF_KEYS.russell2000Enabled] === 'boolean'
        ? (prefs[CHART_PREF_KEYS.russell2000Enabled] as boolean)
        : CHART_DEFAULT_VALUES.russell2000Enabled,
    defaultPeriod:
      typeof prefs[CHART_PREF_KEYS.defaultPeriod] === 'string'
        ? (prefs[CHART_PREF_KEYS.defaultPeriod] as string)
        : CHART_DEFAULT_VALUES.defaultPeriod,
    defaultMode,
  };
}
