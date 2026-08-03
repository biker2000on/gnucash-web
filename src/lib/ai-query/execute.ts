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
import { maskStringLiterals } from './guardrails';

export type QueryRow = Record<string, unknown>;

const STATEMENT_TIMEOUT_MS = 5000;

/**
 * Prisma's raw parameter inference can mistype bare array parameters, so give
 * every un-cast $1 an explicit ::text[] cast (matches the ANY(${...}::text[])
 * convention used throughout the codebase). Idempotent for already-cast $1.
 *
 * Skips occurrences inside string literals: a search term like '%$1%' is data,
 * and rewriting it would corrupt the query's meaning.
 */
export function castScopeParameter(sql: string): string {
    const masked = maskStringLiterals(sql);
    if (masked === null) return sql;

    const re = /\$1(?!\d)(?!\s*::)/g;
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
        out += sql.slice(last, m.index) + '$1::text[]';
        last = m.index + m[0].length;
    }
    return out + sql.slice(last);
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
    const masked = maskStringLiterals(finalSql);
    // A $1 that only appears inside a string literal is not a bound parameter.
    const usesParameter = (masked ?? finalSql).includes('$1');

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
