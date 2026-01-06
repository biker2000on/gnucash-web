import { NextResponse } from 'next/server';
import { query, toDecimal } from '@/lib/db';
import { Transaction, Split } from '@/lib/types';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '100');
        const offset = parseInt(searchParams.get('offset') || '0');
        const { guid: accountGuid } = await params;

        // 1. Get the current total balance of the account
        const balanceQuery = `
            SELECT COALESCE(SUM(CAST(quantity_num AS NUMERIC) / CAST(quantity_denom AS NUMERIC)), 0) as balance
            FROM splits
            WHERE account_guid = $1
        `;
        const { rows: balanceRows } = await query(balanceQuery, [accountGuid]);
        const totalBalance = parseFloat(balanceRows[0].balance);

        // 2. Get the sum of splits for transactions that are NEWER than the current batch (to calculate starting balance for the page)
        // Newer means they would have appeared in previous pages (offset < current offset)
        let startingBalance = totalBalance;
        if (offset > 0) {
            const newerSplitsQuery = `
                SELECT COALESCE(SUM(CAST(s.quantity_num AS NUMERIC) / CAST(s.quantity_denom AS NUMERIC)), 0) as sum_splits
                FROM splits s
                JOIN transactions t ON s.tx_guid = t.guid
                WHERE s.account_guid = $1
                AND s.tx_guid IN (
                    SELECT guid FROM transactions 
                    WHERE guid IN (SELECT tx_guid FROM splits WHERE account_guid = $1)
                    ORDER BY post_date DESC, enter_date DESC
                    LIMIT $2
                )
            `;
            const { rows: newerRows } = await query(newerSplitsQuery, [accountGuid, offset]);
            startingBalance = totalBalance - parseFloat(newerRows[0].sum_splits);
        }

        // 3. Fetch transactions for this account
        const txQuery = `
            SELECT t.guid, t.currency_guid, t.num, t.post_date, t.enter_date, t.description 
            FROM transactions t
            JOIN splits s ON t.guid = s.tx_guid
            WHERE s.account_guid = $1
            ORDER BY t.post_date DESC, t.enter_date DESC
            LIMIT $2 OFFSET $3
        `;
        const { rows: transactions } = await query(txQuery, [accountGuid, limit, offset]);

        if (transactions.length === 0) {
            return NextResponse.json([]);
        }

        // 4. Fetch ALL splits for these transactions
        const txGuids = transactions.map(tx => tx.guid);
        const splitQuery = `
            SELECT s.*, a.name as account_name, c.mnemonic as commodity_mnemonic 
            FROM splits s
            JOIN accounts a ON s.account_guid = a.guid
            JOIN commodities c ON a.commodity_guid = c.guid
            WHERE s.tx_guid = ANY($1)
        `;
        const { rows: allSplits } = await query(splitQuery, [txGuids]);

        // 4.5 Get account mnemonic
        const accountMnemonicQuery = `SELECT b.mnemonic FROM accounts a JOIN commodities b ON a.commodity_guid = b.guid WHERE a.guid = $1`;
        const { rows: mnemonicRows } = await query(accountMnemonicQuery, [accountGuid]);
        const accountMnemonic = mnemonicRows[0].mnemonic;

        // 5. Build the response with running balance
        const txMap: Record<string, any> = {};
        transactions.forEach(tx => {
            txMap[tx.guid] = { ...tx, splits: [] };
        });

        allSplits.forEach(split => {
            if (txMap[split.tx_guid]) {
                txMap[split.tx_guid].splits.push({
                    ...split,
                    value_decimal: toDecimal(split.value_num, split.value_denom),
                    quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom)
                });
            }
        });

        // 6. Calculate running balance and attach to each transaction
        let currentRunningBalance = startingBalance;
        const result = transactions.map(tx => {
            const enrichedTx = txMap[tx.guid];
            // Find the split corresponding to the current account
            const accountSplit = enrichedTx.splits.find((s: any) => s.account_guid === accountGuid);
            const splitValue = accountSplit ? parseFloat(toDecimal(accountSplit.quantity_num, accountSplit.quantity_denom)) : 0;

            const row = {
                ...enrichedTx,
                running_balance: currentRunningBalance.toFixed(2),
                account_split_value: splitValue.toFixed(2),
                commodity_mnemonic: accountMnemonic
            };

            currentRunningBalance -= splitValue;
            return row;
        });

        return NextResponse.json(result);
    } catch (error) {
        console.error('Error fetching account transactions:', error);
        return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
}
