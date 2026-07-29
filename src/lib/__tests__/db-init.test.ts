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

    it('creates the new performance indexes and no longer creates retired ones', async () => {
        await initializeDatabase();

        const sqls = mocks.query.mock.calls.map((c) => String(c[0]));
        const creates = sqls.filter((s) => s.includes('CREATE INDEX IF NOT EXISTS'));

        // New indexes
        expect(creates.some((s) => s.includes('idx_splits_lot_guid')
            && s.includes('WHERE lot_guid IS NOT NULL'))).toBe(true);
        expect(creates.some((s) => s.includes('idx_lots_account_guid'))).toBe(true);
        expect(creates.some((s) => s.includes('idx_slots_name_obj'))).toBe(true);
        expect(creates.some((s) => s.includes('idx_transactions_guid_postdate')
            && s.includes('INCLUDE (post_date)'))).toBe(true);

        // Retired: varchar_pattern_ops can never serve ILIKE '%...%' searches
        expect(creates.some((s) => s.includes('idx_transactions_description'))).toBe(false);
        // Retired: the non-unique simplefin id index duplicates the unique
        // partial index created by the constraint guards (the _2 match-column
        // index is a different index and must remain)
        expect(sqls.some((s) => /CREATE INDEX IF NOT EXISTS idx_txn_meta_simplefin_id\s/.test(s))).toBe(false);
        expect(sqls.some((s) => /CREATE INDEX IF NOT EXISTS idx_txn_meta_simplefin_id_2\s/.test(s))).toBe(true);
    });

    it('drops redundant indexes behind an advisory lock, guarded on superseding indexes', async () => {
        await initializeDatabase();

        const sqls = mocks.query.mock.calls.map((c) => String(c[0]));
        const drop = sqls.find((s) => s.includes('gnucash_web_drop_redundant_indexes'));
        expect(drop).toBeDefined();
        expect(drop).toContain("pg_advisory_xact_lock(hashtext('gnucash_web_drop_redundant_indexes'))");

        // Prefix duplicates drop only once a superseding index exists
        expect(drop).toContain('DROP INDEX IF EXISTS splits_account_guid_index');
        expect(drop).toMatch(/to_regclass\('idx_splits_account_covering'\) IS NOT NULL[\s\S]*DROP INDEX IF EXISTS splits_account_guid_index/);
        expect(drop).toContain('DROP INDEX IF EXISTS slots_guid_index');
        expect(drop).toMatch(/to_regclass\('idx_slots_obj_name'\) IS NOT NULL[\s\S]*DROP INDEX IF EXISTS slots_guid_index/);

        // The non-unique simplefin index goes only when the unique one exists
        expect(drop).toContain('DROP INDEX IF EXISTS idx_txn_meta_simplefin_id');
        expect(drop).toMatch(/to_regclass\('uq_txn_meta_simplefin_id'\) IS NOT NULL[\s\S]*DROP INDEX IF EXISTS idx_txn_meta_simplefin_id/);

        // Unserviceable pattern-ops index is dropped unconditionally
        expect(drop).toContain('DROP INDEX IF EXISTS idx_transactions_description');
    });

    it('tunes autovacuum on the hot tables behind an advisory lock', async () => {
        await initializeDatabase();

        const sqls = mocks.query.mock.calls.map((c) => String(c[0]));
        const tuning = sqls.find((s) => s.includes('gnucash_web_autovacuum_tuning'));
        expect(tuning).toBeDefined();
        expect(tuning).toContain("pg_advisory_xact_lock(hashtext('gnucash_web_autovacuum_tuning'))");
        expect(tuning).toContain('ALTER TABLE splits SET (autovacuum_vacuum_scale_factor = 0.05)');
        expect(tuning).toContain('ALTER TABLE transactions SET (autovacuum_vacuum_scale_factor = 0.05)');
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
