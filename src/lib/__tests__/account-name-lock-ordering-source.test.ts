/**
 * A CHEAP TRIPWIRE over the sibling-name lock rules — NOT their enforcement.
 *
 * ## Read this before trusting anything below
 *
 * This file greps source text. It cannot see what a program DOES, and the two
 * rules on `accountNameLockKey` (src/lib/book-lock.ts) are both properties of
 * an execution:
 *
 *   - The inventory below is a REGEX INVENTORY. It matches
 *     `.accounts.update(...)` and a `FROM accounts ... FOR UPDATE` shape. A row
 *     write reached through an ORM helper, a raw `UPDATE accounts SET ...`, a
 *     `$executeRaw` built from a template, or any other spelling is invisible
 *     to it.
 *   - The positional check is POSITIONAL. It compares byte offsets of the last
 *     row write and the first key claim WITHIN ONE FILE. Moving a row write
 *     into a helper defined ABOVE the claim keeps the offsets in order while
 *     the program still executes name-lock-then-row-update, which is exactly
 *     the bug. It also says nothing about a write in a different module called
 *     from between the two.
 *
 * Both rules are actually enforced at RUNTIME, against the execution, by
 * src/lib/account-lock-order.ts:
 *
 *   - ordering between two name locks — every claim goes through
 *     `acquireAccountNameLock`/`acquireSoleAccountNameLock`, and
 *     `acquireNamedXactLock` refuses `account:` keys outright so there is no
 *     way around the funnel;
 *   - account-row writes under a held name lock — a Prisma query extension in
 *     src/lib/prisma.ts checks every `accounts` update/delete against the
 *     guids the same transaction INSERTed.
 *
 * See src/lib/__tests__/account-lock-order.test.ts and
 * src/lib/services/__tests__/trading-account-lock-order.integration.test.ts.
 *
 * ## So why keep this file
 *
 * Because it is nearly free and it fails EARLY — at `vitest run`, with a
 * filename, before anything opens a database. A new `.accounts.update(...)` in
 * a module that can hold a name lock is worth a second look even when the
 * runtime invariant would also catch it, and the justifications below are a
 * useful record of why each existing write is safe. Treat a pass here as "no
 * obvious new writer", never as "the ordering rules hold".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(process.cwd(), 'src');

interface AuditedWriter {
    path: string;
    /** How many account-row write sites the module is allowed to contain. */
    count: number;
    justification: string;
}

/**
 * Every module that can hold a sibling-name lock AND writes an account row,
 * with the reason each write is safe from underneath that lock.
 */
const AUDITED_ACCOUNT_ROW_WRITERS: AuditedWriter[] = [
    {
        path: 'lib/business/invoice-engine.ts',
        count: 1,
        justification:
            'findOrCreatePostAccount phase 2: coerces an EXISTING A/R–A/P account before any key is claimed. Its phase 3 INSERTs with the final account_type and throws SiblingKeyAdoptedError rather than update an adopted row.',
    },
    {
        path: 'lib/default-book.ts',
        count: 1,
        justification:
            'addTemplateAccounts phase 2: promotes an EXISTING account to a placeholder before any key is claimed. Phase 3 only INSERTs, and throws SiblingKeyAdoptedError rather than reconcile an adopted node.',
    },
    {
        path: 'lib/import/personal-import.service.ts',
        count: 1,
        justification:
            'Types only the segments findOrCreateAccountDetailed reports in createdGuids — rows this transaction INSERTed, which no other backend can lock.',
    },
    {
        path: 'lib/inventory-engine.ts',
        count: 1,
        justification:
            'bootstrapInventoryAccounts phase 2: coerces EXISTING Inventory / Cost of Goods Sold accounts before any key is claimed. Phase 3 only INSERTs.',
    },
    {
        path: 'lib/qif/importer.ts',
        count: 1,
        justification:
            'Types only the segments findOrCreateAccountDetailed reports in createdGuids — rows this transaction INSERTed, which no other backend can lock.',
    },
    {
        path: 'lib/services/account.service.ts',
        count: 4,
        justification:
            'Defines the ordering rather than obeying it: lockAccountKey takes the FOR UPDATE first and claimSiblingName derives the destination key from it. The two updates are update()/move(); delete() runs on the top-level client with no name lock held.',
    },
];

/**
 * Modules that hold a sibling-name lock directly, or transitively through a
 * find-or-create helper that claims one.
 */
const NAME_LOCK_HOLDER =
    /\bacquire(?:Sole)?AccountNameLock\b|\bfindOrCreateAccount(?:Detailed)?\b|\bensureTypedAccount\b/;

/** Prisma writes against an existing `accounts` row. `create` is exempt by design. */
const PRISMA_ACCOUNT_WRITE = /\.accounts\.(?:update|updateMany|delete|deleteMany|upsert)\(/g;

/** Raw row locks taken on the `accounts` table. */
const RAW_ACCOUNT_ROW_LOCK = /\bFROM\s+accounts\b[\s\S]{0,200}?FOR\s+UPDATE/gi;

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && /\.tsx?$/.test(path) && !path.replaceAll('\\', '/').includes('/__tests__/')
            ? [path]
            : [];
    });
}

function accountRowWriters(): Array<{ path: string; count: number }> {
    return sourceFiles(SOURCE_ROOT)
        .flatMap((file) => {
            const source = readFileSync(file, 'utf8');
            if (!NAME_LOCK_HOLDER.test(source)) return [];
            const count =
                [...source.matchAll(PRISMA_ACCOUNT_WRITE)].length +
                [...source.matchAll(RAW_ACCOUNT_ROW_LOCK)].length;
            return count > 0 ? [{ path: relative(SOURCE_ROOT, file).replaceAll('\\', '/'), count }] : [];
        })
        .sort((a, b) => a.path.localeCompare(b.path));
}

describe('account name-lock ordering source guard', () => {
    it('allows only the audited account-row writes in modules that can hold a sibling-name lock', () => {
        const expected = AUDITED_ACCOUNT_ROW_WRITERS.map(({ path, count }) => ({ path, count })).sort(
            (a, b) => a.path.localeCompare(b.path),
        );
        expect(accountRowWriters()).toEqual(expected);
    });

    it('documents a justification for every audited writer', () => {
        for (const writer of AUDITED_ACCOUNT_ROW_WRITERS) {
            expect(writer.justification.length, writer.path).toBeGreaterThan(40);
        }
    });

    it('keeps the two-phase writers claiming keys only after their row writes', () => {
        // The ordering is positional and therefore checkable: in each of these
        // modules the LAST account-row write must precede the FIRST
        // acquireNamedXactLock of an account key. A future edit that moves a
        // reconciliation below the claim fails here rather than at 3am.
        const twoPhase = [
            'lib/default-book.ts',
            'lib/inventory-engine.ts',
            'lib/business/invoice-engine.ts',
        ];
        for (const relPath of twoPhase) {
            const source = readFileSync(resolve(SOURCE_ROOT, relPath), 'utf8');
            const writes = [...source.matchAll(PRISMA_ACCOUNT_WRITE)];
            const claims = [...source.matchAll(/acquireAccountNameLock\(/g)];
            expect(writes.length, `${relPath}: expected an account-row write`).toBeGreaterThan(0);
            expect(claims.length, `${relPath}: expected a sibling-key claim`).toBeGreaterThan(0);
            const lastWrite = writes[writes.length - 1].index!;
            const firstClaim = claims[0].index!;
            expect(
                lastWrite,
                `${relPath}: an account-row write appears AFTER the sibling-key claim at index ${firstClaim}`,
            ).toBeLessThan(firstClaim);
        }
    });
});
