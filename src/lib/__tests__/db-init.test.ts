import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    withDatabaseAdvisoryLock: vi.fn(),
}));

vi.mock('../db', () => ({
    query: mocks.query,
    withDatabaseAdvisoryLock: mocks.withDatabaseAdvisoryLock,
}));

import { initializeDatabase } from '../db-init';

describe('initializeDatabase', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.query.mockResolvedValue({ rows: [] });
        mocks.withDatabaseAdvisoryLock.mockImplementation(
            async (_lockName: string, operation: () => Promise<void>) => operation(),
        );
    });

    it('serializes the entire schema initialization across app processes', async () => {
        await initializeDatabase();

        expect(mocks.withDatabaseAdvisoryLock).toHaveBeenCalledOnce();
        expect(mocks.withDatabaseAdvisoryLock).toHaveBeenCalledWith(
            'gnucash-web:database-initialization',
            expect.any(Function),
        );
        expect(mocks.query).toHaveBeenCalled();
    });
});
