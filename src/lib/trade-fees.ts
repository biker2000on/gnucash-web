/**
 * Trade Fees — brokerage commissions and fees attached to a trade
 *
 * GnuCash records a brokerage commission the conventional way: as a separate
 * EXPENSE split inside the SAME transaction as the trade. Nothing about the
 * fee is stored on the security split itself, so a lot's splits alone cannot
 * see it — which is why basis and proceeds computed purely from lot splits
 * silently omit every commission.
 *
 * IRS treatment (Pub. 550): a commission paid to ACQUIRE a security is
 * capitalized into its basis; a commission paid to DISPOSE of one reduces the
 * amount realized. Both push the reported gain DOWN. Dropping them overstates
 * every realized gain.
 *
 * This module turns the sibling expense splits back into a per-security-split
 * fee figure:
 *
 *  - FEE SPLITS are the transaction's EXPENSE-account splits with a non-zero
 *    value. Several are handled naturally — commission + SEC fee + exchange
 *    fee simply sum. No naming convention or account marker is required, so
 *    this works on books imported from GnuCash desktop, not just on trades
 *    entered through this app.
 *  - CURRENCY: GnuCash `value` is ALWAYS denominated in the transaction's
 *    currency (only `quantity` is in the account's own commodity). Summing
 *    values therefore mixes nothing: a fee booked to a EUR expense account
 *    inside a USD trade contributes its USD value, the same currency the
 *    security split's value is in.
 *  - ALLOCATION: a scrubbed sell is split into one security split PER LOT
 *    inside a single transaction, so the fee must be shared across them
 *    rather than charged in full to each. It is pro-rated by |value| (falling
 *    back to |quantity|, then evenly), which also handles the rare
 *    multi-security ticket.
 *
 * The allocation core is PURE so it can be unit-tested; the DB read lives in
 * loadTradeFees at the bottom.
 */

import { toDecimalNumber } from './gnucash';

/** Fee amount allocated to a security split, keyed by that split's GUID. */
export type TradeFeeBySplit = ReadonlyMap<string, number>;

/** Shared empty lookup so callers can default without allocating. */
export const NO_TRADE_FEES: TradeFeeBySplit = new Map();

/** One split of a trade transaction, reduced to what fee allocation needs. */
export interface FeeAllocationSplit {
    guid: string;
    txGuid: string;
    /** GnuCash account_type of the split's account (e.g. STOCK, EXPENSE). */
    accountType: string;
    /** value_decimal — always in the TRANSACTION's currency. */
    value: number;
    /** quantity_decimal — in the account's own commodity. */
    quantity: number;
}

/** Account types whose splits carry the security side of a trade. */
const SECURITY_ACCOUNT_TYPES = new Set(['STOCK', 'MUTUAL']);
const QTY_EPS = 1e-9;
const VALUE_EPS = 1e-9;

/**
 * Allocate each transaction's total fee across that transaction's security
 * splits, pro-rata by |value|. PURE.
 *
 * Returns a map of security-split GUID -> fee attributable to it (positive
 * for a normal fee). Splits that get no fee are omitted, so a caller can
 * treat a missing key as zero.
 */
export function allocateTradeFees(splits: FeeAllocationSplit[]): Map<string, number> {
    const byTx = new Map<string, FeeAllocationSplit[]>();
    for (const split of splits) {
        const list = byTx.get(split.txGuid);
        if (list) list.push(split);
        else byTx.set(split.txGuid, [split]);
    }

    const fees = new Map<string, number>();
    for (const txSplits of byTx.values()) {
        // Sum every expense split: commission, SEC fee, exchange fee, ...
        const totalFee = txSplits
            .filter(s => s.accountType === 'EXPENSE')
            .reduce((sum, s) => sum + s.value, 0);
        if (Math.abs(totalFee) < 0.005) continue;

        // Zero-quantity splits (scrub gains offsets, return-of-capital) are
        // not acquisitions or disposals and take no share of the fee.
        const securitySplits = txSplits.filter(
            s => SECURITY_ACCOUNT_TYPES.has(s.accountType) && Math.abs(s.quantity) > QTY_EPS,
        );
        if (securitySplits.length === 0) continue;

        const valueWeight = securitySplits.reduce((sum, s) => sum + Math.abs(s.value), 0);
        const quantityWeight = securitySplits.reduce((sum, s) => sum + Math.abs(s.quantity), 0);

        for (const split of securitySplits) {
            let share: number;
            if (valueWeight > VALUE_EPS) {
                share = totalFee * (Math.abs(split.value) / valueWeight);
            } else if (quantityWeight > QTY_EPS) {
                // Unvalued security splits (an in-kind move) — weight by shares.
                share = totalFee * (Math.abs(split.quantity) / quantityWeight);
            } else {
                share = totalFee / securitySplits.length;
            }
            fees.set(split.guid, (fees.get(split.guid) ?? 0) + share);
        }
    }
    return fees;
}

/** Chunk size for the tx_guid IN list; keeps the query planner and the
 *  Postgres parameter budget comfortable on large books. */
const TX_CHUNK = 500;

/**
 * Load the commission/fee attributable to each security split of the given
 * transactions. Impure (DB); the arithmetic lives in allocateTradeFees.
 */
export async function loadTradeFees(txGuids: string[]): Promise<TradeFeeBySplit> {
    const unique = [...new Set(txGuids)].filter(Boolean);
    if (unique.length === 0) return NO_TRADE_FEES;

    const prisma = (await import('./prisma')).default;

    const rows: FeeAllocationSplit[] = [];
    for (let offset = 0; offset < unique.length; offset += TX_CHUNK) {
        const chunk = unique.slice(offset, offset + TX_CHUNK);
        const splitRows = await prisma.splits.findMany({
            where: { tx_guid: { in: chunk } },
            select: {
                guid: true,
                tx_guid: true,
                value_num: true,
                value_denom: true,
                quantity_num: true,
                quantity_denom: true,
                account: { select: { account_type: true } },
            },
        });
        for (const row of splitRows) {
            rows.push({
                guid: row.guid,
                txGuid: row.tx_guid,
                accountType: row.account?.account_type ?? '',
                value: toDecimalNumber(row.value_num, row.value_denom),
                quantity: toDecimalNumber(row.quantity_num, row.quantity_denom),
            });
        }
    }

    return allocateTradeFees(rows);
}
