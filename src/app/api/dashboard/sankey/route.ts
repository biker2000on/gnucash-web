import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getActiveBookRootGuid } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';

interface SankeyHierarchyNode {
    guid: string;
    name: string;
    value: number;
    depth: number;
    children: SankeyHierarchyNode[];
}

function computeMaxDepth(nodes: SankeyHierarchyNode[]): number {
    if (nodes.length === 0) return 0;
    let max = 0;
    for (const node of nodes) {
        const childMax = computeMaxDepth(node.children);
        max = Math.max(max, childMax);
    }
    return max + 1;
}

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');

        const now = new Date();
        const endDate = endDateParam ? new Date(endDateParam + 'T23:59:59Z') : now;
        const startDate = await getEffectiveStartDate(startDateParam);

        const emptyResponse = {
            income: [],
            expense: [],
            totalIncome: 0,
            totalExpenses: 0,
            savings: 0,
            maxDepth: 0,
        };

        // Get the active book's root GUID
        let rootGuid: string;
        try {
            rootGuid = await getActiveBookRootGuid();
        } catch {
            return NextResponse.json(emptyResponse);
        }

        // Get top-level Income and Expense accounts (direct children of root-level Income/Expense)
        const topLevelAccounts = await prisma.accounts.findMany({
            where: {
                parent_guid: rootGuid,
                account_type: { in: ['INCOME', 'EXPENSE'] },
                hidden: 0,
            },
            select: {
                guid: true,
                name: true,
                account_type: true,
                commodity_guid: true,
            },
        });

        const incomeParent = topLevelAccounts.find(a => a.account_type === 'INCOME');
        const expenseParent = topLevelAccounts.find(a => a.account_type === 'EXPENSE');

        if (!incomeParent || !expenseParent) {
            return NextResponse.json(emptyResponse);
        }

        // Get ALL descendant accounts under Income and Expense (for hierarchy building)
        const allAccounts = await prisma.accounts.findMany({
            where: {
                account_type: { in: ['INCOME', 'EXPENSE'] },
                hidden: 0,
            },
            select: {
                guid: true,
                name: true,
                parent_guid: true,
                commodity_guid: true,
                account_type: true,
            },
        });

        // Build parent -> children map
        const childrenMap = new Map<string, typeof allAccounts>();
        for (const acc of allAccounts) {
            if (acc.parent_guid) {
                const children = childrenMap.get(acc.parent_guid) || [];
                children.push(acc);
                childrenMap.set(acc.parent_guid, children);
            }
        }

        // Recursive function to get all descendant guids (including self)
        function getDescendantGuids(guid: string): string[] {
            const result = [guid];
            const children = childrenMap.get(guid) || [];
            for (const child of children) {
                result.push(...getDescendantGuids(child.guid));
            }
            return result;
        }

        // Collect all account guids under income and expense parents for split fetching
        const allIncomeGuids = getDescendantGuids(incomeParent.guid);
        const allExpenseGuids = getDescendantGuids(expenseParent.guid);

        // Build currency map for all income/expense accounts
        const accountCurrencyMap = new Map<string, string>();
        for (const acc of [...allAccounts, incomeParent, expenseParent]) {
            if (acc.commodity_guid) {
                accountCurrencyMap.set(acc.guid, acc.commodity_guid);
            }
        }

        // Get base currency and pre-fetch exchange rates
        const baseCurrency = await getBaseCurrency();
        if (!baseCurrency) {
            return NextResponse.json({ error: 'No base currency found' }, { status: 500 });
        }
        const nonBaseCurrencyGuids = new Set<string>();
        for (const currGuid of accountCurrencyMap.values()) {
            if (currGuid !== baseCurrency.guid) {
                nonBaseCurrencyGuids.add(currGuid);
            }
        }

        const exchangeRates = new Map<string, number>();
        for (const currGuid of nonBaseCurrencyGuids) {
            const rate = await findExchangeRate(currGuid, baseCurrency.guid, endDate);
            if (rate) {
                exchangeRates.set(currGuid, rate.rate);
            }
        }

        const splits = await prisma.splits.findMany({
            where: {
                account_guid: {
                    in: [...allIncomeGuids, ...allExpenseGuids],
                },
                transaction: {
                    post_date: {
                        gte: startDate,
                        lte: endDate,
                    },
                },
            },
            select: {
                account_guid: true,
                quantity_num: true,
                quantity_denom: true,
            },
        });

        // Build a map of account_guid -> total value (with currency conversion)
        const splitTotalsByAccount = new Map<string, number>();
        for (const split of splits) {
            const rawValue = parseFloat(toDecimal(split.quantity_num, split.quantity_denom));
            const accountCurrGuid = accountCurrencyMap.get(split.account_guid);
            const rate = (accountCurrGuid && accountCurrGuid !== baseCurrency.guid)
                ? (exchangeRates.get(accountCurrGuid) || 1) : 1;
            const value = rawValue * rate;
            splitTotalsByAccount.set(
                split.account_guid,
                (splitTotalsByAccount.get(split.account_guid) || 0) + value
            );
        }

        // Build recursive hierarchy bottom-up: each node's value = own splits + sum of children's values
        function buildHierarchy(
            parentGuid: string,
            depth: number,
            isIncome: boolean
        ): SankeyHierarchyNode[] {
            const children = childrenMap.get(parentGuid) || [];
            return children
                .map(child => {
                    const subChildren = buildHierarchy(child.guid, depth + 1, isIncome);
                    const ownRaw = splitTotalsByAccount.get(child.guid) || 0;
                    const childrenTotal = subChildren.reduce((sum, n) => sum + n.value, 0);
                    const rawTotal = ownRaw + (isIncome ? -childrenTotal : childrenTotal);
                    const value = isIncome ? -rawTotal : rawTotal;
                    return {
                        guid: child.guid,
                        name: child.name,
                        value: Math.round(value * 100) / 100,
                        depth,
                        children: subChildren,
                    };
                })
                .filter(n => n.value > 0);
        }

        const incomeTree = buildHierarchy(incomeParent.guid, 0, true);
        const expenseTree = buildHierarchy(expenseParent.guid, 0, false);

        // Calculate totals from top-level tree nodes
        const totalIncome = incomeTree.reduce((sum, n) => sum + n.value, 0);
        const totalExpenses = expenseTree.reduce((sum, n) => sum + n.value, 0);

        // Add uncategorized income (splits directly on the parent Income account)
        const uncategorizedIncome = -(splitTotalsByAccount.get(incomeParent.guid) || 0);
        if (uncategorizedIncome > 0) {
            incomeTree.push({
                guid: 'uncategorized-income',
                name: 'Other Income',
                value: Math.round(uncategorizedIncome * 100) / 100,
                depth: 0,
                children: [],
            });
        }

        // Add uncategorized expenses
        const uncategorizedExpense = splitTotalsByAccount.get(expenseParent.guid) || 0;
        if (uncategorizedExpense > 0) {
            expenseTree.push({
                guid: 'uncategorized-expense',
                name: 'Other Expenses',
                value: Math.round(uncategorizedExpense * 100) / 100,
                depth: 0,
                children: [],
            });
        }

        const finalTotalIncome = incomeTree.reduce((sum, n) => sum + n.value, 0);
        const finalTotalExpenses = expenseTree.reduce((sum, n) => sum + n.value, 0);
        const savings = Math.round((finalTotalIncome - finalTotalExpenses) * 100) / 100;

        const maxDepth = Math.max(computeMaxDepth(incomeTree), computeMaxDepth(expenseTree));

        return NextResponse.json({
            income: incomeTree,
            expense: expenseTree,
            totalIncome: Math.round(finalTotalIncome * 100) / 100,
            totalExpenses: Math.round(finalTotalExpenses * 100) / 100,
            savings,
            maxDepth,
        });
    } catch (error) {
        console.error('Error fetching sankey data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch sankey data' },
            { status: 500 }
        );
    }
}
