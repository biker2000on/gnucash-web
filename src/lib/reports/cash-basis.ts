/**
 * Cash-basis income statement math — PURE (no DB access).
 *
 * Accrual → cash conversion happens in two steps:
 *
 *   1. EXCLUSION — income/expense splits that belong to transactions which
 *      also touch a RECEIVABLE or PAYABLE account are accrual postings
 *      (invoice/bill posting transactions) and are excluded from the cash
 *      basis. The exclusion itself is done in SQL (NOT EXISTS on AR/AP
 *      splits); this module documents the rule and provides the payment
 *      recognition that replaces those postings.
 *
 *   2. PAYMENT RECOGNITION — GnuCash links a payment to an invoice through
 *      the invoice's AR/AP lot: the payment transaction carries an AR/AP
 *      split whose lot_guid is the invoice's post_lot (and which is NOT part
 *      of the invoice's posting transaction). Each such payment split is
 *      recognized against the paid invoice's income/expense (and tax)
 *      accounts pro-rata by the posting transaction's non-AR/AP split values
 *      — i.e. pro-rata by the invoice's line totals, exactly as posted.
 *
 * Sign conventions (GnuCash native):
 *   - Invoice posting: +total on A/R, -net per income line.
 *   - Customer payment: the A/R lot split is NEGATIVE (credit).
 *   - Bill posting: -total on A/P, +net per expense line; vendor payment
 *     lot splits are POSITIVE. The ratio -payment/post is positive for both.
 *
 * Recognized amounts keep the raw GnuCash sign (income negative, expense
 * positive) so they merge directly into per-account balance sums.
 */

/** One payment split assigned into an invoice's AR/AP lot. */
export interface PaymentLotSplit {
    /** The paid invoice's posting transaction guid. */
    postTxnGuid: string;
    /** Signed value of the payment's AR/AP split (credit < 0 for invoices). */
    value: number;
}

/** One split of an invoice/bill posting transaction. */
export interface PostingSplit {
    txGuid: string;
    accountGuid: string;
    /** Signed split value (GnuCash debit > 0 / credit < 0). */
    value: number;
    /**
     * True for the AR/AP split that carries the invoice lot (the split whose
     * lot_guid equals the invoice's post_lot).
     */
    isPostSplit: boolean;
}

/**
 * Ratio of a payment to the posted invoice total, derived from lot splits.
 * postSplitValue is +total (invoice) or -total (bill); the payment split is
 * the opposite sign, so -payment/post is the positive paid fraction for
 * both sides. Partial payments yield 0 < ratio < 1; credit-note style
 * adjustments can produce negative ratios, which flow through correctly.
 */
export function paymentRatio(paymentSplitValue: number, postSplitValue: number): number {
    if (postSplitValue === 0) return 0;
    return -paymentSplitValue / postSplitValue;
}

/**
 * Allocate payment amounts to the paid invoices' income/expense/tax accounts
 * pro-rata by the posting transaction's line splits.
 *
 * Returns raw-signed recognized amounts per account guid (income negative,
 * expense positive) — ready to be ADDED to cash-basis account sums.
 *
 * Posting transactions with a zero or missing AR/AP split are skipped
 * (nothing meaningful to allocate against).
 */
export function allocatePaymentsToAccounts(
    payments: ReadonlyArray<PaymentLotSplit>,
    postingSplits: ReadonlyArray<PostingSplit>,
): Map<string, number> {
    // Group posting splits per transaction, separating the AR/AP post split.
    const byTxn = new Map<string, { postValue: number; lines: PostingSplit[] }>();
    for (const s of postingSplits) {
        let entry = byTxn.get(s.txGuid);
        if (!entry) {
            entry = { postValue: 0, lines: [] };
            byTxn.set(s.txGuid, entry);
        }
        if (s.isPostSplit) entry.postValue += s.value;
        else entry.lines.push(s);
    }

    const recognized = new Map<string, number>();
    for (const p of payments) {
        const entry = byTxn.get(p.postTxnGuid);
        if (!entry || entry.postValue === 0) continue;
        const ratio = paymentRatio(p.value, entry.postValue);
        if (ratio === 0) continue;
        for (const line of entry.lines) {
            const amount = line.value * ratio;
            recognized.set(line.accountGuid, (recognized.get(line.accountGuid) ?? 0) + amount);
        }
    }
    return recognized;
}
