/**
 * Pure split-selection and description-rewrite logic shared by the bulk
 * transaction edit API (/api/transactions/bulk) and the retroactive
 * categorization-rule engine (planHistoricalApplication in
 * categorization.service). Kept free of DB access so the semantics are
 * unit-testable (see src/lib/__tests__/bulk-edit.test.ts).
 */

export interface RecategorizeSplitInfo {
    guid: string;
    accountGuid: string;
    accountName: string;
    accountType: string;
    /** commodity_guid of the split's current account (for currency guards). */
    commodityGuid?: string | null;
}

export type RecategorizeSelection =
    /** split === null means there is nothing to do for this transaction (no-op). */
    | { ok: true; split: RecategorizeSplitInfo | null }
    | { ok: false; error: string };

/**
 * Pick the single split of a transaction that a bulk "recategorize" should
 * move to the target account.
 *
 * - Trading splits and splits already on the target account are never candidates.
 * - When `fromAccountGuid` is given, only splits currently on that account are
 *   candidates; a transaction with none is a no-op (ok, split: null).
 * - Otherwise the candidates are the counter-splits: every split NOT on the
 *   anchor account (the ledger's own account).
 * - Exactly one candidate must remain. More than one is ambiguous and the
 *   transaction is skipped with an error; the caller reports it as skipped.
 */
export function selectRecategorizeSplit(
    splits: RecategorizeSplitInfo[],
    opts: { toAccountGuid: string; anchorAccountGuid?: string; fromAccountGuid?: string },
): RecategorizeSelection {
    const base = splits.filter(
        s => s.accountType !== 'TRADING' && s.accountGuid !== opts.toAccountGuid
    );

    let candidates: RecategorizeSplitInfo[];
    if (opts.fromAccountGuid) {
        candidates = base.filter(s => s.accountGuid === opts.fromAccountGuid);
        if (candidates.length === 0) {
            // Only move splits currently on the source account; nothing here.
            return { ok: true, split: null };
        }
    } else {
        if (!opts.anchorAccountGuid) {
            return { ok: false, error: 'anchor account required to identify the counter-split' };
        }
        candidates = base.filter(s => s.accountGuid !== opts.anchorAccountGuid);
        if (candidates.length === 0) {
            const alreadyOnTarget = splits.some(s => s.accountGuid === opts.toAccountGuid);
            return alreadyOnTarget
                ? { ok: true, split: null }
                : { ok: false, error: 'no counter-split found' };
        }
    }

    if (candidates.length > 1) {
        return { ok: false, error: `ambiguous: ${candidates.length} candidate splits` };
    }
    return { ok: true, split: candidates[0] };
}

const UNCATEGORIZED_RE = /^(imbalance|orphan)/i;

/** GnuCash convention: auto-created holding accounts are named Imbalance-XXX / Orphan-XXX. */
export function isUncategorizedAccountName(name: string): boolean {
    return UNCATEGORIZED_RE.test((name || '').trim());
}

export type CounterSplitDecision =
    | { kind: 'change'; split: RecategorizeSplitInfo }
    /** Transaction does not qualify (no eligible counter-split); silently excluded. */
    | { kind: 'none' }
    /** Transaction matched but cannot be safely changed; reported as skipped. */
    | { kind: 'skip'; reason: string };

/**
 * Pick the counter-split a retroactive rule application should move.
 *
 * - Splits already on the rule's target account and Trading splits never qualify.
 * - onlyUncategorized: only splits on Imbalance/Orphan accounts qualify.
 * - otherwise: splits on EXPENSE/INCOME accounts or Imbalance/Orphan accounts qualify.
 * - Exactly one candidate → change it. Zero → transaction excluded. More than
 *   one → ambiguous, reported as skipped.
 */
export function selectHistoryCounterSplit(
    splits: RecategorizeSplitInfo[],
    opts: { targetAccountGuid: string; onlyUncategorized: boolean },
): CounterSplitDecision {
    const candidates = splits.filter(s => {
        if (s.accountGuid === opts.targetAccountGuid) return false;
        if (s.accountType === 'TRADING') return false;
        if (opts.onlyUncategorized) return isUncategorizedAccountName(s.accountName);
        return (
            s.accountType === 'EXPENSE' ||
            s.accountType === 'INCOME' ||
            isUncategorizedAccountName(s.accountName)
        );
    });

    if (candidates.length === 0) return { kind: 'none' };
    if (candidates.length > 1) {
        return { kind: 'skip', reason: `ambiguous: ${candidates.length} candidate splits` };
    }
    return { kind: 'change', split: candidates[0] };
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive, literal find-and-replace over a transaction description.
 * Replaces every occurrence; `$` in the replacement is treated literally.
 */
export function replaceDescription(current: string, find: string, replace: string): string {
    if (!find) return current;
    const re = new RegExp(escapeRegExp(find), 'gi');
    return current.replace(re, () => replace);
}
