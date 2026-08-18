import {
    REFRESH_ENABLED_KEY,
    selectRefreshEnabledUserIds,
    type RefreshEnabledRow,
} from './refresh-schedule';

/**
 * The real database boundary used by worker startup recovery.
 *
 * Keep the query here, rather than in `recoverSchedules`, so an integration
 * test can seed PostgreSQL and prove that the rows fed into the shared
 * predicate include every stored representation. A fixture injected directly
 * into `selectRefreshEnabledUserIds` can only prove the predicate, not this
 * query.
 */
export interface RefreshSchedulePreferenceStore {
    gnucash_web_user_preferences: {
        findMany(args: {
            where: { preference_key: string };
            select: { user_id: true; preference_value: true };
        }): Promise<RefreshEnabledRow[]>;
    };
}

export async function listRefreshEnabledUserIdsFromStore(
    store: RefreshSchedulePreferenceStore,
): Promise<number[]> {
    // Candidate rows only. Enablement is decided by the shared predicate, not
    // a divergent SQL comparison: `preference_value = 'true'` misses JSON
    // string `"true"`, which is a supported stored representation.
    const rows = await store.gnucash_web_user_preferences.findMany({
        where: { preference_key: REFRESH_ENABLED_KEY },
        select: { user_id: true, preference_value: true },
    });
    return selectRefreshEnabledUserIds(rows);
}
