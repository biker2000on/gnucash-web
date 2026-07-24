import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const clientQuery = vi.fn();
    const clientRelease = vi.fn();
    const poolConnect = vi.fn();
    const poolQuery = vi.fn();

    return {
        clientQuery,
        clientRelease,
        poolConnect,
        poolQuery,
    };
});

vi.mock('pg', () => ({
    Pool: vi.fn(function MockPool() {
        return {
            connect: mocks.poolConnect,
            query: mocks.poolQuery,
        };
    }),
}));

import { withDatabaseAdvisoryLock } from '../db';

describe('withDatabaseAdvisoryLock', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.poolConnect.mockResolvedValue({
            query: mocks.clientQuery,
            release: mocks.clientRelease,
        });
        mocks.clientQuery.mockResolvedValue({ rows: [] });
    });

    it('holds one session-level advisory lock for the full operation', async () => {
        const operation = vi.fn().mockResolvedValue('done');

        await expect(withDatabaseAdvisoryLock('db-init', operation)).resolves.toBe('done');

        expect(mocks.poolConnect).toHaveBeenCalledOnce();
        expect(mocks.clientQuery).toHaveBeenNthCalledWith(
            1,
            'SELECT pg_advisory_lock(hashtext($1))',
            ['db-init'],
        );
        expect(operation).toHaveBeenCalledOnce();
        expect(mocks.clientQuery).toHaveBeenNthCalledWith(
            2,
            'SELECT pg_advisory_unlock(hashtext($1))',
            ['db-init'],
        );
        expect(mocks.clientRelease).toHaveBeenCalledWith(false);
    });

    it('unlocks and releases the session when the operation fails', async () => {
        const operationError = new Error('migration failed');

        await expect(
            withDatabaseAdvisoryLock('db-init', async () => {
                throw operationError;
            }),
        ).rejects.toBe(operationError);

        expect(mocks.clientQuery).toHaveBeenCalledTimes(2);
        expect(mocks.clientRelease).toHaveBeenCalledWith(false);
    });

    it('destroys a session when the advisory lock cannot be released', async () => {
        const unlockError = new Error('connection lost');
        mocks.clientQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockRejectedValueOnce(unlockError);

        await expect(
            withDatabaseAdvisoryLock('db-init', async () => 'done'),
        ).rejects.toBe(unlockError);

        expect(mocks.clientRelease).toHaveBeenCalledWith(true);
    });
});
