/**
 * Book Cleanup Service
 *
 * Deletes all extension-table rows (gnucash_web_*) and stored files that
 * belong to a book, so that DELETE /api/books/[guid] leaves no orphans
 * behind when it removes the GnuCash core rows (splits, transactions,
 * accounts, budgets, the book row itself).
 *
 * Call `deleteBookExtensionData()` BEFORE deleting the core rows: several
 * cleanups derive their row sets from the book's splits/transactions, which
 * must still exist at that point.
 *
 * The exported model lists below double as a regression guard: the test in
 * `__tests__/book-cleanup.test.ts` parses prisma/schema.prisma and fails if
 * a model with a book_guid column is neither covered nor explicitly excluded.
 */

import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import { deleteAvgBasisHistoryForAccounts } from '@/lib/avg-basis-history';

/**
 * Prisma models with a *book_guid column that are deleted by this service.
 * (gnucash_web_book_links is keyed by business_book_guid/household_book_guid
 * and is deleted when the book appears in EITHER column.)
 */
export const COVERED_BOOK_GUID_MODELS = [
    'gnucash_web_tool_config',
    'gnucash_web_receipts',
    'gnucash_web_payslips',
    'gnucash_web_payslip_mappings',
    'gnucash_web_payslip_templates',
    'gnucash_web_book_permissions',
    'gnucash_web_invitations',
    'gnucash_web_simplefin_connections',
    'gnucash_web_tags',
    'gnucash_web_import_batches',
    'gnucash_web_entity_profiles',
    'gnucash_web_entity_members',
    'gnucash_web_book_features',
    'gnucash_web_book_links',
    'gnucash_web_compliance_status',
    'gnucash_web_vendor_tax_info',
    'gnucash_web_vendor_1099_filings',
    'gnucash_web_packages',
    'gnucash_web_funds',
    'gnucash_web_documents',
    'gnucash_web_document_links',
    'gnucash_web_entity_documents',
    'gnucash_web_membership_types',
    'gnucash_web_members',
    'gnucash_web_membership_payments',
    'gnucash_web_meetings',
    'gnucash_web_invoice_shares',
    'gnucash_web_estimates',
    'gnucash_web_dunning_settings',
    'gnucash_web_dunning_log',
    'gnucash_web_dunning_optout',
    'gnucash_web_time_entries',
    'gnucash_web_book_settings',
    'gnucash_web_budget_funding_rules',
    'gnucash_web_renewals',
    'gnucash_web_home_rooms',
    'gnucash_web_home_items',
    'gnucash_web_home_item_photos',
    'gnucash_web_home_tasks',
    'gnucash_web_home_service_log',
    'gnucash_web_saved_reports',
    'gnucash_web_external_links',
] as const;

/**
 * Models with a book_guid column that are INTENTIONALLY not deleted.
 * Key = model name, value = documented reason.
 */
export const EXCLUDED_BOOK_GUID_MODELS: Record<string, string> = {
    // Audit rows are append-only history. They survive book deletion by
    // design so admins can still see who deleted what; their book_guid
    // simply points at a book that no longer exists.
    gnucash_web_audit: 'audit history is retained intentionally after book deletion',

    // This row must outlive generic extension cleanup: the book DELETE route
    // uses it to find the native budgets, removes restrictive recurrence rows,
    // then deletes the budgets. Ownership is removed by the budget FK cascade.
    // Deleting it here first would orphan the native budgets permanently.
    gnucash_web_budget_ownership:
        'deleteOwnedBudgetsForBook deletes native budgets recurrence-first; ownership then cascades',

    // Same lifecycle problem as budgets: these rows are the only record of
    // which book owns a native customer/vendor/invoice. Deleting them with the
    // generic sweep would strand those native rows permanently — unowned means
    // foreign, so they would be invisible to every book. The book DELETE route
    // calls deleteOwnedBusinessEntitiesForBook(), which removes the native
    // entities child-first and drops these rows itself.
    gnucash_web_business_entity_ownership:
        'deleteOwnedBusinessEntitiesForBook deletes native business entities child-first, then these rows',
};

/**
 * Models keyed by account_guid (no book_guid column) cleaned via the
 * book's account GUID list.
 */
export const ACCOUNT_KEYED_MODELS = [
    'gnucash_web_account_preferences',
    'gnucash_web_tax_mappings',
    'gnucash_web_account_tags',
    'gnucash_web_account_funds',
    'gnucash_web_depreciation_schedules',
] as const;

/**
 * Tables keyed by split/transaction GUID (no book_guid column) cleaned via
 * raw SQL subqueries against the book's splits — these must run BEFORE the
 * core splits/transactions rows are deleted.
 */
export const SPLIT_OR_TXN_KEYED_TABLES = [
    'gnucash_web_contribution_tax_year', // keyed by split_guid
    'gnucash_web_transaction_types',     // keyed by split_guid
    'gnucash_web_transaction_meta',      // keyed by transaction_guid
] as const;

/**
 * Lazily-created raw-SQL tables (not in the Prisma schema) keyed by LOT guid.
 *
 * Neither of the lists around this one fits them: they have no book_guid, and
 * unlike the split-keyed tables above they may not exist yet, so their delete
 * is probed with to_regclass first rather than issued blind. Their rows are
 * reached through `lots`, so they must be cleaned while the lots still exist.
 */
export const LAZY_LOT_KEYED_TABLES = [
    'gnucash_web_avg_basis_history', // keyed by lot_guid; see src/lib/avg-basis-history.ts
] as const;

/**
 * Lazily-created raw-SQL tables (not in the Prisma schema) with a book_guid
 * column. Deleted best-effort with a guard, since they may not exist yet.
 */
export const LAZY_BOOK_GUID_TABLES = [
    'gnucash_web_email_bills',
    'gnucash_web_notifications',
    'gnucash_web_financial_actions',
    'gnucash_web_financial_action_refresh',
    'gnucash_web_calculation_traces',
    // Upgrade safety: these tables are no longer created or modeled, but old
    // installations may retain them until a separate data-retirement decision.
    'gnucash_web_amazon_orders',
    'gnucash_web_category_mappings',
    // Deleted before saved_reports below; the FK on saved_report_id also
    // cascades, but base-type-only schedules have no other cleanup path.
    'gnucash_web_report_schedules',
] as const;

/**
 * Any client that can run the extension-row deletes: the app's (extended)
 * Prisma client or one of its interactive-transaction clients.
 */
export type BookCleanupClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Collect non-null storage keys from rows. */
function collectKeys(rows: Array<Record<string, string | null>>): string[] {
    const keys: string[] = [];
    for (const row of rows) {
        for (const value of Object.values(row)) {
            if (value) keys.push(value);
        }
    }
    return keys;
}

/**
 * Enumerate the storage keys (S3/filesystem) belonging to a book. Must run
 * while the DB rows still exist — inside the deletion transaction is fine
 * (pass the tx client), so files can be removed AFTER the commit.
 * Enumeration failures are logged and return an empty list.
 */
export async function collectBookStorageKeys(
    bookGuid: string,
    db: BookCleanupClient = prisma,
): Promise<string[]> {
    try {
        const [receipts, payslips, entityDocuments, homePhotos] = await Promise.all([
            db.gnucash_web_receipts.findMany({
                where: { book_guid: bookGuid },
                select: { storage_key: true, thumbnail_key: true },
            }),
            db.gnucash_web_payslips.findMany({
                where: { book_guid: bookGuid },
                select: { storage_key: true, thumbnail_key: true },
            }),
            db.gnucash_web_entity_documents.findMany({
                where: { book_guid: bookGuid },
                select: { file_key: true },
            }),
            db.gnucash_web_home_item_photos.findMany({
                where: { book_guid: bookGuid },
                select: { photo_key: true },
            }),
        ]);
        // Canonical metadata was introduced after the specialised tables. A
        // partially upgraded installation may not have it yet, so preserve
        // legacy key enumeration even when this one optional read fails.
        let canonicalDocuments: Array<{ storage_key: string | null }> = [];
        try {
            canonicalDocuments = await db.gnucash_web_documents.findMany({
                where: { book_guid: bookGuid },
                select: { storage_key: true },
            });
        } catch (err) {
            console.warn('[book-cleanup] canonical document keys unavailable, continuing:', err);
        }
        return [...new Set([
            ...collectKeys(receipts),
            ...collectKeys(payslips),
            ...collectKeys(canonicalDocuments),
            ...collectKeys(entityDocuments),
            ...collectKeys(homePhotos),
        ])];
    } catch (err) {
        console.warn('[book-cleanup] failed to enumerate stored files, skipping file deletion:', err);
        return [];
    }
}

/**
 * Best-effort deletion of stored file keys (S3 or filesystem). Failures are
 * logged and never abort — a missing file must not leave the book
 * half-deleted.
 */
export async function deleteStoredFileKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    let storage;
    try {
        storage = await getStorageBackend();
    } catch (err) {
        console.warn('[book-cleanup] storage backend unavailable, skipping file deletion:', err);
        return;
    }

    for (const key of new Set(keys)) {
        try {
            await storage.delete(key);
        } catch (err) {
            console.warn(`[book-cleanup] failed to delete stored file "${key}":`, err);
        }
    }
}

/**
 * Best-effort deletion of stored files (S3 or filesystem). Failures are
 * logged and never abort the DB cleanup — a missing file must not leave
 * the book half-deleted.
 */
async function deleteStoredFilesBestEffort(bookGuid: string): Promise<void> {
    const keys = await collectBookStorageKeys(bookGuid);
    await deleteStoredFileKeys(keys);
}

/**
 * Delete rows from lazily-created tables that may not exist yet. Each runs
 * outside the main transaction (a missing-table error would poison it) and
 * is individually guarded.
 */
async function deleteLazyTableRows(bookGuid: string): Promise<void> {
    for (const table of LAZY_BOOK_GUID_TABLES) {
        try {
            await prisma.$executeRawUnsafe(
                `DELETE FROM ${table} WHERE book_guid = $1`,
                bookGuid,
            );
        } catch (err) {
            // Table not created yet (42P01) or similar — nothing to clean.
            console.warn(`[book-cleanup] skipped lazy table ${table}:`, err);
        }
    }
}

/**
 * Delete rows from lazily-created tables on the caller's transaction client.
 * Unlike {@link deleteLazyTableRows}, a missing-table error would poison the
 * surrounding transaction, so each table's existence is checked first via
 * to_regclass() — transaction-safe on tables that may not exist yet.
 */
async function deleteLazyTableRowsTransactional(
    db: BookCleanupClient,
    bookGuid: string,
): Promise<void> {
    for (const table of LAZY_BOOK_GUID_TABLES) {
        // Table names come from the compile-time constant list above.
        const rows = await db.$queryRawUnsafe<Array<{ reg: string | null }>>(
            `SELECT to_regclass('${table}')::text AS reg`,
        );
        if (!rows?.[0]?.reg) continue; // table not created yet
        await db.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE book_guid = $1`,
            bookGuid,
        );
    }
}

/**
 * Delete every extension-table DB row belonging to a book, on the caller's
 * client. Pass an interactive-transaction client to make the cleanup atomic
 * with the core-row deletion (see DELETE /api/books/[guid]) — file/storage
 * cleanup is NOT done here (collect keys first with collectBookStorageKeys,
 * delete them after commit with deleteStoredFileKeys).
 *
 * Must run BEFORE the core GnuCash rows (splits, transactions, accounts,
 * book) are removed: several row sets derive from the book's splits.
 * Deletes run FK children before parents (explicit even where cascades
 * exist, since parts of the live DB were created via raw DDL).
 */
export async function deleteBookExtensionRows(
    db: BookCleanupClient,
    bookGuid: string,
    accountGuids: string[],
    options: { includeLazyTables?: boolean } = {},
): Promise<void> {
    if (options.includeLazyTables) {
        await deleteLazyTableRowsTransactional(db, bookGuid);
    }

    const hasAccounts = accountGuids.length > 0;
    const ops: Prisma.PrismaPromise<unknown>[] = [
        // Remove canonical edges before any typed targets, then metadata before
        // specialised source rows. This also protects installations whose
        // raw-DDL foreign keys predate the current cascade definitions.
        db.gnucash_web_document_links.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_documents.deleteMany({ where: { book_guid: bookGuid } }),

        // Membership module (attendance → payments → members/types/meetings)
        db.gnucash_web_meeting_attendance.deleteMany({
            where: {
                OR: [
                    { meeting: { book_guid: bookGuid } },
                    { member: { book_guid: bookGuid } },
                ],
            },
        }),
        db.gnucash_web_membership_payments.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_members.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_membership_types.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_meetings.deleteMany({ where: { book_guid: bookGuid } }),

        // Packages (redemptions → packages)
        db.gnucash_web_package_redemptions.deleteMany({
            where: { package: { book_guid: bookGuid } },
        }),
        db.gnucash_web_packages.deleteMany({ where: { book_guid: bookGuid } }),

        // Estimates (lines → estimates)
        db.gnucash_web_estimate_lines.deleteMany({
            where: { estimate: { book_guid: bookGuid } },
        }),
        db.gnucash_web_estimates.deleteMany({ where: { book_guid: bookGuid } }),

        // Funds (account_funds junction → funds)
        db.gnucash_web_account_funds.deleteMany({
            where: hasAccounts
                ? {
                    OR: [
                        { fund: { book_guid: bookGuid } },
                        { account_guid: { in: accountGuids } },
                    ],
                }
                : { fund: { book_guid: bookGuid } },
        }),
        db.gnucash_web_funds.deleteMany({ where: { book_guid: bookGuid } }),

        // Home module (service log → tasks → photos → items → rooms)
        db.gnucash_web_home_service_log.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_home_tasks.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_home_item_photos.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_home_items.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_home_rooms.deleteMany({ where: { book_guid: bookGuid } }),

        // Import history
        db.gnucash_web_import_batches.deleteMany({ where: { book_guid: bookGuid } }),

        // External-system identity map (beez-trackz and any future
        // integration). These rows deliberately outlive the transactions they
        // point at — that is how the change feed reports a deletion — but they
        // must NOT outlive the book: a guid can be reused, and a stale link
        // would then claim a transaction in a book that never had one.
        db.gnucash_web_external_links.deleteMany({ where: { book_guid: bookGuid } }),

        // SimpleFIN (account map → connections)
        db.gnucash_web_simplefin_account_map.deleteMany({
            where: { connection: { book_guid: bookGuid } },
        }),
        db.gnucash_web_simplefin_connections.deleteMany({ where: { book_guid: bookGuid } }),

        // Tags (junctions → tags). Tags are book-scoped; junction rows are
        // removed both via the book's tags and via the book's accounts.
        db.gnucash_web_transaction_tags.deleteMany({
            where: { tag: { book_guid: bookGuid } },
        }),
        db.gnucash_web_account_tags.deleteMany({
            where: hasAccounts
                ? {
                    OR: [
                        { tag: { book_guid: bookGuid } },
                        { account_guid: { in: accountGuids } },
                    ],
                }
                : { tag: { book_guid: bookGuid } },
        }),
        db.gnucash_web_tags.deleteMany({ where: { book_guid: bookGuid } }),

        // Specialised document sources (storage keys were collected above).
        db.gnucash_web_receipts.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_payslips.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_payslip_mappings.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_payslip_templates.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_entity_documents.deleteMany({ where: { book_guid: bookGuid } }),

        // Access control
        db.gnucash_web_book_permissions.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_invitations.deleteMany({ where: { book_guid: bookGuid } }),

        // Per-book config and misc
        db.gnucash_web_tool_config.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_entity_members.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_entity_profiles.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_book_features.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_book_links.deleteMany({
            where: {
                OR: [
                    { business_book_guid: bookGuid },
                    { household_book_guid: bookGuid },
                ],
            },
        }),
        db.gnucash_web_compliance_status.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_vendor_tax_info.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_vendor_1099_filings.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_invoice_shares.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_dunning_log.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_dunning_optout.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_dunning_settings.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_time_entries.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_book_settings.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_budget_funding_rules.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_renewals.deleteMany({ where: { book_guid: bookGuid } }),
        db.gnucash_web_saved_reports.deleteMany({ where: { book_guid: bookGuid } }),
    ];

    if (hasAccounts) {
        // Account-keyed tables
        ops.push(
            db.gnucash_web_account_preferences.deleteMany({
                where: { account_guid: { in: accountGuids } },
            }),
            db.gnucash_web_tax_mappings.deleteMany({
                where: { account_guid: { in: accountGuids } },
            }),
            db.gnucash_web_depreciation_schedules.deleteMany({
                where: { account_guid: { in: accountGuids } },
            }),
        );

        // Split/transaction-keyed tables — cleaned via the book's splits,
        // which still exist because this runs before the core deletion.
        ops.push(
            db.$executeRaw`
                DELETE FROM gnucash_web_contribution_tax_year
                WHERE split_guid IN (
                    SELECT guid FROM splits WHERE account_guid = ANY(${accountGuids}::text[])
                )
            `,
            db.$executeRaw`
                DELETE FROM gnucash_web_transaction_types
                WHERE split_guid IN (
                    SELECT guid FROM splits WHERE account_guid = ANY(${accountGuids}::text[])
                )
            `,
            db.$executeRaw`
                DELETE FROM gnucash_web_transaction_meta
                WHERE transaction_guid IN (
                    SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY(${accountGuids}::text[])
                )
            `,
        );
    }

    // Execute sequentially on the caller's client. When `db` is an
    // interactive-transaction client this is atomic with the caller's other
    // work; when it is the root client each delete commits independently
    // (legacy behavior of deleteBookExtensionData below wraps this in its
    // own transaction).
    for (const op of ops) {
        await op;
    }

    // The average-cost write history (src/lib/avg-basis-history.ts) is
    // app-owned, keyed by lot GUID, and has no FK to `lots`, so nothing removes
    // it when the book's lots go. It is also LAZILY created, so it cannot join
    // `ops` as a bare $executeRaw — a 42P01 on a database that never
    // provisioned it would poison the caller's transaction. The helper probes
    // with to_regclass first, the same way deleteLazyTableRowsTransactional
    // does.
    //
    // Like the split-keyed deletes above, this depends on running BEFORE the
    // core rows: the lot GUIDs are found through `lots`, which the caller is
    // about to delete.
    if (hasAccounts) {
        await deleteAvgBasisHistoryForAccounts(accountGuids, db);
    }
}

/**
 * Legacy all-in-one cleanup: stored files, lazy tables (best-effort, outside
 * any transaction), then all Prisma-schema extension rows in one
 * transaction.
 *
 * Prefer the split building blocks for new callers — collectBookStorageKeys
 * + deleteBookExtensionRows inside YOUR transaction, deleteStoredFileKeys
 * after commit — so a failed core deletion cannot leave extension data
 * already destroyed (see DELETE /api/books/[guid]).
 */
export async function deleteBookExtensionData(
    bookGuid: string,
    accountGuids: string[],
): Promise<void> {
    // This removes app-owned blobs referenced by the deleted book. Producing a
    // durable blob archive (or claiming the ledger-only backup contains those
    // blobs) is intentionally outside this cleanup service's scope.
    // 1. Stored files first (needs the DB rows to find the keys). Best-effort.
    await deleteStoredFilesBestEffort(bookGuid);

    // 2. Lazy raw-SQL tables (may not exist) — guarded, outside the transaction.
    await deleteLazyTableRows(bookGuid);

    // 3. All Prisma-schema extension rows in one transaction.
    await prisma.$transaction(
        (tx) => deleteBookExtensionRows(tx, bookGuid, accountGuids),
        { timeout: 120_000, maxWait: 15_000 },
    );
}
