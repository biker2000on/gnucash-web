import prisma from '@/lib/prisma';
import { ReportType, ReportData, ReportSection, LineItem, ReportFilters } from './types';
import { buildAccountPathMap, toDecimal } from './utils';

/**
 * Categorize account type for cash flow statement
 */
function getCashFlowCategory(accountType: string): 'operating' | 'investing' | 'financing' | 'cash' | null {
    switch (accountType) {
        case 'BANK':
        case 'CASH':
            return 'cash';
        case 'INCOME':
        case 'EXPENSE':
        case 'RECEIVABLE':
        case 'PAYABLE':
            return 'operating';
        case 'STOCK':
        case 'MUTUAL':
        case 'ASSET':
            return 'investing';
        case 'LIABILITY':
        case 'CREDIT':
        case 'EQUITY':
            return 'financing';
        default:
            return null;
    }
}

/**
 * Generate Cash Flow Statement
 */
export async function generateCashFlow(filters: ReportFilters): Promise<ReportData> {
    const now = new Date();
    const startDate = filters.startDate ? new Date(filters.startDate + 'T00:00:00Z') : new Date(now.getFullYear(), 0, 1);
    const endDate = filters.endDate ? new Date(filters.endDate + 'T23:59:59Z') : now;

    const investmentTypes = ['STOCK', 'MUTUAL'];

    // Build full account path map for display names
    const accountPaths = await buildAccountPathMap(filters.bookAccountGuids);

    // Get all accounts (scoped to active book if bookAccountGuids provided)
    const accounts = await prisma.accounts.findMany({
        where: {
            ...(filters.bookAccountGuids ? { guid: { in: filters.bookAccountGuids } } : {}),
            hidden: 0,
        },
        select: {
            guid: true,
            name: true,
            account_type: true,
        },
    });

    // Group accounts by cash flow category
    const cashAccounts = accounts.filter(a => getCashFlowCategory(a.account_type) === 'cash');
    const operatingAccounts = accounts.filter(a => getCashFlowCategory(a.account_type) === 'operating');
    const investingAccounts = accounts.filter(a => getCashFlowCategory(a.account_type) === 'investing');
    const financingAccounts = accounts.filter(a => getCashFlowCategory(a.account_type) === 'financing');

    // Calculate cash changes for each category
    async function getAccountChanges(accountList: typeof accounts) {
        const changes: LineItem[] = [];

        for (const account of accountList) {
            // For investment accounts, use value (cost basis / cash impact)
            // For regular accounts, use quantity (account currency amount)
            const isInvestment = investmentTypes.includes(account.account_type);
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: {
                        post_date: {
                            gte: startDate,
                            lte: endDate,
                        },
                    },
                },
                select: isInvestment
                    ? { value_num: true, value_denom: true }
                    : { quantity_num: true, quantity_denom: true },
            });

            const netChange = splits.reduce((sum, split) => {
                if (isInvestment) {
                    const s = split as { value_num: bigint; value_denom: bigint };
                    return sum + toDecimal(s.value_num, s.value_denom);
                }
                const s = split as { quantity_num: bigint; quantity_denom: bigint };
                return sum + toDecimal(s.quantity_num, s.quantity_denom);
            }, 0);

            if (netChange !== 0 || filters.showZeroBalances) {
                changes.push({
                    guid: account.guid,
                    name: accountPaths.get(account.guid) || account.name,
                    amount: netChange,
                });
            }
        }

        return changes;
    }

    // Get opening cash balance
    const openingCash = await Promise.all(
        cashAccounts.map(async (account) => {
            const splits = await prisma.splits.findMany({
                where: {
                    account_guid: account.guid,
                    transaction: {
                        post_date: {
                            lt: startDate,
                        },
                    },
                },
                select: {
                    quantity_num: true,
                    quantity_denom: true,
                },
            });

            return splits.reduce((sum, split) => {
                return sum + toDecimal(split.quantity_num, split.quantity_denom);
            }, 0);
        })
    );

    const totalOpeningCash = openingCash.reduce((sum, val) => sum + val, 0);

    // Get changes by category
    const operatingChanges = await getAccountChanges(operatingAccounts);
    const investingChanges = await getAccountChanges(investingAccounts);
    const financingChanges = await getAccountChanges(financingAccounts);
    const cashChanges = await getAccountChanges(cashAccounts);

    // Calculate totals
    const totalOperating = operatingChanges.reduce((sum, item) => sum + item.amount, 0);
    const totalInvesting = investingChanges.reduce((sum, item) => sum + item.amount, 0);
    const totalFinancing = financingChanges.reduce((sum, item) => sum + item.amount, 0);
    const totalCashChange = cashChanges.reduce((sum, item) => sum + item.amount, 0);

    const sections: ReportSection[] = [
        {
            title: 'Cash Flows from Operating Activities',
            items: operatingChanges,
            total: -totalOperating, // Negate because income decreases cash in splits
        },
        {
            title: 'Cash Flows from Investing Activities',
            items: investingChanges,
            total: -totalInvesting,
        },
        {
            title: 'Cash Flows from Financing Activities',
            items: financingChanges,
            total: -totalFinancing,
        },
    ];

    return {
        type: ReportType.CASH_FLOW,
        title: 'Cash Flow Statement',
        generatedAt: new Date().toISOString(),
        filters,
        sections,
        grandTotal: totalCashChange,
    };
}
