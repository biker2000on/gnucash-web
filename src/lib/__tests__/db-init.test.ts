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

    it('adds the audit undo claim columns behind an advisory lock', async () => {
        await initializeDatabase();

        const sqls = mocks.query.mock.calls.map((c) => String(c[0]));
        const ddl = sqls.find((s) => s.includes('gnucash_web_audit_undo_columns'));
        expect(ddl).toBeDefined();
        // Claim marker for audit.service's claim-first undo (undone_at CAS).
        expect(ddl).toContain('ALTER TABLE gnucash_web_audit ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ');
        expect(ddl).toContain('ADD COLUMN IF NOT EXISTS undone_by INTEGER');
        expect(ddl).toContain("pg_advisory_xact_lock(hashtext('gnucash_web_audit_undo_columns'))");
    });
});
