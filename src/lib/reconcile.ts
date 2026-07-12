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

import prisma, { type ExtendedPrismaClient } from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
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
export type ReconcileTx = Pick<ExtendedPrismaClient, 'splits'>;

/** Inclusive end-of-day (UTC) for a statement date, so every split posted on
 *  the statement date itself qualifies regardless of its stored time. */
export function statementDateCutoff(statementDate: Date): Date {
    const cutoff = new Date(statementDate);
    cutoff.setUTCHours(23, 59, 59, 999);
    return cutoff;
}

/* ─────────────────────────── workspace ─────────────────────────── */

interface ReconciledSplitRow {
    quantity_num: bigint;
    quantity_denom: bigint;
    reconcile_date: Date | null;
}

/** Sum 'y' split quantities in cents + max reconcile_date. */
function summarizeReconciled(rows: ReconciledSplitRow[]): {
    reconciledCents: number;
    lastReconcileDate: Date | null;
} {
    let reconciledCents = 0;
    let lastReconcileDate: Date | null = null;
    for (const row of rows) {
        reconciledCents += toCents(toDecimalNumber(row.quantity_num, row.quantity_denom));
        if (row.reconcile_date && (!lastReconcileDate || row.reconcile_date > lastReconcileDate)) {
            lastReconcileDate = row.reconcile_date;
        }
    }
    return { reconciledCents, lastReconcileDate };
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

    const reconciledRows = await prisma.splits.findMany({
        where: { account_guid: accountGuid, reconcile_state: 'y' },
        select: { quantity_num: true, quantity_denom: true, reconcile_date: true },
    });
    const { reconciledCents, lastReconcileDate } = summarizeReconciled(reconciledRows);

    const cutoff = statementDateCutoff(statementDate);
    const candidateRows = await prisma.$queryRaw<Array<{
        guid: string;
        memo: string | null;
        reconcile_state: string;
        quantity_num: bigint;
        quantity_denom: bigint;
        post_date: Date | null;
        num: string | null;
        description: string | null;
    }>>`
        SELECT s.guid, s.memo, s.reconcile_state, s.quantity_num, s.quantity_denom,
               t.post_date, t.num, t.description
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ${accountGuid}
          AND s.reconcile_state IN ('n', 'c')
          AND t.post_date <= ${cutoff}
        ORDER BY t.post_date ASC, t.enter_date ASC, s.guid ASC
    `;

    return {
        account: {
            guid: account.guid,
            name: account.name,
            account_type: account.account_type,
            currency: account.commodity?.mnemonic ?? null,
        },
        statementDate: statementDate.toISOString(),
        lastReconcileDate: lastReconcileDate ? lastReconcileDate.toISOString() : null,
        reconciledBalance: reconciledCents / 100,
        candidates: candidateRows.map((r) => ({
            guid: r.guid,
            date: r.post_date ? r.post_date.toISOString() : '',
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
): Promise<FinalizeReconcileResult> {
    const uniqueGuids = [...new Set(splitGuids)];

    const run = async (db: ReconcileTx): Promise<FinalizeReconcileResult> => {
        // Load and validate the requested splits.
        let selectedCents = 0;
        if (uniqueGuids.length > 0) {
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

        // Recompute the reconciled balance from the DB.
        const reconciledRows = await db.splits.findMany({
            where: { account_guid: accountGuid, reconcile_state: 'y' },
            select: { quantity_num: true, quantity_denom: true, reconcile_date: true },
        });
        const { reconciledCents } = summarizeReconciled(reconciledRows);

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
