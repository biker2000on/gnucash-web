import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const clientQuery = vi.fn();
    const clientRelease = vi.fn();
    const poolConnect = vi.fn();
    const poolQuery = vi.fn();
    // Kept outside the vi.fn so vi.clearAllMocks() cannot erase the handler
    // registered at module-import time.
    const poolHandlers = new Map<string, (...args: unknown[]) => void>();
    const poolOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        poolHandlers.set(event, handler);
    });

    return {
        clientQuery,
        clientRelease,
        poolConnect,
        poolQuery,
        poolOn,
        poolHandlers,
    };
});

vi.mock('pg', () => ({
    Pool: vi.fn(function MockPool() {
        return {
            connect: mocks.poolConnect,
            query: mocks.poolQuery,
            // db.ts attaches an 'error' listener so an idle-client failure
            // (Postgres restart) cannot become an uncaught exception.
            on: mocks.poolOn,
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

describe('pool error handling', () => {
    it('attaches an error listener so an idle-client failure cannot crash the process', () => {
        // pg emits 'error' on IDLE pooled clients (Postgres restart, OOM kill,
        // container cycle). Without a listener Node raises an uncaught
        // exception and takes the whole server down.
        const errorHandler = mocks.poolHandlers.get('error');
        expect(errorHandler).toBeTypeOf('function');
        expect(() => errorHandler!(new Error('terminating connection due to administrator command')))
            .not.toThrow();
    });
});
