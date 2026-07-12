// src/lib/ai-query/execute.ts

/**
 * Execution of validated, AI-generated SQL.
 *
 * Defense in depth on top of the guardrails: the statement runs inside a
 * transaction that is switched to READ ONLY before anything else executes,
 * with a 5s LOCAL statement timeout. The book's account guid array is bound
 * as $1 — the only parameter the generated SQL is allowed to use.
 */

import prisma from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';

export type QueryRow = Record<string, unknown>;

const STATEMENT_TIMEOUT_MS = 5000;

/**
 * Prisma's raw parameter inference can mistype bare array parameters, so give
 * every un-cast $1 an explicit ::text[] cast (matches the ANY(${...}::text[])
 * convention used throughout the codebase). Idempotent for already-cast $1.
 */
export function castScopeParameter(sql: string): string {
    return sql.replace(/\$1(?!\d)(?!\s*::)/g, '$1::text[]');
}

/**
 * Run a validated SELECT with the book's account guids bound as $1.
 * Returns plain JSON-safe rows (bigints as strings, dates as ISO strings).
 */
export async function executeReadOnlyQuery(
    sql: string,
    accountGuids: string[],
): Promise<QueryRow[]> {
    const finalSql = castScopeParameter(sql);
    const usesParameter = finalSql.includes('$1');

    const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        // Guardrails require $1 whenever book tables are referenced; a query
        // like `SELECT 1` legitimately has no parameter slot.
        return usesParameter
            ? await tx.$queryRawUnsafe<QueryRow[]>(finalSql, accountGuids)
            : await tx.$queryRawUnsafe<QueryRow[]>(finalSql);
    });

    return serializeBigInts(rows);
}
