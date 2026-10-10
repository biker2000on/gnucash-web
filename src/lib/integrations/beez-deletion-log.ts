/**
 * The transaction deletion log — how the beez change feed learns that ANY
 * transaction left a book, not only the ones beez pushed.
 *
 * WHY A LOG AT ALL. The feed's original tombstones are derived, not recorded:
 * a `gnucash_web_external_links` row whose transaction is gone IS the
 * deletion. That works only for transactions beez wrote, because only those
 * have a link row. A transaction entered natively in folio (or in GnuCash
 * desktop) and later deleted leaves nothing behind — the row, its splits and
 * its slots are simply gone — so a client that imported it had to rescan the
 * whole book to notice.
 *
 * WHY A TRIGGER, AND WHY ON `splits`. Deletions arrive from many writers: the
 * transaction editor, bulk delete, importers that overwrite, the beez DELETE,
 * the audit undo, and GnuCash desktop writing to the same database. Only a
 * server-side trigger sees every one of them, desktop included, so that is
 * the only place a complete log can be written. The audit table
 * (`gnucash_web_audit`) records app deletions only and would miss desktop.
 *
 * The trigger sits on `splits`, not on `transactions`, because the BOOK a
 * deleted transaction belonged to is only knowable from its splits (a
 * `transactions` row has no book column; the feed's own definition of "in
 * this book" is "has a split on one of its accounts"). Writers delete the two
 * tables in either order — GnuCash desktop removes the transaction row and
 * then its splits; a cascade removes splits after; some app paths remove
 * splits first — so the trigger is a DEFERRED constraint trigger: it runs at
 * COMMIT, when both deletes of the same database transaction have happened,
 * and logs the split only when its transaction no longer exists. A split
 * removed from a transaction that survives (an ordinary edit, a split
 * replacement, a delete-and-reinsert under the same guid) logs nothing.
 *
 * WHAT IT CANNOT SEE, stated plainly:
 *   - a transaction whose splits were all removed in an EARLIER database
 *     transaction and whose empty row was deleted later. An empty transaction
 *     is in no book by the feed's definition, so it has nothing to attribute
 *     the deletion to;
 *   - a deletion committed while the trigger was missing — e.g. after a
 *     GnuCash desktop schema upgrade rebuilt `splits` (its table upgrade
 *     copies into a new table, which drops triggers). db-init re-installs the
 *     trigger at every application start, and `GET status` only advertises
 *     the `transaction-deletions` capability while the trigger is actually
 *     present, so a client knows when it must fall back to a full rescan;
 *   - a split whose ACCOUNT was deleted in the same database transaction:
 *     the book is then unresolvable and the row is never reported (the
 *     account had to be emptied first anyway, which is the case above).
 *
 * ONE ROW PER TRANSACTION, keyed by guid. A transaction deleted, restored by
 * the audit undo, and deleted again moves its row forward in time, so the
 * second deletion is reported too. A restored transaction is suppressed at
 * READ time (the feed only reports a logged guid that does not exist now), so
 * a restore needs no cleanup here.
 *
 * `deleted_at` is `clock_timestamp()` read at commit time on the UTC scale
 * `enter_date` uses, so the window in which a row can become visible BEHIND a
 * stamp a reader has already passed is the few milliseconds between the
 * trigger firing and the commit completing — far inside the feed's two-hour
 * overlap.
 *
 * Retention: none yet. A row is four short columns per deleted transaction.
 *
 * This module is deliberately free of Prisma so db-init can import it.
 */

/** The trigger's name — also what `GET status` looks for in `pg_trigger`. */
export const DELETION_LOG_TRIGGER = 'gnucash_web_splits_deletion_log';

/** Capability string `GET status` advertises while the trigger is installed. */
export const DELETION_FEED_CAPABILITY = 'transaction-deletions';

/**
 * Idempotent DDL, run by db-init at every start. The table and function are
 * cheap to re-assert; the trigger is created only when it is missing, so a
 * steady-state start takes no lock on `splits` (a table GnuCash desktop may be
 * holding), and a missing trigger is created under a short lock timeout that
 * degrades to a warning rather than hanging startup.
 */
export const TRANSACTION_DELETION_LOG_SQL = `
    DO $$
    BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_transaction_deletions_schema'));
        CREATE TABLE IF NOT EXISTS gnucash_web_transaction_deletions (
            tx_guid VARCHAR(32) PRIMARY KEY,
            book_guid VARCHAR(32),
            account_guid VARCHAR(32) NOT NULL,
            deleted_at TIMESTAMP(6) NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_transaction_deletions_book_deleted
            ON gnucash_web_transaction_deletions (book_guid, deleted_at, tx_guid);
    END $$;

    CREATE OR REPLACE FUNCTION gnucash_web_log_transaction_deletion()
    RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
        v_book VARCHAR(32);
    BEGIN
        -- A split removed from a transaction that still exists is an edit.
        IF EXISTS (SELECT 1 FROM transactions WHERE guid = OLD.tx_guid) THEN
            RETURN NULL;
        END IF;
        WITH RECURSIVE up(guid, parent_guid, depth) AS (
            SELECT a.guid, a.parent_guid, 0 FROM accounts a WHERE a.guid = OLD.account_guid
            UNION ALL
            SELECT a.guid, a.parent_guid, up.depth + 1
            FROM accounts a JOIN up ON a.guid = up.parent_guid
            WHERE up.depth < 64
        )
        SELECT b.guid INTO v_book
        FROM books b JOIN up ON b.root_account_guid = up.guid
        LIMIT 1;
        INSERT INTO gnucash_web_transaction_deletions AS d
            (tx_guid, book_guid, account_guid, deleted_at)
        VALUES (OLD.tx_guid, v_book, OLD.account_guid, clock_timestamp() AT TIME ZONE 'UTC')
        ON CONFLICT (tx_guid) DO UPDATE SET
            deleted_at = EXCLUDED.deleted_at,
            book_guid = COALESCE(EXCLUDED.book_guid, d.book_guid),
            account_guid = CASE WHEN EXCLUDED.book_guid IS NOT NULL
                                THEN EXCLUDED.account_guid ELSE d.account_guid END;
        RETURN NULL;
    END
    $fn$;

    DO $$
    BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_transaction_deletions_trigger'));
        IF to_regclass('splits') IS NULL THEN
            RAISE WARNING 'splits table missing; transaction deletion log trigger not installed';
            RETURN;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = to_regclass('splits') AND tgname = '${DELETION_LOG_TRIGGER}'
        ) THEN
            PERFORM set_config('lock_timeout', '5s', true);
            BEGIN
                CREATE CONSTRAINT TRIGGER ${DELETION_LOG_TRIGGER}
                    AFTER DELETE ON splits
                    DEFERRABLE INITIALLY DEFERRED
                    FOR EACH ROW EXECUTE FUNCTION gnucash_web_log_transaction_deletion();
            EXCEPTION WHEN lock_not_available THEN
                RAISE WARNING 'splits is locked (GnuCash desktop?); transaction deletion log trigger not installed this start';
            END;
        END IF;
    END $$;
`;
