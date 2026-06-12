/**
 * Implied price recording.
 *
 * GnuCash desktop adds a price-table entry from every stock/fund
 * transaction (source "user:split-register"): the executed trade price is
 * the best valuation data point available, and for commodities with no
 * quote source it is the only one. Desktop does this naively, though — a
 * zero-value transfer implies a $0.00 price, which zeroes out holdings in
 * forward-filled valuations. This module mimics desktop with guards:
 *
 *   - only splits on STOCK/MUTUAL accounts with a non-CURRENCY commodity
 *   - value != 0 AND quantity != 0 AND implied price > 0
 *   - skip when any price already exists for (commodity, currency) on the
 *     same calendar date (never clobber a Finance::Quote close)
 *
 * The price is stored as the exact reduced fraction
 * |value_num * quantity_denom| / |value_denom * quantity_num|.
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';

export interface ImpliedPriceSplit {
    account_guid: string;
    value_num: number | bigint;
    value_denom: number | bigint;
    quantity_num?: number | bigint | null;
    quantity_denom?: number | bigint | null;
}

function gcd(a: bigint, b: bigint): bigint {
    while (b) {
        [a, b] = [b, a % b];
    }
    return a < 0n ? -a : a;
}

function abs(n: bigint): bigint {
    return n < 0n ? -n : n;
}

/**
 * Compute the implied price fraction for a split, or null when no valid
 * positive price can be derived.
 */
export function impliedPriceFraction(split: ImpliedPriceSplit): { num: bigint; denom: bigint } | null {
    const valueNum = BigInt(split.value_num);
    const valueDenom = BigInt(split.value_denom);
    const qtyNum = BigInt(split.quantity_num ?? split.value_num);
    const qtyDenom = BigInt(split.quantity_denom ?? split.value_denom);

    if (valueNum === 0n || qtyNum === 0n || valueDenom <= 0n || qtyDenom <= 0n) {
        return null;
    }

    let num = abs(valueNum * qtyDenom);
    let denom = abs(valueDenom * qtyNum);
    if (num === 0n || denom === 0n) return null;

    const d = gcd(num, denom);
    num /= d;
    denom /= d;
    return { num, denom };
}

/**
 * Record implied prices for the investment splits of a transaction.
 * Best-effort: errors are logged, never thrown — price recording must not
 * fail the transaction write that triggered it.
 */
export async function recordImpliedPrices(input: {
    currency_guid: string;
    post_date: Date;
    splits: ImpliedPriceSplit[];
}): Promise<number> {
    try {
        const accountGuids = [...new Set(input.splits.map(s => s.account_guid))];
        const investmentAccounts = await prisma.accounts.findMany({
            where: {
                guid: { in: accountGuids },
                account_type: { in: ['STOCK', 'MUTUAL'] },
                commodity: { namespace: { not: 'CURRENCY' } },
            },
            select: { guid: true, commodity_guid: true },
        });
        if (investmentAccounts.length === 0) return 0;

        const commodityByAccount = new Map(
            investmentAccounts.map(a => [a.guid, a.commodity_guid])
        );

        // One candidate price per commodity per transaction (first valid split wins)
        const candidates = new Map<string, { num: bigint; denom: bigint }>();
        for (const split of input.splits) {
            const commodityGuid = commodityByAccount.get(split.account_guid);
            if (!commodityGuid || candidates.has(commodityGuid)) continue;
            const fraction = impliedPriceFraction(split);
            if (fraction) candidates.set(commodityGuid, fraction);
        }
        if (candidates.size === 0) return 0;

        const dayStart = new Date(Date.UTC(
            input.post_date.getUTCFullYear(),
            input.post_date.getUTCMonth(),
            input.post_date.getUTCDate()
        ));
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

        let created = 0;
        for (const [commodityGuid, fraction] of candidates) {
            const existing = await prisma.prices.findFirst({
                where: {
                    commodity_guid: commodityGuid,
                    currency_guid: input.currency_guid,
                    date: { gte: dayStart, lt: dayEnd },
                },
                select: { guid: true },
            });
            if (existing) continue;

            await prisma.prices.create({
                data: {
                    guid: generateGuid(),
                    commodity_guid: commodityGuid,
                    currency_guid: input.currency_guid,
                    date: input.post_date,
                    value_num: fraction.num,
                    value_denom: fraction.denom,
                    source: 'user:split-register',
                    type: 'transaction',
                },
            });
            created++;
        }
        return created;
    } catch (error) {
        console.error('Failed to record implied prices (non-fatal):', error);
        return 0;
    }
}
