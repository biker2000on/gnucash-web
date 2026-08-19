/**
 * The account-ancestor walk, as ONE SQL fragment.
 *
 * GnuCash accounts carry no book foreign key: ownership is established by
 * walking `parent_guid` up to the ROOT account a `books` row names. Three
 * call sites needed that walk — book membership (`book-scope.ts`), advisory
 * lock keying (`book-lock.ts`), and inventory posting validation
 * (`inventory-engine.ts`) — and each carried its own copy, which meant the
 * depth guard that keeps the recursion terminating on an already-cyclic tree
 * had to be right in three places independently.
 *
 * The guard is the reason this is shared rather than merely repeated: an
 * `accounts` table with a parent cycle (which corrupt books do have) makes an
 * unbounded `WITH RECURSIVE` walk spin until the statement timeout, and a
 * missing depth bound in ONE of three copies is invisible until that book
 * shows up.
 */

import { Prisma } from '@prisma/client';

/**
 * Hard ceiling on the upward walk. Far beyond any real chart of accounts
 * (GnuCash's own UI becomes unusable well before this), so it only ever fires
 * on a cycle.
 */
export const MAX_ACCOUNT_DEPTH = 200;

/**
 * `WITH RECURSIVE account_ancestors AS (...)` — the account itself at depth 1,
 * then each parent above it, stopping at the root or at
 * {@link MAX_ACCOUNT_DEPTH}.
 *
 * Columns: `guid`, `parent_guid`, `depth` (1 = the starting account, larger =
 * further up; the tree root is the row with the LARGEST depth).
 *
 * Compose it with the query that consumes it, e.g.
 *
 * ```ts
 * prisma.$queryRaw`
 *   ${ancestorCte(accountGuid)}
 *   SELECT guid FROM account_ancestors ORDER BY depth DESC LIMIT 1
 * `
 * ```
 *
 * @param startGuid the account to walk up from (bound as a parameter)
 */
export function ancestorCte(startGuid: string): Prisma.Sql {
    return Prisma.sql`
        WITH RECURSIVE account_ancestors AS (
            SELECT guid, parent_guid, 1 AS depth
            FROM accounts WHERE guid = ${startGuid}
            UNION ALL
            SELECT parent.guid, parent.parent_guid, account_ancestors.depth + 1
            FROM accounts parent
            JOIN account_ancestors ON parent.guid = account_ancestors.parent_guid
            WHERE account_ancestors.depth < ${MAX_ACCOUNT_DEPTH}
        )
    `;
}
