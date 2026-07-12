/**
 * Account Current Value Helper
 *
 * Computes the current value of a set of accounts:
 *   - Currency-denominated accounts (BANK, ASSET, LIABILITY, CREDIT, ...):
 *     value = sum of split quantities (the account-currency balance).
 *   - Commodity-denominated accounts (STOCK, MUTUAL holding a security):
 *     value = share balance x latest price (skipping implied $0 prices),
 *     matching the valuation approach used by the net-worth engine.
 *
 * Shared by the Emergency Package and Fixed Income features.
 */

import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';

export interface AccountCurrentValue {
    /** Raw balance in the account's commodity units (dollars or shares). */
    quantity: number;
    /** Value in price-currency units (== quantity for currency accounts). */
    value: number;
}

/**
 * Fetch current balances/values for the given accounts as of `asOf`
 * (default: now). Accounts with no splits are omitted from the map.
 */
export async function fetchAccountCurrentValues(
    accountGuids: string[],
    asOf: Date = new Date(),
): Promise<Map<string, AccountCurrentValue>> {
    const result = new Map<string, AccountCurrentValue>();
    if (accountGuids.length === 0) return result;

    const accounts = await prisma.accounts.findMany({
        where: { guid: { in: accountGuids } },
        select: {
            guid: true,
            commodity_guid: true,
            commodity: { select: { namespace: true } },
        },
    });

    const quantityRows = await prisma.$queryRaw<Array<{ account_guid: string; qty: number }>>`
        SELECT s.account_guid,
               COALESCE(SUM(CAST(s.quantity_num AS DOUBLE PRECISION) / NULLIF(s.quantity_denom, 0)), 0) AS qty
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${accountGuids}::text[])
          AND t.post_date <= ${asOf}
        GROUP BY s.account_guid
    `;
    const quantities = new Map(quantityRows.map(r => [r.account_guid, Number(r.qty)]));

    // Latest price per non-currency commodity (skip implied $0 prices).
    const commodityGuids = [...new Set(
        accounts
            .filter(a => a.commodity_guid && a.commodity?.namespace !== 'CURRENCY')
            .map(a => a.commodity_guid as string),
    )];

    const priceMap = new Map<string, number>();
    if (commodityGuids.length > 0) {
        const priceRows = await prisma.$queryRaw<Array<{
            commodity_guid: string;
            value_num: bigint;
            value_denom: bigint;
        }>>`
            SELECT DISTINCT ON (p.commodity_guid)
                   p.commodity_guid, p.value_num, p.value_denom
            FROM prices p
            WHERE p.commodity_guid = ANY(${commodityGuids}::text[])
              AND p.date <= ${asOf}
              AND p.value_num > 0
            ORDER BY p.commodity_guid, p.date DESC
        `;
        for (const row of priceRows) {
            priceMap.set(row.commodity_guid, parseFloat(toDecimal(row.value_num, row.value_denom)));
        }
    }

    for (const account of accounts) {
        const quantity = quantities.get(account.guid) ?? 0;
        const isSecurity = !!account.commodity_guid && account.commodity?.namespace !== 'CURRENCY';
        const value = isSecurity
            ? quantity * (priceMap.get(account.commodity_guid as string) ?? 0)
            : quantity;
        result.set(account.guid, { quantity, value });
    }

    return result;
}
