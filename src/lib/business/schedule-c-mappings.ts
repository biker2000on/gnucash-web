/**
 * Schedule C account-mapping store — persistent MANUAL overrides that map an
 * expense account GUID to an IRS Schedule C expense line, layered over the
 * keyword heuristic in `business-reports.ts` (mapExpenseAccountToLine).
 *
 * The backing table is NOT part of the Prisma schema (the GnuCash DB rejects
 * `prisma db push`), so it is created lazily via raw SQL under an advisory
 * lock — the same pattern as `src/lib/notifications.ts`. Do NOT add this table
 * to `db-init.ts`.
 */

import prisma from '@/lib/prisma';
import { isValidScheduleCLine } from './business-reports';

export { isValidScheduleCLine };

/* ------------------------------------------------------------------ */
/* Pure validation                                                      */
/* ------------------------------------------------------------------ */

export interface MappingChange {
    accountGuid: string;
    /** Target Schedule C line, or null to remove (unmap) the override. */
    line: string | null;
}

export interface PartitionedChanges {
    upserts: Array<{ accountGuid: string; line: string }>;
    deletes: string[];
}

/** Thrown by `partitionMappingChanges` for a bad guid or invalid line. */
export class ScheduleCMappingValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ScheduleCMappingValidationError';
    }
}

/**
 * PURE. Validate and split a batch of mapping changes into upserts + deletes.
 *   - Each account GUID must be a 32-char GUID within `bookAccountGuids`.
 *   - `line === null` removes the override (delete).
 *   - A non-null `line` must be a valid Schedule C expense line, else throws.
 * Throws `ScheduleCMappingValidationError` on the first invalid entry.
 */
export function partitionMappingChanges(
    changes: ReadonlyArray<MappingChange>,
    bookAccountGuids: ReadonlySet<string>,
): PartitionedChanges {
    const upserts: Array<{ accountGuid: string; line: string }> = [];
    const deletes: string[] = [];

    for (const change of changes) {
        const guid = change?.accountGuid;
        if (typeof guid !== 'string' || guid.length !== 32 || !bookAccountGuids.has(guid)) {
            throw new ScheduleCMappingValidationError(
                `Invalid or out-of-book account guid: ${String(guid)}`,
            );
        }
        if (change.line === null) {
            deletes.push(guid);
        } else if (isValidScheduleCLine(change.line)) {
            upserts.push({ accountGuid: guid, line: change.line });
        } else {
            throw new ScheduleCMappingValidationError(
                `Invalid Schedule C line: ${String(change.line)}`,
            );
        }
    }

    return { upserts, deletes };
}

/* ------------------------------------------------------------------ */
/* Lazy table creation                                                  */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensureScheduleCMappingsTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                    PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_schedule_c_mappings_schema'));

                    CREATE TABLE IF NOT EXISTS gnucash_web_schedule_c_mappings (
                        account_guid VARCHAR(32) PRIMARY KEY,
                        schedule_c_line VARCHAR(8) NOT NULL,
                        created_at TIMESTAMP DEFAULT now(),
                        updated_at TIMESTAMP DEFAULT now()
                    );
                END $$;
            `);
        })();
    }
    return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* Read / write                                                         */
/* ------------------------------------------------------------------ */

/**
 * Manual Schedule C overrides for the given book accounts, keyed by account
 * GUID → line. Invalid stored lines (e.g. from a future/removed rule set) are
 * skipped so the report always falls back to the keyword heuristic for them.
 */
export async function getMappings(
    bookAccountGuids: string[],
): Promise<Record<string, string>> {
    await ensureScheduleCMappingsTable();
    if (bookAccountGuids.length === 0) return {};

    const rows = await prisma.$queryRaw<
        Array<{ account_guid: string; schedule_c_line: string }>
    >`
        SELECT account_guid, schedule_c_line
        FROM gnucash_web_schedule_c_mappings
        WHERE account_guid = ANY(${bookAccountGuids}::text[])
    `;

    const map: Record<string, string> = {};
    for (const row of rows) {
        if (isValidScheduleCLine(row.schedule_c_line)) {
            map[row.account_guid] = row.schedule_c_line;
        }
    }
    return map;
}

/**
 * Apply a batch of mapping changes. Validates via `partitionMappingChanges`
 * (throws `ScheduleCMappingValidationError` on bad input) before touching the
 * DB. null lines delete the override; valid lines upsert it.
 */
export async function saveMappings(
    changes: ReadonlyArray<MappingChange>,
    bookAccountGuids: string[],
): Promise<void> {
    const { upserts, deletes } = partitionMappingChanges(
        changes,
        new Set(bookAccountGuids),
    );

    await ensureScheduleCMappingsTable();

    if (deletes.length > 0) {
        await prisma.$executeRaw`
            DELETE FROM gnucash_web_schedule_c_mappings
            WHERE account_guid = ANY(${deletes}::text[])
        `;
    }

    for (const upsert of upserts) {
        await prisma.$executeRaw`
            INSERT INTO gnucash_web_schedule_c_mappings (account_guid, schedule_c_line)
            VALUES (${upsert.accountGuid}, ${upsert.line})
            ON CONFLICT (account_guid) DO UPDATE
                SET schedule_c_line = EXCLUDED.schedule_c_line,
                    updated_at = now()
        `;
    }
}
