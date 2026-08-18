/**
 * The RUNTIME invariant on account sibling-name locks
 * (src/lib/account-lock-order.ts).
 *
 * ## Why runtime, and what this replaces
 *
 * The two rules on `accountNameLockKey` used to be checked by a source-text
 * scan (account-name-lock-ordering-source.test.ts). That scan compares BYTE
 * OFFSETS within one file, so it is defeated by ordinary refactoring: move a
 * row write into a helper defined ABOVE the claim and the offsets stay in
 * order while the program executes exactly the forbidden sequence. Its regex
 * also only knew `.accounts.update(...)`, so a raw `UPDATE accounts` was
 * invisible. It said nothing at all about the ORDER two name locks are taken
 * in — which is the pair of ABBA deadlocks this branch introduced.
 *
 * Both rules are properties of an EXECUTION, so they are checked against one.
 * `indirection defeats a source scan but not this` below is the point of the
 * whole file: it calls a helper defined ABOVE the claim site, which is the
 * exact shape the offset comparison passes, and the invariant still throws.
 */
import { describe, expect, it } from 'vitest';
import {
    AccountLockOrderError,
    AccountRowWriteUnderNameLockError,
    UNORDERED_CLAIM_SITES,
    acquireAccountNameLock,
    acquireSoleAccountNameLock,
    assertAccountRowWriteAllowed,
    compareLockOrder,
    currentAccountLockScope,
    guidsTargetedBy,
    noteAccountRowInserted,
    noteAccountRowLocked,
    sortByLockOrder,
    withAccountLockScope,
    type AccountLockOrder,
} from '../account-lock-order';

const ROOT = 'r'.repeat(32);
const OTHER_ROOT = 's'.repeat(32);
const PARENT = 'p'.repeat(32);

/**
 * A transaction client that can actually take a lock, as far as this module is
 * concerned: `acquireAccountKeyLockUnchecked` needs `$queryRaw` and a
 * transaction-scoped client, and records what it was asked to lock.
 *
 * `_isTransactionClient` is what `assertTransactionScoped` (src/lib/book-lock.ts)
 * looks for; a client without it is refused as being outside a transaction,
 * which is a different failure from the ones under test here.
 */
function txClient(locked: string[] = []) {
    return {
        _isTransactionClient: true,
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            locked.push(String(values[0]));
            return [{ ok: true }];
        },
    } as never;
}

/**
 * A transaction client whose lock acquisition FAILS.
 *
 * Not a contrived shape: `acquireAccountKeyLockUnchecked` runs a real
 * statement, and a statement can fail — the server can abort the transaction
 * (deadlock, cancellation, timeout) between the claim being recorded and the
 * lock being granted.
 */
const ACQUIRE_FAILURE = 'lock acquisition failed at the server';
function failingTxClient() {
    return {
        _isTransactionClient: true,
        $queryRaw: async () => { throw new Error(ACQUIRE_FAILURE); },
    } as never;
}

const order = (path: string[], root = ROOT): AccountLockOrder => ({ bookRootGuid: root, path });

describe('compareLockOrder — the total order the whole protocol rests on', () => {
    it('puts an ancestor before its own descendants', () => {
        // A path walk descends, so this is the order it claims segments in
        // anyway: a walker is compliant by construction.
        expect(compareLockOrder(order(['Income']), order(['Income', 'Capital Gains']))).toBeLessThan(0);
    });

    it('orders siblings by name', () => {
        expect(compareLockOrder(order(['Trading', 'CURRENCY', 'EUR']), order(['Trading', 'CURRENCY', 'USD']))).toBeLessThan(0);
        expect(compareLockOrder(order(['Trading', 'CURRENCY', 'USD']), order(['Trading', 'CURRENCY', 'EUR']))).toBeGreaterThan(0);
    });

    it('is a TOTAL order across books, so two books never interleave ambiguously', () => {
        const cross = compareLockOrder(order(['A'], ROOT), order(['A'], OTHER_ROOT));
        expect(cross).not.toBe(0);
        // Antisymmetric: reversing the arguments reverses the sign.
        expect(Math.sign(cross)).toBe(-Math.sign(compareLockOrder(order(['A'], OTHER_ROOT), order(['A'], ROOT))));
    });

    it('sortByLockOrder yields the tree pre-order a walk would take', () => {
        const shuffled = [
            order(['Trading', 'CURRENCY', 'USD']),
            order(['Trading']),
            order(['Trading', 'CURRENCY', 'EUR']),
            order(['Trading', 'CURRENCY']),
        ];
        expect(sortByLockOrder(shuffled, o => o).map(o => o.path.join(':'))).toEqual([
            'Trading',
            'Trading:CURRENCY',
            'Trading:CURRENCY:EUR',
            'Trading:CURRENCY:USD',
        ]);
    });
});

describe('RULE 1 — ordering between two name locks', () => {
    it('allows claims that ascend the order', async () => {
        const locked: string[] = [];
        await withAccountLockScope(async () => {
            const tx = txClient(locked);
            await acquireAccountNameLock(tx, ROOT, 'Trading', order(['Trading']));
            await acquireAccountNameLock(tx, PARENT, 'EUR', order(['Trading', 'CURRENCY', 'EUR']));
            await acquireAccountNameLock(tx, PARENT, 'USD', order(['Trading', 'CURRENCY', 'USD']));
        });
        expect(locked).toHaveLength(3);
    });

    it('THROWS on the trading-account ABBA: EUR claimed after USD', async () => {
        await withAccountLockScope(async () => {
            const tx = txClient();
            await acquireAccountNameLock(tx, PARENT, 'USD', order(['Trading', 'CURRENCY', 'USD']));
            await expect(
                acquireAccountNameLock(tx, PARENT, 'EUR', order(['Trading', 'CURRENCY', 'EUR'])),
            ).rejects.toBeInstanceOf(AccountLockOrderError);
        });
    });

    it('THROWS on the importer ABBA: a second planned account claimed backwards', async () => {
        await withAccountLockScope(async () => {
            const tx = txClient();
            await acquireAccountNameLock(tx, ROOT, 'Utilities', order(['Utilities']));
            await expect(
                acquireAccountNameLock(tx, ROOT, 'Groceries', order(['Groceries'])),
            ).rejects.toBeInstanceOf(AccountLockOrderError);
        });
    });

    it('re-claiming a key this transaction already holds is not out of order', async () => {
        const locked: string[] = [];
        await withAccountLockScope(async () => {
            const tx = txClient(locked);
            await acquireAccountNameLock(tx, ROOT, 'Income', order(['Income']));
            await acquireAccountNameLock(tx, ROOT, 'Zebra', order(['Zebra']));
            // Back to Income — same KEY, so nothing new is being waited on.
            await acquireAccountNameLock(tx, ROOT, 'Income', order(['Income']));
        });
        expect(locked).toHaveLength(3);
    });

    it('refuses a path that does not describe the claimed node', async () => {
        // A path that does not end in the locked name orders nothing, so
        // accepting it would let a caller opt out of the order by accident.
        await withAccountLockScope(async () => {
            await expect(
                acquireAccountNameLock(txClient(), ROOT, 'USD', order(['Trading', 'CURRENCY', 'EUR'])),
            ).rejects.toThrow(/does not end in the locked name/);
        });
    });

    it('rejects an unregistered unordered-claim site', async () => {
        await withAccountLockScope(async () => {
            await expect(
                acquireAccountNameLock(txClient(), ROOT, 'A', order(['A']), 'not-a-real-site'),
            ).rejects.toThrow(/Unknown unordered-claim site/);
        });
    });

    it('pins the registered unordered sites, so the list cannot grow silently', () => {
        // Growing this list weakens the invariant. It may only change with a
        // deliberate edit here, next to the reason each entry exists.
        expect(Object.keys(UNORDERED_CLAIM_SITES).sort()).toEqual(['lot-scrub:capital-gains']);
    });

    it('a registered site LOGS instead of throwing, and still takes the lock', async () => {
        const locked: string[] = [];
        const errors: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
        try {
            await withAccountLockScope(async () => {
                const tx = txClient(locked);
                await acquireAccountNameLock(tx, PARENT, 'Short Term', order(['Income', 'Capital Gains', 'Short Term']));
                await acquireAccountNameLock(
                    tx, PARENT, 'Long Term', order(['Income', 'Capital Gains', 'Long Term']),
                    'lot-scrub:capital-gains',
                );
            });
        } finally {
            console.error = original;
        }
        expect(locked).toHaveLength(2);
        expect(errors.join('\n')).toMatch(/lot-scrub:capital-gains/);
    });
});

describe('sole claims — the escape hatch that cannot grow', () => {
    it('a single claim needs no order', async () => {
        const locked: string[] = [];
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(locked), PARENT, 'Cash');
        });
        expect(locked).toEqual([`account:${PARENT}:Cash`]);
    });

    it('re-claiming the SAME key is still a sole claim', async () => {
        await withAccountLockScope(async () => {
            const tx = txClient();
            await acquireSoleAccountNameLock(tx, PARENT, 'Cash');
            await expect(acquireSoleAccountNameLock(tx, PARENT, 'Cash')).resolves.toBe(true);
        });
    });

    it('a SECOND, different sole claim throws rather than going unordered', async () => {
        await withAccountLockScope(async () => {
            const tx = txClient();
            await acquireSoleAccountNameLock(tx, PARENT, 'Cash');
            await expect(acquireSoleAccountNameLock(tx, PARENT, 'Savings'))
                .rejects.toBeInstanceOf(AccountLockOrderError);
        });
    });

    it('an ORDERED claim beside a sole claim throws: the two cannot be compared', async () => {
        await withAccountLockScope(async () => {
            const tx = txClient();
            await acquireSoleAccountNameLock(tx, PARENT, 'Cash');
            await expect(acquireAccountNameLock(tx, ROOT, 'Zebra', order(['Zebra'])))
                .rejects.toThrow(/SOLE account name lock/);
        });
    });
});

describe('RULE 2 — level 2 (row lock) before level 3 (name lock)', () => {
    it('permits the legitimate order: row-lock first, THEN claim the name key', async () => {
        // This is exactly what AccountService.update and .move do, and the
        // whole level ordering exists to keep it working: the rename has to
        // write the row it locked, after it has claimed the destination key.
        await withAccountLockScope(async () => {
            noteAccountRowLocked(PARENT);
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            expect(() => assertAccountRowWriteAllowed('update', { guid: PARENT })).not.toThrow();
        });
    });

    it('THROWS when the row lock is taken UNDER a name lock — the reversal itself', async () => {
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            expect(() => noteAccountRowLocked(PARENT)).toThrow(AccountRowWriteUnderNameLockError);
        });
    });

    it('a row locked in a DIFFERENT transaction buys this one nothing', async () => {
        await withAccountLockScope(async () => { noteAccountRowLocked(PARENT); });
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            expect(() => assertAccountRowWriteAllowed('update', { guid: PARENT }))
                .toThrow(AccountRowWriteUnderNameLockError);
        });
    });

    it('permits an accounts write when no name lock is held', async () => {
        await withAccountLockScope(async () => {
            expect(() => assertAccountRowWriteAllowed('update', { guid: PARENT })).not.toThrow();
        });
    });

    it('THROWS on a write to a row this transaction neither inserted nor locked', async () => {
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            expect(() => assertAccountRowWriteAllowed('update', { guid: PARENT }))
                .toThrow(AccountRowWriteUnderNameLockError);
        });
    });

    it('permits a write to a row this transaction INSERTed', async () => {
        // The importers fix up account_type on the guids they just created.
        // Those rows are invisible to every other session until COMMIT, so no
        // other backend can hold or want a lock on them.
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            noteAccountRowInserted('a'.repeat(32));
            expect(() => assertAccountRowWriteAllowed('updateMany', { guid: { in: ['a'.repeat(32)] } }))
                .not.toThrow();
        });
    });

    it('THROWS when only SOME of the targeted guids were inserted here', async () => {
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            noteAccountRowInserted('a'.repeat(32));
            expect(() => assertAccountRowWriteAllowed('updateMany', { guid: { in: ['a'.repeat(32), 'b'.repeat(32)] } }))
                .toThrow(AccountRowWriteUnderNameLockError);
        });
    });

    it('treats a `where` it cannot resolve as a VIOLATION, not as permission', async () => {
        // The point of the check is to catch the write nobody thought about,
        // so an unrecognised shape must fail closed.
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            expect(() => assertAccountRowWriteAllowed('updateMany', { parent_guid: PARENT }))
                .toThrow(AccountRowWriteUnderNameLockError);
        });
    });

    it('guidsTargetedBy resolves only the shapes it can actually reason about', () => {
        expect(guidsTargetedBy({ guid: PARENT })).toEqual([PARENT]);
        expect(guidsTargetedBy({ guid: { in: [PARENT, ROOT] } })).toEqual([PARENT, ROOT]);
        expect(guidsTargetedBy({ guid: { not: PARENT } })).toBeNull();
        expect(guidsTargetedBy({ name: 'Cash' })).toBeNull();
        expect(guidsTargetedBy(undefined)).toBeNull();
    });
});

describe('the scope itself', () => {
    it('is per-transaction: two scopes do not see each other', async () => {
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
        });
        // A different transaction claims a DIFFERENT sole key and is fine —
        // if the scopes leaked, this would be "a second sole claim".
        await withAccountLockScope(async () => {
            await expect(acquireSoleAccountNameLock(txClient(), PARENT, 'Savings')).resolves.toBe(true);
        });
    });

    it('tracks nothing outside a transaction rather than inventing a scope', async () => {
        // Honest behaviour, and deliberate: a fallback keyed on the client
        // OBJECT merges the several logically separate calls a unit test makes
        // through one fake client into one apparent transaction, and reports
        // ordering violations no real transaction could commit.
        expect(currentAccountLockScope()).toBeNull();
        await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
        await acquireSoleAccountNameLock(txClient(), PARENT, 'Savings');
    });
});

describe('MUTATION PROOF — the invariant is load-bearing where a source scan is not', () => {
    /**
     * The exact shape that defeats an offset-comparing source scan: the
     * forbidden operation lives in a helper defined ABOVE the claim site, so
     * the file's byte offsets read "write, then claim" while the EXECUTION is
     * "claim, then write".
     */
    async function claimTheOtherSibling(tx: never) {
        return acquireAccountNameLock(tx, PARENT, 'EUR', order(['Trading', 'CURRENCY', 'EUR']));
    }
    function reconcileAnExistingRow() {
        return assertAccountRowWriteAllowed('update', { guid: PARENT });
    }

    it('catches an out-of-order claim made through one level of indirection', async () => {
        await withAccountLockScope(async () => {
            const tx = txClient();
            await acquireAccountNameLock(tx, PARENT, 'USD', order(['Trading', 'CURRENCY', 'USD']));
            // Nothing at this call site names a key, an order, or a lock.
            await expect(claimTheOtherSibling(tx)).rejects.toThrow(/Out-of-order account name lock/);
        });
    });

    it('catches a row write made through one level of indirection', async () => {
        await withAccountLockScope(async () => {
            await acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            expect(reconcileAnExistingRow).toThrow(AccountRowWriteUnderNameLockError);
        });
    });
});

describe('TOCTOU — the invariant must survive two claims in flight at once', () => {
    /**
     * The evasion. Both claims used to read `scope.held`, `await` the
     * acquisition, and append only afterwards; two calls started together both
     * observed an empty scope, both acquired, and nothing was raised.
     */
    it('THROWS on two concurrent SOLE claims that both saw an empty scope', async () => {
        await withAccountLockScope(async () => {
            const tx = txClient();
            await expect(
                Promise.all([
                    acquireSoleAccountNameLock(tx, PARENT, 'Zebra'),
                    acquireSoleAccountNameLock(tx, PARENT, 'Apple'),
                ]),
            ).rejects.toBeInstanceOf(AccountLockOrderError);
        });
    });

    it('THROWS on two concurrent ORDERED claims taken backwards', async () => {
        // Claiming USD then EUR concurrently is the trading-account ABBA
        // itself; sequentially it already threw, and it must not become legal
        // merely by being issued in parallel.
        await withAccountLockScope(async () => {
            const tx = txClient();
            await expect(
                Promise.all([
                    acquireAccountNameLock(tx, PARENT, 'USD', order(['Trading', 'CURRENCY', 'USD'])),
                    acquireAccountNameLock(tx, PARENT, 'EUR', order(['Trading', 'CURRENCY', 'EUR'])),
                ]),
            ).rejects.toThrow(/Out-of-order account name lock/);
        });
    });

    it('records the claim BEFORE awaiting, observably', async () => {
        // The mechanism, asserted directly rather than only through its
        // effect: the entry exists while the acquisition is still in flight.
        await withAccountLockScope(async () => {
            const inFlight = acquireSoleAccountNameLock(txClient(), PARENT, 'Cash');
            expect(currentAccountLockScope()?.held.map(h => h.key))
                .toEqual([`account:${PARENT}:Cash`]);
            await inFlight;
        });
    });

    it('still allows two concurrent claims that ASCEND the order', async () => {
        // The fix must not turn every parallel claim into an error — only the
        // ones that actually run the order backwards.
        const locked: string[] = [];
        await withAccountLockScope(async () => {
            const tx = txClient(locked);
            await Promise.all([
                acquireAccountNameLock(tx, PARENT, 'EUR', order(['Trading', 'CURRENCY', 'EUR'])),
                acquireAccountNameLock(tx, PARENT, 'USD', order(['Trading', 'CURRENCY', 'USD'])),
            ]);
        });
        expect(locked).toHaveLength(2);
    });
});

describe('ROLLBACK — a failed acquisition must not strand a phantom key', () => {
    it('removes a SOLE claim whose acquisition failed', async () => {
        await withAccountLockScope(async () => {
            await expect(acquireSoleAccountNameLock(failingTxClient(), PARENT, 'Cash'))
                .rejects.toThrow(ACQUIRE_FAILURE);
            expect(currentAccountLockScope()?.held).toEqual([]);
        });
    });

    it('lets the NEXT legitimate sole claim through after a failure', async () => {
        // The failure mode that matters. Callers catch and retry — withAdoptionRetry
        // (src/lib/book-lock.ts) is built on exactly that — so a stranded entry
        // breaks the RETRY, not the attempt that failed.
        await withAccountLockScope(async () => {
            await expect(acquireSoleAccountNameLock(failingTxClient(), PARENT, 'Cash'))
                .rejects.toThrow(ACQUIRE_FAILURE);
            await expect(acquireSoleAccountNameLock(txClient(), PARENT, 'Savings'))
                .resolves.toBe(true);
        });
    });

    it('removes an ORDERED claim whose acquisition failed', async () => {
        await withAccountLockScope(async () => {
            await expect(
                acquireAccountNameLock(failingTxClient(), PARENT, 'USD', order(['Trading', 'CURRENCY', 'USD'])),
            ).rejects.toThrow(ACQUIRE_FAILURE);
            expect(currentAccountLockScope()?.held).toEqual([]);
        });
    });

    it('lets a LOWER-sorting key through after a higher one failed', async () => {
        // A stranded 'USD' would make this legitimate claim of 'EUR' look like
        // the ABBA violation — a false alarm on a transaction holding nothing.
        await withAccountLockScope(async () => {
            await expect(
                acquireAccountNameLock(failingTxClient(), PARENT, 'USD', order(['Trading', 'CURRENCY', 'USD'])),
            ).rejects.toThrow(ACQUIRE_FAILURE);
            await expect(
                acquireAccountNameLock(txClient(), PARENT, 'EUR', order(['Trading', 'CURRENCY', 'EUR'])),
            ).resolves.toBe(true);
        });
    });

    it('rolls back BY IDENTITY, keeping a concurrent same-key claim\'s record', async () => {
        // Two claims of the SAME key in flight, one failing. The survivor's
        // record must remain, or the transaction goes on holding a lock the
        // invariant no longer knows about.
        await withAccountLockScope(async () => {
            const good = txClient();
            const settled = await Promise.allSettled([
                acquireSoleAccountNameLock(good, PARENT, 'Cash'),
                acquireSoleAccountNameLock(failingTxClient(), PARENT, 'Cash'),
            ]);
            expect(settled.map(s => s.status)).toEqual(['fulfilled', 'rejected']);
            expect(currentAccountLockScope()?.held.map(h => h.key))
                .toEqual([`account:${PARENT}:Cash`]);
        });
    });
});
