/**
 * Source guard for the lock-ordering rule on `accountNameLockKey`
 * (src/lib/book-lock.ts): a transaction holding a sibling-name lock must not
 * acquire a row-level lock on an account row it did not itself INSERT.
 *
 * Why a source guard rather than a behavioural test. The rule binds every
 * module that holds one of those keys, including the ones that hold it
 * TRANSITIVELY by calling `findOrCreateAccount` / `findOrCreateAccountDetailed`
 * / `ensureTypedAccount` — and that transitive set is exactly where it kept
 * getting broken. `addTemplateAccounts` broke it directly;
 * `bootstrapInventoryAccounts`, the invoice A/R–A/P bootstrap and the two
 * importers broke it through a find-or-create call. Each break is a deadlock
 * against a concurrent rename, reproduced as a real SQLSTATE 40P01 in
 * src/lib/services/__tests__/account-lock-hierarchy-deadlock.integration.test.ts,
 * and none of them is visible from the module that defines the ordering.
 *
 * So the inventory below is exact: a NEW account-row write in any module that
 * can hold a name lock fails this test and has to be justified here, at which
 * point whoever adds it has to work out which phase it belongs in.
 *
 * This guard covers the level-2/level-3 ordering only. Ordering between two
 * name locks is a separate, partly open question — see the closing section of
 * `accountNameLockKey`.
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
    /\baccountNameLockKey\b|\bfindOrCreateAccount(?:Detailed)?\b|\bensureTypedAccount\b/;

/** Prisma writes against an existing `accounts` row. `create` is exempt by design. */
const PRISMA_ACCOUNT_WRITE = /\.accounts\.(?:update|updateMany|delete|deleteMany|upsert)\(/g;

/** Raw row locks taken on the `accounts` table. */
const RAW_ACCOUNT_ROW_LOCK = /\bFROM\s+accounts\b[\s\S]{0,200}?FOR\s+UPDATE/gi;

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && /\.tsx?$/.test(path) && !path.includes('/__tests__/')
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
            return count > 0 ? [{ path: relative(SOURCE_ROOT, file), count }] : [];
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
            const claims = [...source.matchAll(/acquireNamedXactLock\(\s*\w+\s*,\s*accountNameLockKey/g)];
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
