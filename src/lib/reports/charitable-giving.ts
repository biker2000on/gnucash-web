import prisma from '@/lib/prisma';

/**
 * Charitable giving (Schedule A) summary.
 *
 * Donations are detected as EXPENSE accounts whose name or path matches
 * charitable keywords. Each qualifying split in the tax year becomes a line
 * item (date, payee from the transaction description, amount), grouped per
 * account with per-account and grand totals.
 */

const CHARITY_PATTERN = /donat|charit|tith|offering|philanthrop|church|temple|mosque|synagogue|non-?profit|501c?3?|giving/i;

export interface CharitableDonation {
    date: string;          // YYYY-MM-DD
    payee: string;         // transaction description
    memo: string;
    amount: number;        // positive
}

export interface CharitableAccountSummary {
    accountGuid: string;
    accountName: string;
    accountPath: string;
    total: number;
    donations: CharitableDonation[];
}

export interface CharitableGivingReport {
    year: number;
    accounts: CharitableAccountSummary[];
    grandTotal: number;
    /** Number of donations of $250+ (which require written acknowledgment). */
    largeDonationCount: number;
}

export function isCharitableAccountName(nameOrPath: string): boolean {
    return CHARITY_PATTERN.test(nameOrPath);
}

export async function generateCharitableGiving(
    bookAccountGuids: string[],
    year: number,
): Promise<CharitableGivingReport> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    const rows = await prisma.$queryRaw<Array<{
        account_guid: string;
        account_name: string;
        fullname: string;
        post_date: Date;
        description: string | null;
        memo: string | null;
        amount: number;
    }>>`
        SELECT
            ah.guid AS account_guid,
            ah.name AS account_name,
            ah.fullname,
            t.post_date,
            t.description,
            s.memo,
            (s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS amount
        FROM account_hierarchy ah
        JOIN splits s ON s.account_guid = ah.guid
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE ah.guid = ANY(${bookAccountGuids}::text[])
          AND ah.account_type = 'EXPENSE'
          AND t.post_date >= ${start}
          AND t.post_date <= ${end}
        ORDER BY t.post_date
    `;

    const byAccount = new Map<string, CharitableAccountSummary>();
    let largeDonationCount = 0;

    for (const row of rows) {
        if (!isCharitableAccountName(row.fullname) && !isCharitableAccountName(row.account_name)) {
            continue;
        }
        // Expense convention: donations are positive splits; refunds negative.
        const amount = row.amount;
        if (!Number.isFinite(amount) || amount === 0) continue;

        let acct = byAccount.get(row.account_guid);
        if (!acct) {
            acct = {
                accountGuid: row.account_guid,
                accountName: row.account_name,
                accountPath: row.fullname,
                total: 0,
                donations: [],
            };
            byAccount.set(row.account_guid, acct);
        }
        acct.donations.push({
            date: row.post_date.toISOString().slice(0, 10),
            payee: row.description ?? '',
            memo: row.memo ?? '',
            amount,
        });
        acct.total = Math.round((acct.total + amount) * 100) / 100;
        if (amount >= 250) largeDonationCount += 1;
    }

    const accounts = [...byAccount.values()].sort((a, b) => b.total - a.total);
    const grandTotal = Math.round(accounts.reduce((sum, a) => sum + a.total, 0) * 100) / 100;

    return { year, accounts, grandTotal, largeDonationCount };
}
