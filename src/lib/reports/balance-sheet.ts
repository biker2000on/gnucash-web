import prisma from '@/lib/prisma';
import { buildAccountValuationContext, collectValuationCoverage } from '@/lib/account-valuation';
import { ReportType, ReportData, ReportSection, ReportFilters, LineItem } from './types';
import { buildHierarchy, resolveRootGuid, sumSplitsByAccount } from './utils';

/**
 * Flip the sign of a line item and every descendant. Credit-normal sections
 * (liabilities, equity) carry negative raw GnuCash balances; only the section
 * TOTAL used to be negated, which left a -$200 Credit Card row sitting under a
 * +$500 Total Liabilities. Negating the items too keeps children and totals in
 * the same sign convention (and a genuine contra balance still shows negative).
 */
function negateItem(item: LineItem): LineItem {
    return {
        ...item,
        amount: -item.amount,
        previousAmount: item.previousAmount !== undefined ? -item.previousAmount : undefined,
        children: item.children?.map(negateItem),
    };
}

/**
 * Synthetic equity row carrying unclosed income/expense activity.
 * Mirrors PERIOD_NET_INCOME_GUID in budget-statements.ts.
 */
const RETAINED_EARNINGS_GUID = 'synthetic-retained-earnings';

/**
 * Account types whose balances make up unclosed retained earnings.
 *
 * GnuCash books are almost never "closed": income and expense accounts keep
 * their cumulative balances instead of being rolled into an equity account at
 * period end. Those balances are real postings that sit on the other side of
 * every asset and liability movement, so a balance sheet that ignores them
 * cannot satisfy A = L + E.
 */
const INCOME_EXPENSE_TYPES = ['INCOME', 'EXPENSE'];

/**
 * Generate Balance Sheet report
 *
 * BALANCE CHECK (`grandTotal`): Assets − Liabilities − Equity, where Equity
 * INCLUDES a synthetic retained-earnings row for the cumulative, unclosed
 * income and expense balances through endDate. Every split in a GnuCash
 * transaction sums to zero, so summing every account through a single cutoff
 * date makes this identity exactly zero on a healthy book — and non-zero only
 * when postings genuinely do not balance. Omitting retained earnings (as this
 * report previously did) made the check non-zero by construction on any open
 * book, which trained readers to ignore the one control that reveals a real
 * imbalance.
 *
 * KNOWN CAVEATS, both pre-existing and shared with the section totals above:
 * hidden accounts (`hidden: 0`) and TRADING accounts are excluded from the
 * query, so a book carrying balances in either can still show a residual.
 */
export async function generateBalanceSheet(filters: ReportFilters): Promise<ReportData> {
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : new Date();

    // Determine root GUID from book scoping or fallback
    const rootGuid = await resolveRootGuid(filters.bookAccountGuids);

    // Get all asset, liability, and equity accounts with their balances
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            account_type: {
                // INCOME/EXPENSE are not displayed as sections; they are summed
                // into the synthetic retained-earnings equity row below, which
                // is what makes the balance check hold on an open book.
                in: [
                    'ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE',
                    'LIABILITY', 'CREDIT', 'PAYABLE', 'EQUITY',
                    ...INCOME_EXPENSE_TYPES,
                ],
            },
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
            commodity_guid: true,
            commodity: {
                select: {
                    namespace: true,
                },
            },
        },
    });

    const valuation = await buildAccountValuationContext(
        accounts.map(account => ({
            accountType: account.account_type,
            commodityGuid: account.commodity_guid,
            commodityNamespace: account.commodity?.namespace,
        })),
        endDate
    );

    // Get balances for all accounts up to end date in a single GROUP BY query
    const balanceSums = await sumSplitsByAccount(
        accounts.map(a => a.guid),
        { lte: endDate }
    );

    const valuedBalances = accounts.map(account => ({
        account: {
            accountType: account.account_type,
            commodityGuid: account.commodity_guid,
            commodityNamespace: account.commodity?.namespace,
        },
        quantity: balanceSums.get(account.guid)?.quantity ?? 0,
    }));

    // An unconvertible balance drops to 0 on ONE side of the statement while
    // whatever funded it stays valued on the other, so the identity below stops
    // holding. Track that here and refuse to publish the check when it does.
    const valuationCoverage = collectValuationCoverage(valuation, valuedBalances);

    const accountBalances = accounts.map((account, index) => ({
        ...account,
        balance: valuedBalances[index].quantity * valuation.getMultiplier(valuedBalances[index].account),
    }));

    // Separate by account type category (RECEIVABLE is an asset, PAYABLE a liability)
    const assetTypes = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL', 'RECEIVABLE'];
    const liabilityTypes = ['LIABILITY', 'CREDIT', 'PAYABLE'];
    const equityTypes = ['EQUITY'];

    const assetAccounts = accountBalances.filter(a => assetTypes.includes(a.account_type));
    const liabilityAccounts = accountBalances.filter(a => liabilityTypes.includes(a.account_type));
    const equityAccounts = accountBalances.filter(a => equityTypes.includes(a.account_type));
    const incomeExpenseAccounts = accountBalances.filter(a => INCOME_EXPENSE_TYPES.includes(a.account_type));

    // Unclosed retained earnings, displayed credit-normal (a profit reads
    // positive, like every other equity row).
    //
    // SIGN CONVENTION: raw GnuCash balances are debit-positive, so INCOME
    // carries a negative balance and EXPENSE a positive one. Negating their
    // combined sum yields income − expenses, matching how budget-statements.ts
    // builds its "Period net income (retained)" row
    // (`actualIncome += -raw` for INCOME, `actualExpense += raw` for EXPENSE).
    const retainedEarnings = -incomeExpenseAccounts.reduce((sum, a) => sum + a.balance, 0);

    // Build hierarchies. Liabilities and equity are credit-normal: their raw
    // GnuCash balances are negative when normal, so the whole tree is negated
    // for display. Using the signed sum (instead of Math.abs per item) means a
    // contra balance — e.g. an overpaid credit card carrying a debit balance —
    // correctly reduces the section total rather than adding to it.
    const assetItems = buildHierarchy(assetAccounts, rootGuid);
    const liabilityItems = buildHierarchy(liabilityAccounts, rootGuid).map(negateItem);
    const equityItems = buildHierarchy(equityAccounts, rootGuid).map(negateItem);

    // Show retained earnings as a real equity row rather than folding it into
    // the check silently: a reader who sees a non-zero check needs to be able
    // to see that the sections still add up. Suppressed when it rounds to zero
    // (a closed book, or one with no income/expense activity) so the statement
    // does not sprout a permanent $0.00 line.
    if (Math.abs(retainedEarnings) > 0.005) {
        equityItems.push({
            guid: RETAINED_EARNINGS_GUID,
            name: 'Retained earnings (unclosed income less expenses)',
            amount: retainedEarnings,
            depth: 0,
        });
    }

    // Calculate totals — now a plain sum of the (already sign-corrected) items,
    // so every section's top-level rows add up to its stated total.
    const totalAssets = assetItems.reduce((sum, item) => sum + item.amount, 0);
    const totalLiabilities = liabilityItems.reduce((sum, item) => sum + item.amount, 0);
    const totalEquity = equityItems.reduce((sum, item) => sum + item.amount, 0);

    const sections: ReportSection[] = [
        {
            title: 'Assets',
            items: assetItems,
            total: totalAssets,
        },
        {
            title: 'Liabilities',
            items: liabilityItems,
            total: totalLiabilities,
        },
        {
            title: 'Equity',
            items: equityItems,
            total: totalEquity,
        },
    ];

    return {
        type: ReportType.BALANCE_SHEET,
        title: 'Balance Sheet',
        generatedAt: new Date().toISOString(),
        filters,
        sections,
        // Exactly 0 on a balanced book, because totalEquity now carries the
        // unclosed retained earnings. Only meaningful when every balance was
        // valued -- withheld otherwise so a partially valued statement is never
        // presented as passing (or failing) its own balance check.
        grandTotal: valuationCoverage.complete
            ? totalAssets - totalLiabilities - totalEquity
            : undefined,
        valuationCoverage,
    };
}
