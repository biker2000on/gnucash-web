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
    'gnucash_web_category_mappings',
    'gnucash_web_import_batches',
    'gnucash_web_amazon_orders',
    'gnucash_web_entity_profiles',
    'gnucash_web_entity_members',
    'gnucash_web_book_features',
    'gnucash_web_book_links',
    'gnucash_web_compliance_status',
    'gnucash_web_vendor_tax_info',
    'gnucash_web_packages',
    'gnucash_web_funds',
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
 * Lazily-created raw-SQL tables (not in the Prisma schema) with a book_guid
 * column. Deleted best-effort with a guard, since they may not exist yet.
 */
export const LAZY_BOOK_GUID_TABLES = [
    'gnucash_web_email_bills',
    'gnucash_web_notifications',
    // Deleted before saved_reports below; the FK on saved_report_id also
    // cascades, but base-type-only schedules have no other cleanup path.
    'gnucash_web_report_schedules',
] as const;

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
 * Best-effort deletion of stored files (S3 or filesystem). Failures are
 * logged and never abort the DB cleanup — a missing file must not leave
 * the book half-deleted.
 */
async function deleteStoredFilesBestEffort(bookGuid: string): Promise<void> {
    let keys: string[] = [];
    try {
        const [receipts, payslips, documents, homePhotos] = await Promise.all([
            prisma.gnucash_web_receipts.findMany({
                where: { book_guid: bookGuid },
                select: { storage_key: true, thumbnail_key: true },
            }),
            prisma.gnucash_web_payslips.findMany({
                where: { book_guid: bookGuid },
                select: { storage_key: true, thumbnail_key: true },
            }),
            prisma.gnucash_web_entity_documents.findMany({
                where: { book_guid: bookGuid },
                select: { file_key: true },
            }),
            prisma.gnucash_web_home_item_photos.findMany({
                where: { book_guid: bookGuid },
                select: { photo_key: true },
            }),
        ]);
        keys = [
            ...collectKeys(receipts),
            ...collectKeys(payslips),
            ...collectKeys(documents),
            ...collectKeys(homePhotos),
        ];
    } catch (err) {
        console.warn('[book-cleanup] failed to enumerate stored files, skipping file deletion:', err);
        return;
    }

    if (keys.length === 0) return;

    let storage;
    try {
        storage = await getStorageBackend();
    } catch (err) {
        console.warn('[book-cleanup] storage backend unavailable, skipping file deletion:', err);
        return;
    }

    for (const key of keys) {
        try {
            await storage.delete(key);
        } catch (err) {
            console.warn(`[book-cleanup] failed to delete stored file "${key}":`, err);
        }
    }
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
 * Delete all extension-table rows and stored files belonging to a book.
 *
 * @param bookGuid     GUID of the book being deleted
 * @param accountGuids All account GUIDs under the book's root (and template
 *                     root), used for account/split/transaction-keyed tables
 *
 * Must be called BEFORE the core GnuCash rows (splits, transactions,
 * accounts, book) are removed. All Prisma-schema deletes share one
 * sequential transaction; file deletions and lazy-table deletes run
 * best-effort outside it.
 */
export async function deleteBookExtensionData(
    bookGuid: string,
    accountGuids: string[],
): Promise<void> {
    // 1. Stored files first (needs the DB rows to find the keys). Best-effort.
    await deleteStoredFilesBestEffort(bookGuid);

    // 2. Lazy raw-SQL tables (may not exist) — guarded, outside the transaction.
    await deleteLazyTableRows(bookGuid);

    // 3. All Prisma-schema extension rows in one sequential transaction,
    //    FK children before parents (explicit even where cascades exist,
    //    since parts of the live DB were created via raw DDL).
    const hasAccounts = accountGuids.length > 0;
    const ops: Prisma.PrismaPromise<unknown>[] = [
        // Membership module (attendance → payments → members/types/meetings)
        prisma.gnucash_web_meeting_attendance.deleteMany({
            where: {
                OR: [
                    { meeting: { book_guid: bookGuid } },
                    { member: { book_guid: bookGuid } },
                ],
            },
        }),
        prisma.gnucash_web_membership_payments.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_members.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_membership_types.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_meetings.deleteMany({ where: { book_guid: bookGuid } }),

        // Packages (redemptions → packages)
        prisma.gnucash_web_package_redemptions.deleteMany({
            where: { package: { book_guid: bookGuid } },
        }),
        prisma.gnucash_web_packages.deleteMany({ where: { book_guid: bookGuid } }),

        // Estimates (lines → estimates)
        prisma.gnucash_web_estimate_lines.deleteMany({
            where: { estimate: { book_guid: bookGuid } },
        }),
        prisma.gnucash_web_estimates.deleteMany({ where: { book_guid: bookGuid } }),

        // Funds (account_funds junction → funds)
        prisma.gnucash_web_account_funds.deleteMany({
            where: hasAccounts
                ? {
                    OR: [
                        { fund: { book_guid: bookGuid } },
                        { account_guid: { in: accountGuids } },
                    ],
                }
                : { fund: { book_guid: bookGuid } },
        }),
        prisma.gnucash_web_funds.deleteMany({ where: { book_guid: bookGuid } }),

        // Home module (service log → tasks → photos → items → rooms)
        prisma.gnucash_web_home_service_log.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_home_tasks.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_home_item_photos.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_home_items.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_home_rooms.deleteMany({ where: { book_guid: bookGuid } }),

        // Imports (orders before batches — orders reference batch id)
        prisma.gnucash_web_amazon_orders.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_import_batches.deleteMany({ where: { book_guid: bookGuid } }),

        // SimpleFIN (account map → connections)
        prisma.gnucash_web_simplefin_account_map.deleteMany({
            where: { connection: { book_guid: bookGuid } },
        }),
        prisma.gnucash_web_simplefin_connections.deleteMany({ where: { book_guid: bookGuid } }),

        // Tags (junctions → tags). Tags are book-scoped; junction rows are
        // removed both via the book's tags and via the book's accounts.
        prisma.gnucash_web_transaction_tags.deleteMany({
            where: { tag: { book_guid: bookGuid } },
        }),
        prisma.gnucash_web_account_tags.deleteMany({
            where: hasAccounts
                ? {
                    OR: [
                        { tag: { book_guid: bookGuid } },
                        { account_guid: { in: accountGuids } },
                    ],
                }
                : { tag: { book_guid: bookGuid } },
        }),
        prisma.gnucash_web_tags.deleteMany({ where: { book_guid: bookGuid } }),

        // Documents / receipts / payslips (files already deleted above)
        prisma.gnucash_web_receipts.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_payslips.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_payslip_mappings.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_payslip_templates.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_entity_documents.deleteMany({ where: { book_guid: bookGuid } }),

        // Access control
        prisma.gnucash_web_book_permissions.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_invitations.deleteMany({ where: { book_guid: bookGuid } }),

        // Per-book config and misc
        prisma.gnucash_web_tool_config.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_category_mappings.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_entity_members.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_entity_profiles.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_book_features.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_book_links.deleteMany({
            where: {
                OR: [
                    { business_book_guid: bookGuid },
                    { household_book_guid: bookGuid },
                ],
            },
        }),
        prisma.gnucash_web_compliance_status.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_vendor_tax_info.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_invoice_shares.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_dunning_log.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_dunning_optout.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_dunning_settings.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_time_entries.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_book_settings.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_budget_funding_rules.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_renewals.deleteMany({ where: { book_guid: bookGuid } }),
        prisma.gnucash_web_saved_reports.deleteMany({ where: { book_guid: bookGuid } }),
    ];

    if (hasAccounts) {
        // Account-keyed tables
        ops.push(
            prisma.gnucash_web_account_preferences.deleteMany({
                where: { account_guid: { in: accountGuids } },
            }),
            prisma.gnucash_web_tax_mappings.deleteMany({
                where: { account_guid: { in: accountGuids } },
            }),
            prisma.gnucash_web_depreciation_schedules.deleteMany({
                where: { account_guid: { in: accountGuids } },
            }),
        );

        // Split/transaction-keyed tables — cleaned via the book's splits,
        // which still exist because this runs before the core deletion.
        ops.push(
            prisma.$executeRaw`
                DELETE FROM gnucash_web_contribution_tax_year
                WHERE split_guid IN (
                    SELECT guid FROM splits WHERE account_guid = ANY(${accountGuids}::text[])
                )
            `,
            prisma.$executeRaw`
                DELETE FROM gnucash_web_transaction_types
                WHERE split_guid IN (
                    SELECT guid FROM splits WHERE account_guid = ANY(${accountGuids}::text[])
                )
            `,
            prisma.$executeRaw`
                DELETE FROM gnucash_web_transaction_meta
                WHERE transaction_guid IN (
                    SELECT DISTINCT tx_guid FROM splits WHERE account_guid = ANY(${accountGuids}::text[])
                )
            `,
        );
    }

    await prisma.$transaction(ops);
}
