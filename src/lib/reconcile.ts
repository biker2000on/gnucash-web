/**
 * Manual Reconcile — GnuCash desktop's reconcile window, server side.
 *
 * Reconcile an account against a paper/PDF statement's ending balance without
 * uploading a file. The user picks a statement date + ending balance, ticks
 * uncleared ('n') / cleared ('c') splits posted on or before that date, and
 * finishes only when
 *
 *   difference = ending balance − (reconciled balance + Σ ticked amounts) = 0
 *
 * Finalizing marks the ticked splits reconcile_state='y' with
 * reconcile_date = statement date — the exact same split semantics the
 * statement-upload flow commits in statement-reconcile-data.ts
 * (`updateMany({ data: { reconcile_state: 'y', reconcile_date } })` inside
 * `prisma.$transaction`). That flow's only additional persistence is flipping
 * its own upload batch row to status='reconciled'; a manual reconcile has no
 * batch, so no extra event record is written here.
 *
 * SIGN / UNIT NOTE: balances use the split QUANTITY in the account's
 * commodity (for bank/cash accounts quantity == value). All comparisons are
 * integer-cents math to avoid float drift.
 */

import { randomUUID } from 'node:crypto';
import prisma, { type ExtendedPrismaClient } from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import { acquireNamedXactLock } from '@/lib/book-lock';
import {
    toCents,
    type ReconcileWorkspace,
    type FinalizeReconcileResult,
} from '@/lib/reconcile-shared';

// Pure types + integer-cents math live in reconcile-shared.ts so client
// components can import them without pulling in prisma. Re-exported here so
// '@/lib/reconcile' remains the canonical server-side surface.
export {
    toCents,
    computeDifference,
    computeDifferenceCents,
    toggleCandidateSelection,
    type ReconcileCandidate,
    type ReconcileWorkspace,
    type FinalizeReconcileResult,
} from '@/lib/reconcile-shared';

/** Typed error the API route maps to 400/404/409. */
export class ManualReconcileError extends Error {
    constructor(
        message: string,
        readonly code: 'not_found' | 'not_zero' | 'bad_request',
        readonly detail?: unknown,
    ) {
        super(message);
        this.name = 'ManualReconcileError';
    }
}

/** The subset of the client finalize needs — satisfied by both the singleton
 *  and the interactive-transaction client. */
export type ReconcileTx = Pick<ExtendedPrismaClient, 'splits' | '$executeRaw' | '$queryRaw'>;

export interface ReconciliationCompletion {
    bookGuid: string;
    userId: number;
    sessionId?: string | null;
    interactionDelta?: number;
}

/** Inclusive end-of-day (UTC) for a statement date, so every split posted on
 *  the statement date itself qualifies regardless of its stored time. */
export function statementDateCutoff(statementDate: Date): Date {
    const cutoff = new Date(statementDate);
    cutoff.setUTCHours(23, 59, 59, 999);
    return cutoff;
}

/* ─────────────────────────── workspace ─────────────────────────── */

/**
 * Sum 'y' split quantities in cents + max reconcile_date, as ONE SQL
 * aggregate (old accounts carry 10k+ reconciled splits — loading them all
 * into JS just to sum them was the reconcile page's dominant cost).
 *
 * Exactness: the JS version computed per-row
 * `Math.round(num / denom * 100)` and summed the integers. The SQL
 * equivalent is per-row `FLOOR(num * 100 / denom + 0.5)` in exact NUMERIC
 * arithmetic — FLOOR(x + 0.5) is precisely Math.round's round-half-up
 * (toward +∞) behavior, including for negative halves — summed as a bigint.
 * For currency splits (denom divides 100) no rounding occurs at all, so
 * results are bit-identical to the previous implementation.
 */
async function summarizeReconciled(
    db: Pick<ReconcileTx, '$queryRaw'>,
    accountGuid: string,
): Promise<{ reconciledCents: number; lastReconcileDate: Date | null }> {
    const rows = await db.$queryRaw<Array<{
        reconciled_cents: bigint | null;
        last_reconcile_date: Date | null;
    }>>`
        SELECT
            SUM(FLOOR(quantity_num * 100::numeric / quantity_denom + 0.5))::bigint AS reconciled_cents,
            MAX(reconcile_date) AS last_reconcile_date
        FROM splits
        WHERE account_guid = ${accountGuid}
          AND reconcile_state = 'y'
    `;
    return {
        reconciledCents: Number(rows[0]?.reconciled_cents ?? 0n),
        lastReconcileDate: rows[0]?.last_reconcile_date ?? null,
    };
}

/**
 * Build the reconcile workspace for an account: last-reconciliation info and
 * the candidate ('n'/'c') splits posted on or before the statement date.
 */
export async function getReconcileWorkspace(
    accountGuid: string,
    statementDate: Date,
): Promise<ReconcileWorkspace> {
    const account = await prisma.accounts.findUnique({
        where: { guid: accountGuid },
        select: {
            guid: true,
            name: true,
            account_type: true,
            commodity: { select: { mnemonic: true } },
        },
    });
    if (!account) {
        throw new ManualReconcileError('Account not found', 'not_found');
    }

    const { reconciledCents, lastReconcileDate } = await summarizeReconciled(prisma, accountGuid);

    const cutoff = statementDateCutoff(statementDate);
    const candidateRows = await prisma.$queryRaw<Array<{
        guid: string;
        tx_guid: string;
        memo: string | null;
        reconcile_state: string;
        quantity_num: bigint;
        quantity_denom: bigint;
        post_date: Date | null;
        enter_date: Date | null;
        num: string | null;
        description: string | null;
    }>>`
        SELECT s.guid, s.tx_guid, s.memo, s.reconcile_state, s.quantity_num, s.quantity_denom,
               t.post_date, t.enter_date, t.num, t.description
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ${accountGuid}
          AND s.reconcile_state IN ('n', 'c')
          AND t.post_date <= ${cutoff}
        ORDER BY t.post_date ASC, t.enter_date ASC, s.guid ASC
    `;
    const completedSessions = await prisma.$queryRaw<Array<{
        statement_date: Date;
    }>>`
        SELECT statement_date
          FROM gnucash_web_reconciliation_sessions
         WHERE account_guid = ${accountGuid}
           AND status = 'completed'
           AND statement_date IS NOT NULL
         ORDER BY statement_date DESC
         LIMIT 1
    `;
    const completedThrough = completedSessions[0]?.statement_date ?? null;
    const verifiedThrough =
        completedThrough && (!lastReconcileDate || completedThrough > lastReconcileDate)
            ? completedThrough
            : lastReconcileDate;

    return {
        account: {
            guid: account.guid,
            name: account.name,
            account_type: account.account_type,
            currency: account.commodity?.mnemonic ?? null,
        },
        statementDate: statementDate.toISOString(),
        lastReconcileDate: verifiedThrough ? verifiedThrough.toISOString() : null,
        reconciledBalance: reconciledCents / 100,
        candidates: candidateRows.map((r) => ({
            guid: r.guid,
            transactionGuid: r.tx_guid,
            date: r.post_date ? r.post_date.toISOString() : '',
            enterDate: r.enter_date ? r.enter_date.toISOString() : null,
            num: r.num ?? '',
            description: r.description ?? '',
            memo: r.memo ?? '',
            amount: toDecimalNumber(r.quantity_num, r.quantity_denom),
            state: r.reconcile_state === 'c' ? 'c' : 'n',
        })),
    };
}

/* ─────────────────────────── finalize ─────────────────────────── */

/**
 * Finalize a manual reconciliation.
 *
 * Recomputes the difference SERVER-SIDE from the database (never trusting the
 * client's arithmetic): loads the requested splits, validates them (must
 * exist, belong to the account, not already 'y', and be posted on or before
 * the statement date), re-sums the current reconciled balance, and only when
 *
 *   toCents(endingBalance) − (reconciledCents + selectedCents) === 0
 *
 * marks exactly those splits reconcile_state='y' with
 * reconcile_date = statementDate. Runs inside prisma.$transaction (or an
 * injected transaction client) so validation and the write are atomic.
 */
export async function finalizeReconciliation(
    accountGuid: string,
    statementDate: Date,
    endingBalance: number,
    splitGuids: string[],
    tx?: ReconcileTx,
    completion?: ReconciliationCompletion,
): Promise<FinalizeReconcileResult> {
    const uniqueGuids = [...new Set(splitGuids)];

    const run = async (db: ReconcileTx): Promise<FinalizeReconcileResult> => {
        // Serialize concurrent finalizes on this account with a
        // transaction-scoped advisory lock, taken as the FIRST statement of
        // the in-tx work: a second finalize blocks here until the first
        // commits, then re-reads post-commit state — so its tie-out and
        // already-reconciled checks run against live data instead of a
        // pre-transaction snapshot. (This replaces the previous
        // FOR UPDATE over EVERY split row of the account, which locked
        // 10k+ rows on old accounts and blocked all concurrent ledger
        // edits on the account for the duration of the finalize. The
        // advisory lock serializes finalizes only; the specific rows we
        // write are guarded by the canonical parent-transaction row locks
        // taken below.)
        await acquireNamedXactLock(db, `reconcile:${accountGuid}`);

        // Load and validate the requested splits (re-validated AFTER locking).
        let selectedCents = 0;
        if (uniqueGuids.length > 0) {
            // Canonical lock order (same as the transaction PUT/DELETE
            // routes): lock the parent TRANSACTION rows first, ordered by
            // guid, before reading/writing splits. A concurrent transaction
            // save locks its transactions row before touching splits, so
            // taking the same locks in the same order makes an ABBA deadlock
            // impossible — and the enter_date bump below then updates rows
            // this transaction already holds locks on.
            const preRead = await db.splits.findMany({
                where: { guid: { in: uniqueGuids } },
                select: { guid: true, tx_guid: true },
            });
            const parentTxGuids = [...new Set(preRead.map((s) => s.tx_guid))].sort();
            if (parentTxGuids.length > 0) {
                await db.$queryRaw`
                    SELECT guid FROM transactions
                    WHERE guid = ANY(${parentTxGuids}::text[])
                    ORDER BY guid
                    FOR UPDATE
                `;
            }

            // Validated read AFTER the row locks are held, so a concurrent
            // editor cannot change these splits between validation and write.
            const selected = await db.splits.findMany({
                where: { guid: { in: uniqueGuids } },
                select: {
                    guid: true,
                    account_guid: true,
                    reconcile_state: true,
                    quantity_num: true,
                    quantity_denom: true,
                    transaction: { select: { post_date: true } },
                },
            });

            if (selected.length !== uniqueGuids.length) {
                const found = new Set(selected.map((s) => s.guid));
                const missing = uniqueGuids.filter((g) => !found.has(g));
                throw new ManualReconcileError(
                    `Cannot finalize: ${missing.length} selected split(s) not found.`,
                    'not_found',
                    { missing },
                );
            }

            const wrongAccount = selected.filter((s) => s.account_guid !== accountGuid);
            if (wrongAccount.length > 0) {
                throw new ManualReconcileError(
                    `Cannot finalize: ${wrongAccount.length} selected split(s) belong to a different account.`,
                    'bad_request',
                    { splitGuids: wrongAccount.map((s) => s.guid) },
                );
            }

            const alreadyReconciled = selected.filter((s) => s.reconcile_state === 'y');
            if (alreadyReconciled.length > 0) {
                throw new ManualReconcileError(
                    `Cannot finalize: ${alreadyReconciled.length} selected split(s) are already reconciled.`,
                    'bad_request',
                    { splitGuids: alreadyReconciled.map((s) => s.guid) },
                );
            }

            const cutoff = statementDateCutoff(statementDate);
            const postDated = selected.filter(
                (s) => s.transaction.post_date && s.transaction.post_date > cutoff,
            );
            if (postDated.length > 0) {
                throw new ManualReconcileError(
                    `Cannot finalize: ${postDated.length} selected split(s) are posted after the statement date.`,
                    'bad_request',
                    { splitGuids: postDated.map((s) => s.guid) },
                );
            }

            selectedCents = selected.reduce(
                (sum, s) => sum + toCents(toDecimalNumber(s.quantity_num, s.quantity_denom)),
                0,
            );
        }

        // Recompute the reconciled balance from the DB (single SQL aggregate).
        const { reconciledCents } = await summarizeReconciled(db, accountGuid);

        const differenceCents = toCents(endingBalance) - (reconciledCents + selectedCents);
        if (differenceCents !== 0) {
            const difference = differenceCents / 100;
            throw new ManualReconcileError(
                `Cannot finalize: difference is ${difference.toFixed(2)}, must be 0.00 ` +
                `(ending ${endingBalance.toFixed(2)} − reconciled ${(reconciledCents / 100).toFixed(2)} ` +
                `− selected ${(selectedCents / 100).toFixed(2)}).`,
                'not_zero',
                { difference, differenceCents },
            );
        }

        // Same commit semantics as the statement-upload finalize:
        // reconcile_state='y', reconcile_date=<statement date>.
        let updated = 0;
        if (uniqueGuids.length > 0) {
            const result = await db.splits.updateMany({
                where: { guid: { in: uniqueGuids }, account_guid: accountGuid },
                data: { reconcile_state: 'y', reconcile_date: statementDate },
            });
            updated = result.count;

            // Bump enter_date on the parent transactions so concurrent
            // editors' optimistic-concurrency tokens invalidate: an edit
            // started before this reconcile will now 409 instead of silently
            // reverting the reconcile flags. These rows were FOR UPDATE
            // locked above, so this update never blocks or deadlocks.
            await db.$executeRaw`
                UPDATE transactions
                SET enter_date = NOW()
                WHERE guid IN (
                    SELECT DISTINCT tx_guid FROM splits
                    WHERE guid = ANY(${uniqueGuids}::text[])
                )
            `;
        }

        if (completion) {
            const interactionDelta = Math.max(0, Math.floor(completion.interactionDelta ?? 0));
            let completedExistingSession = 0;
            if (completion.sessionId) {
                completedExistingSession = await db.$executeRaw`
                    UPDATE gnucash_web_reconciliation_sessions
                       SET status = 'completed',
                           completed_at = NOW(),
                           interaction_count = interaction_count + ${interactionDelta},
                           ending_difference = 0
                     WHERE id = ${completion.sessionId}
                       AND book_guid = ${completion.bookGuid}
                       AND account_guid = ${accountGuid}
                       AND user_id = ${completion.userId}
                `;
            }
            if (completedExistingSession === 0) {
                completedExistingSession = await db.$executeRaw`
                    UPDATE gnucash_web_reconciliation_sessions
                       SET status = 'completed',
                           completed_at = NOW(),
                           interaction_count = interaction_count + ${interactionDelta},
                           ending_difference = 0
                     WHERE id = (
                         SELECT id
                           FROM gnucash_web_reconciliation_sessions
                          WHERE book_guid = ${completion.bookGuid}
                            AND account_guid = ${accountGuid}
                            AND user_id = ${completion.userId}
                            AND statement_date = ${statementDate}
                            AND status = 'started'
                          ORDER BY started_at DESC
                          LIMIT 1
                     )
                `;
            }
            if (completedExistingSession === 0) {
                await db.$executeRaw`
                    INSERT INTO gnucash_web_reconciliation_sessions (
                        id, book_guid, account_guid, user_id, statement_date,
                        status, interaction_count, completed_at, ending_difference
                    )
                    VALUES (
                        ${randomUUID()}, ${completion.bookGuid}, ${accountGuid},
                        ${completion.userId}, ${statementDate}, 'completed',
                        ${interactionDelta}, NOW(), 0
                    )
                `;
            }

            // Continuous Close actions are deterministic and this successful
            // tie-out is direct evidence that the account no longer needs the
            // stale/never-reconciled action. Resolve it immediately instead of
            // waiting for the general seven-day source-expiry grace period.
            await db.$executeRaw`
                UPDATE gnucash_web_financial_actions
                   SET state = 'resolved',
                       state_changed_at = NOW(),
                       resolved_at = NOW()
                 WHERE user_id = ${completion.userId}
                   AND book_guid = ${completion.bookGuid}
                   AND origin = 'statement_reconciliation'
                   AND source_id = ${accountGuid}
                   AND state IN ('open', 'snoozed', 'accepted')
            `;
        }

        return {
            reconciledSplits: updated,
            statementDate: statementDate.toISOString(),
            endingBalance,
        };
    };

    if (tx) return run(tx);
    return prisma.$transaction(async (txc) => run(txc as unknown as ReconcileTx));
}
