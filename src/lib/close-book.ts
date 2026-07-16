import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';
import { assertAccountNotLocked } from '@/lib/services/period-lock.service';

/**
 * Close Book — GnuCash desktop's Tools → Close Book.
 *
 * Creates closing entries dated the close date that zero every income and
 * expense account's cumulative balance into an equity account (retained
 * earnings). Like desktop, two transactions are created per currency: one
 * closing income accounts, one closing expenses. Because balances are
 * cumulative as of the close date, re-running after a prior close only
 * moves activity since that close.
 */

export interface CloseBookAccountRow {
    guid: string;
    name: string;
    fullname: string;
    account_type: 'INCOME' | 'EXPENSE';
    commodity_guid: string;
    /** Cumulative balance through the close date (GnuCash sign: income negative). */
    balance: number;
}

export interface CloseBookPreview {
    closeDate: string;
    accounts: CloseBookAccountRow[];
    /** Sum of income balances (negative = net income earned). */
    incomeTotal: number;
    /** Sum of expense balances (positive). */
    expenseTotal: number;
    /** Net income presented positive-when-profitable: -(income + expense). */
    netIncome: number;
    currencies: string[];
}

export interface ClosingSplitSpec {
    accountGuid: string;
    /** Decimal amount for the split value/quantity (negates the balance). */
    amount: number;
}

export interface ClosingTransactionSpec {
    description: string;
    currencyGuid: string;
    splits: ClosingSplitSpec[];
    /** The equity offset amount (negated sum of the account splits). */
    equityAmount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure core: build the closing transaction specs for one account type.
 * Each account with a nonzero balance gets a split of -balance; the equity
 * split takes the negated sum so the transaction balances exactly.
 */
export function buildClosingTransactions(
    accounts: CloseBookAccountRow[],
    type: 'INCOME' | 'EXPENSE',
    description: string,
): ClosingTransactionSpec[] {
    const byCurrency = new Map<string, CloseBookAccountRow[]>();
    for (const acct of accounts) {
        if (acct.account_type !== type) continue;
        if (Math.abs(acct.balance) < 0.005) continue;
        const list = byCurrency.get(acct.commodity_guid) ?? [];
        list.push(acct);
        byCurrency.set(acct.commodity_guid, list);
    }

    const result: ClosingTransactionSpec[] = [];
    for (const [currencyGuid, list] of byCurrency) {
        const splits = list.map(a => ({ accountGuid: a.guid, amount: round2(-a.balance) }));
        const equityAmount = round2(-splits.reduce((sum, s) => sum + s.amount, 0));
        result.push({ description, currencyGuid, splits, equityAmount });
    }
    return result;
}

export async function previewCloseBook(
    bookAccountGuids: string[],
    closeDate: string,
): Promise<CloseBookPreview> {
    const end = new Date(`${closeDate}T23:59:59.999Z`);

    const filtered = await prisma.$queryRaw<Array<{
        guid: string;
        name: string;
        fullname: string;
        account_type: string;
        commodity_guid: string;
        balance: number;
    }>>`
        SELECT
            ah.guid,
            ah.name,
            ah.fullname,
            ah.account_type,
            a.commodity_guid,
            SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)::float8 AS balance
        FROM account_hierarchy ah
        JOIN accounts a ON a.guid = ah.guid
        JOIN splits s ON s.account_guid = ah.guid
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE ah.guid = ANY(${bookAccountGuids}::text[])
          AND ah.account_type IN ('INCOME', 'EXPENSE')
          AND t.post_date <= ${end}
        GROUP BY ah.guid, ah.name, ah.fullname, ah.account_type, a.commodity_guid
        HAVING ABS(SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)) >= 0.005
        ORDER BY ah.fullname
    `;

    const accounts = filtered.map(r => ({
        guid: r.guid,
        name: r.name,
        fullname: r.fullname,
        account_type: r.account_type as 'INCOME' | 'EXPENSE',
        commodity_guid: r.commodity_guid,
        balance: round2(r.balance),
    }));

    const incomeTotal = round2(accounts.filter(a => a.account_type === 'INCOME').reduce((s, a) => s + a.balance, 0));
    const expenseTotal = round2(accounts.filter(a => a.account_type === 'EXPENSE').reduce((s, a) => s + a.balance, 0));

    return {
        closeDate,
        accounts,
        incomeTotal,
        expenseTotal,
        netIncome: round2(-(incomeTotal + expenseTotal)),
        currencies: [...new Set(accounts.map(a => a.commodity_guid))],
    };
}

export interface CloseBookResult {
    transactionGuids: string[];
    splitCount: number;
    skippedCurrencies: string[];
}

export async function executeCloseBook(
    bookAccountGuids: string[],
    closeDate: string,
    equityAccountGuid: string,
    description: string,
): Promise<CloseBookResult> {
    const preview = await previewCloseBook(bookAccountGuids, closeDate);
    if (preview.accounts.length === 0) {
        return { transactionGuids: [], splitCount: 0, skippedCurrencies: [] };
    }

    const equity = await prisma.accounts.findUnique({
        where: { guid: equityAccountGuid },
        select: { guid: true, account_type: true, commodity_guid: true },
    });
    if (!equity) throw new Error('Equity account not found');
    if (equity.account_type !== 'EQUITY') throw new Error('Closing target must be an EQUITY account');
    if (!bookAccountGuids.includes(equity.guid)) throw new Error('Equity account is not in the active book');

    // Period lock: closing entries are dated closeDate, which must be after
    // the book's lock date (lock AFTER closing the books, not before).
    await assertAccountNotLocked(equity.guid, [closeDate]);

    // Only currencies matching the equity account can close into it.
    const closable = preview.accounts.filter(a => a.commodity_guid === equity.commodity_guid);
    const skippedCurrencies = [...new Set(
        preview.accounts.filter(a => a.commodity_guid !== equity.commodity_guid).map(a => a.commodity_guid),
    )];

    const specs = [
        ...buildClosingTransactions(closable, 'INCOME', description || 'Closing Entries — Income'),
        ...buildClosingTransactions(closable, 'EXPENSE', description || 'Closing Entries — Expenses'),
    ];

    const postDate = new Date(`${closeDate}T12:00:00Z`);
    const enterDate = new Date();
    const transactionGuids: string[] = [];
    let splitCount = 0;

    await prisma.$transaction(async (tx) => {
        for (const spec of specs) {
            const txGuid = generateGuid();
            await tx.$executeRaw`
                INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                VALUES (${txGuid}, ${spec.currencyGuid}, '', ${postDate}, ${enterDate}, ${spec.description})
            `;
            for (const split of spec.splits) {
                const { num, denom } = fromDecimal(split.amount);
                await tx.$executeRaw`
                    INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
                    VALUES (${generateGuid()}, ${txGuid}, ${split.accountGuid}, 'Closing entry', '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
                `;
                splitCount += 1;
            }
            const { num: eqNum, denom: eqDenom } = fromDecimal(spec.equityAmount);
            await tx.$executeRaw`
                INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
                VALUES (${generateGuid()}, ${txGuid}, ${equityAccountGuid}, 'Closing entry', '', 'n', NULL, ${eqNum}, ${eqDenom}, ${eqNum}, ${eqDenom}, NULL)
            `;
            splitCount += 1;
            transactionGuids.push(txGuid);
        }
    });

    // Audit each created transaction with a full snapshot (undo-capable)
    const { logAudit, snapshotTransactionByGuid } = await import('@/lib/services/audit.service');
    for (const guid of transactionGuids) {
        await logAudit('CREATE', 'TRANSACTION', guid, null, await snapshotTransactionByGuid(guid));
    }

    return { transactionGuids, splitCount, skippedCurrencies };
}
