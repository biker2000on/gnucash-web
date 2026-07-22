/**
 * Schedule F account-mapping store — persistent MANUAL overrides that map an
 * expense account GUID to an IRS Schedule F expense line, layered over the
 * keyword heuristic in `schedule-f.ts` (mapFarmExpenseAccountToLine).
 *
 * The backing table is NOT part of the Prisma schema (the GnuCash DB rejects
 * `prisma db push`), so it is created lazily via raw SQL under an advisory
 * lock — the same pattern as `schedule-c-mappings.ts`. Do NOT add this table
 * to `db-init.ts`.
 */

import prisma from '@/lib/prisma';
import { isValidScheduleFLine } from './schedule-f';

export { isValidScheduleFLine };

/* ------------------------------------------------------------------ */
/* Pure validation                                                      */
/* ------------------------------------------------------------------ */

export interface MappingChange {
    accountGuid: string;
    /** Target Schedule F line, or null to remove (unmap) the override. */
    line: string | null;
}

export interface PartitionedChanges {
    upserts: Array<{ accountGuid: string; line: string }>;
    deletes: string[];
}

/** Thrown by `partitionMappingChanges` for a bad guid or invalid line. */
export class ScheduleFMappingValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ScheduleFMappingValidationError';
    }
}

/**
 * PURE. Validate and split a batch of mapping changes into upserts + deletes.
 * Same contract as the Schedule C variant: guids must be 32-char and in the
 * book; `line === null` deletes; invalid lines throw.
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
            throw new ScheduleFMappingValidationError(
                `Invalid or out-of-book account guid: ${String(guid)}`,
            );
        }
        if (change.line === null) {
            deletes.push(guid);
        } else if (isValidScheduleFLine(change.line)) {
            upserts.push({ accountGuid: guid, line: change.line });
        } else {
            throw new ScheduleFMappingValidationError(
                `Invalid Schedule F line: ${String(change.line)}`,
            );
        }
    }

    return { upserts, deletes };
}

/* ------------------------------------------------------------------ */
/* Lazy table creation                                                  */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensureScheduleFMappingsTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                    PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_schedule_f_mappings_schema'));

                    CREATE TABLE IF NOT EXISTS gnucash_web_schedule_f_mappings (
                        account_guid VARCHAR(32) PRIMARY KEY,
                        schedule_f_line VARCHAR(8) NOT NULL,
                        created_at TIMESTAMP DEFAULT now(),
                        updated_at TIMESTAMP DEFAULT now()
                    );
                END $$;
            `);
        })();
        // A transient failure must not poison the memo for the process
        // lifetime — the DDL is idempotent, so let the next call retry.
        ensurePromise.catch(() => {
            ensurePromise = null;
        });
    }
    return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* Read / write                                                         */
/* ------------------------------------------------------------------ */

/**
 * Manual Schedule F overrides for the given book accounts, keyed by account
 * GUID → line. Invalid stored lines are skipped so the report falls back to
 * the keyword heuristic for them.
 */
export async function getMappings(
    bookAccountGuids: string[],
): Promise<Record<string, string>> {
    await ensureScheduleFMappingsTable();
    if (bookAccountGuids.length === 0) return {};

    const rows = await prisma.$queryRaw<
        Array<{ account_guid: string; schedule_f_line: string }>
    >`
        SELECT account_guid, schedule_f_line
        FROM gnucash_web_schedule_f_mappings
        WHERE account_guid = ANY(${bookAccountGuids}::text[])
    `;

    const map: Record<string, string> = {};
    for (const row of rows) {
        if (isValidScheduleFLine(row.schedule_f_line)) {
            map[row.account_guid] = row.schedule_f_line;
        }
    }
    return map;
}

/**
 * Apply a batch of mapping changes. Validates via `partitionMappingChanges`
 * before touching the DB. null lines delete the override; valid lines upsert.
 */
export async function saveMappings(
    changes: ReadonlyArray<MappingChange>,
    bookAccountGuids: string[],
): Promise<void> {
    const { upserts, deletes } = partitionMappingChanges(
        changes,
        new Set(bookAccountGuids),
    );

    await ensureScheduleFMappingsTable();

    // Atomic: a mid-batch failure must not leave deletes applied with only
    // half the upserts written (the panel clears its pending edits on save).
    await prisma.$transaction(async (tx) => {
        if (deletes.length > 0) {
            await tx.$executeRaw`
                DELETE FROM gnucash_web_schedule_f_mappings
                WHERE account_guid = ANY(${deletes}::text[])
            `;
        }
        for (const upsert of upserts) {
            await tx.$executeRaw`
                INSERT INTO gnucash_web_schedule_f_mappings (account_guid, schedule_f_line)
                VALUES (${upsert.accountGuid}, ${upsert.line})
                ON CONFLICT (account_guid) DO UPDATE
                    SET schedule_f_line = EXCLUDED.schedule_f_line,
                        updated_at = now()
            `;
        }
    });
}
