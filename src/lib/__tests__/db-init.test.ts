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

    it('creates duplicate-race unique index guards (concurrency audit Phase 3)', async () => {
        await initializeDatabase();

        const sqls = mocks.query.mock.calls.map((c) => String(c[0]));

        // H5: prices — same-instant duplicates are deduped in place (best
        // source wins: user-entered beats Finance::Quote) before indexing.
        const prices = sqls.find((s) => s.includes('uq_prices_commodity_currency_date'));
        expect(prices).toBeDefined();
        expect(prices).toContain('DELETE FROM prices');
        expect(prices).toContain("(source IS DISTINCT FROM 'Finance::Quote') DESC");
        expect(prices).toContain("pg_advisory_xact_lock(hashtext('gnucash_web_prices_unique_guard'))");

        // Commodities — merging is not safe automatically: dirty data skips
        // the index with a warning, never deletes.
        const commodities = sqls.find((s) => s.includes('uq_commodities_namespace_mnemonic'));
        expect(commodities).toBeDefined();
        expect(commodities).toContain('RAISE WARNING');
        expect(commodities).not.toContain('DELETE FROM');

        // H4/H7: sibling account names — partial (root accounts have NULL
        // parent_guid), skip+warn on dirty data.
        const accounts = sqls.find((s) => s.includes('uq_accounts_parent_name'));
        expect(accounts).toBeDefined();
        expect(accounts).toContain('WHERE parent_guid IS NOT NULL');
        expect(accounts).toContain('RAISE WARNING');
        expect(accounts).not.toContain('DELETE FROM');

        // H3: SimpleFin import dedup key — duplicate imports are real
        // transactions the user must reconcile manually, so skip+warn.
        const simplefin = sqls.find((s) => s.includes('uq_txn_meta_simplefin_id'));
        expect(simplefin).toBeDefined();
        expect(simplefin).toContain('WHERE simplefin_transaction_id IS NOT NULL');
        expect(simplefin).toContain('RAISE WARNING');
        expect(simplefin).not.toContain('DELETE FROM');

        // H6: one 'started' reconciliation session per account — extra
        // started sessions are safely marked abandoned before indexing.
        const reconciliation = sqls.find((s) => s.includes('uq_reconciliation_sessions_started'));
        expect(reconciliation).toBeDefined();
        expect(reconciliation).toContain("SET status = 'abandoned'");
        expect(reconciliation).toContain("WHERE status = 'started'");

        // C4: funding-sweep dedupe key ('autofund:' prefix from
        // funding-rules.service) — duplicates are real money movements, so
        // skip+warn, never delete.
        const autofund = sqls.find((s) => s.includes('uq_transactions_autofund_num'));
        expect(autofund).toBeDefined();
        expect(autofund).toContain("WHERE num LIKE 'autofund:%'");
        expect(autofund).toContain('RAISE WARNING');
        expect(autofund).not.toContain('DELETE FROM');

        // Deliberately absent: a unique on slots(obj_guid, name) would break
        // GnuCash KVP list slots, which legitimately repeat names.
        expect(sqls.some((s) => /CREATE UNIQUE INDEX[^;]*\bslots\b/i.test(s))).toBe(false);
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
