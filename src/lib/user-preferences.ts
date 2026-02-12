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
  defaultPeriod: string;
  defaultMode: 'dollar' | 'percent';
}

const CHART_DEFAULT_VALUES: ChartDefaults = {
  sp500Enabled: false,
  djiaEnabled: false,
  defaultPeriod: '1Y',
  defaultMode: 'dollar',
};

const CHART_PREF_KEYS: Record<keyof ChartDefaults, string> = {
  sp500Enabled: 'performance_chart.sp500_default',
  djiaEnabled: 'performance_chart.djia_default',
  defaultPeriod: 'performance_chart.default_period',
  defaultMode: 'performance_chart.default_mode',
};

/**
 * Get a single preference value, parsed from JSON.
 * Returns the default if no preference is stored.
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

  return {
    sp500Enabled:
      typeof prefs[CHART_PREF_KEYS.sp500Enabled] === 'boolean'
        ? (prefs[CHART_PREF_KEYS.sp500Enabled] as boolean)
        : CHART_DEFAULT_VALUES.sp500Enabled,
    djiaEnabled:
      typeof prefs[CHART_PREF_KEYS.djiaEnabled] === 'boolean'
        ? (prefs[CHART_PREF_KEYS.djiaEnabled] as boolean)
        : CHART_DEFAULT_VALUES.djiaEnabled,
    defaultPeriod:
      typeof prefs[CHART_PREF_KEYS.defaultPeriod] === 'string'
        ? (prefs[CHART_PREF_KEYS.defaultPeriod] as string)
        : CHART_DEFAULT_VALUES.defaultPeriod,
    defaultMode:
      prefs[CHART_PREF_KEYS.defaultMode] === 'dollar' || prefs[CHART_PREF_KEYS.defaultMode] === 'percent'
        ? (prefs[CHART_PREF_KEYS.defaultMode] as 'dollar' | 'percent')
        : CHART_DEFAULT_VALUES.defaultMode,
  };
}
