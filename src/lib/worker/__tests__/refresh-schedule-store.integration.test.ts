/**
 * Regression coverage for the real worker recovery query boundary.
 *
 * This seeds PostgreSQL and calls the same store function that worker.ts uses.
 * It would fail if the query were restored to `preference_value: 'true'`: the
 * JSON string `"true"` fixture would never reach the shared predicate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestPool } from '@/__tests__/integration/db';
import prisma from '@/lib/prisma';
import { listRefreshEnabledUserIdsFromStore } from '../refresh-schedule-store';

const RUN_ID = randomUUID().replace(/-/g, '');
const ENABLED_USERNAME = `itest-refresh-enabled-${RUN_ID}`;
const DISABLED_USERNAME = `itest-refresh-disabled-${RUN_ID}`;
let enabledUserId: number;
let disabledUserId: number;

describe('refresh schedule recovery query (real PostgreSQL)', () => {
    beforeAll(async () => {
        const enabledUser = await getTestPool().query<{ id: number }>(
            `INSERT INTO gnucash_web_users (username, password_hash)
             VALUES ($1, 'integration-test')
             RETURNING id`,
            [ENABLED_USERNAME],
        );
        enabledUserId = enabledUser.rows[0].id;

        const disabledUser = await getTestPool().query<{ id: number }>(
            `INSERT INTO gnucash_web_users (username, password_hash)
             VALUES ($1, 'integration-test')
             RETURNING id`,
            [DISABLED_USERNAME],
        );
        disabledUserId = disabledUser.rows[0].id;

        await getTestPool().query(
            `INSERT INTO gnucash_web_user_preferences (user_id, preference_key, preference_value)
             VALUES ($1, 'refresh_enabled', '"true"'),
                    ($2, 'refresh_enabled', '"false"')`,
            [enabledUserId, disabledUserId],
        );
    });

    afterAll(async () => {
        await getTestPool().query(
            'DELETE FROM gnucash_web_users WHERE username IN ($1, $2)',
            [ENABLED_USERNAME, DISABLED_USERNAME],
        );
        await prisma.$disconnect();
    });

    it('feeds a JSON-string enabled preference from the real Prisma query into recovery selection', async () => {
        const userIds = await listRefreshEnabledUserIdsFromStore(prisma);

        expect(userIds).toContain(enabledUserId);
        expect(userIds).not.toContain(disabledUserId);
    });
});
