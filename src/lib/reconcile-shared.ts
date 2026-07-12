/**
 * Manual Reconcile — pure types + integer-cents math.
 *
 * This module is import-safe from client components (no prisma / server-only
 * imports). The server-side workspace/finalize logic lives in
 * src/lib/reconcile.ts, which re-exports everything here.
 */

/* ─────────────────────────── types ─────────────────────────── */

export interface ReconcileCandidate {
    guid: string;
    /** Transaction post date (ISO string). */
    date: string;
    /** Transaction num field (check number etc.). */
    num: string;
    description: string;
    memo: string;
    /** Split quantity in the account's commodity (signed decimal). */
    amount: number;
    state: 'n' | 'c';
}

export interface ReconcileWorkspace {
    account: {
        guid: string;
        name: string;
        account_type: string;
        currency: string | null;
    };
    /** Statement date the workspace was built for (ISO string). */
    statementDate: string;
    /** Max reconcile_date among 'y' splits, or null if never reconciled. */
    lastReconcileDate: string | null;
    /** Sum of quantities of all 'y' splits (the last reconciled balance). */
    reconciledBalance: number;
    /** 'n'/'c' splits posted on or before the statement date. */
    candidates: ReconcileCandidate[];
}

export interface FinalizeReconcileResult {
    reconciledSplits: number;
    statementDate: string;
    endingBalance: number;
}

/* ─────────────────────────── pure helpers ─────────────────────────── */

/** Convert a decimal currency amount to integer cents (round-half-away). */
export function toCents(amount: number): number {
    return Math.round(amount * 100);
}

/**
 * Difference in integer cents:
 *   ending − (reconciled + Σ selected)
 * Integer-cents math so 0.1 + 0.2 style float drift can never make a
 * balanced reconcile read as off by a fraction of a cent.
 */
export function computeDifferenceCents(
    endingBalance: number,
    reconciledBalance: number,
    selectedAmounts: number[],
): number {
    const selectedCents = selectedAmounts.reduce((sum, a) => sum + toCents(a), 0);
    return toCents(endingBalance) - (toCents(reconciledBalance) + selectedCents);
}

/** Same as computeDifferenceCents but returned in currency units. */
export function computeDifference(
    endingBalance: number,
    reconciledBalance: number,
    selectedAmounts: number[],
): number {
    return computeDifferenceCents(endingBalance, reconciledBalance, selectedAmounts) / 100;
}
