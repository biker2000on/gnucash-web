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
const USERNAME = `itest-refresh-schedule-${RUN_ID}`;
let userId: number;

describe('refresh schedule recovery query (real PostgreSQL)', () => {
    beforeAll(async () => {
        const user = await getTestPool().query<{ id: number }>(
            `INSERT INTO gnucash_web_users (username, password_hash)
             VALUES ($1, 'integration-test')
             RETURNING id`,
            [USERNAME],
        );
        userId = user.rows[0].id;

        await getTestPool().query(
            `INSERT INTO gnucash_web_user_preferences (user_id, preference_key, preference_value)
             VALUES ($1, 'refresh_enabled', '"true"'),
                    ($1, 'unrelated_preference', 'true')`,
            [userId],
        );
    });

    afterAll(async () => {
        await getTestPool().query(
            'DELETE FROM gnucash_web_users WHERE username = $1',
            [USERNAME],
        );
        await prisma.$disconnect();
    });

    it('feeds a JSON-string enabled preference from the real Prisma query into recovery selection', async () => {
        await expect(listRefreshEnabledUserIdsFromStore(prisma)).resolves.toEqual([userId]);
    });
});
