import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';
import { getActiveBookRootGuid } from '@/lib/book-scope';

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const startDateParam = searchParams.get('startDate');
        const endDateParam = searchParams.get('endDate');

        const now = new Date();
        const endDate = endDateParam ? new Date(endDateParam) : now;
        const startDate = startDateParam
            ? new Date(startDateParam)
            : new Date(now.getFullYear(), 0, 1); // Default: start of current year

        // Get the active book's root GUID
        let rootGuid: string;
        try {
            rootGuid = await getActiveBookRootGuid();
        } catch {
            return NextResponse.json({ nodes: [], links: [] });
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
            },
        });

        const incomeParent = topLevelAccounts.find(a => a.account_type === 'INCOME');
        const expenseParent = topLevelAccounts.find(a => a.account_type === 'EXPENSE');

        if (!incomeParent || !expenseParent) {
            return NextResponse.json({ nodes: [], links: [] });
        }

        // Get direct children of the Income and Expense parent accounts
        const categoryAccounts = await prisma.accounts.findMany({
            where: {
                parent_guid: { in: [incomeParent.guid, expenseParent.guid] },
                hidden: 0,
            },
            select: {
                guid: true,
                name: true,
                account_type: true,
                parent_guid: true,
            },
        });

        const incomeCategories = categoryAccounts.filter(
            a => a.parent_guid === incomeParent.guid
        );
        const expenseCategories = categoryAccounts.filter(
            a => a.parent_guid === expenseParent.guid
        );

        // Get all descendant account guids for each category
        // We need to recursively find all children to sum their splits
        const allAccounts = await prisma.accounts.findMany({
            where: {
                account_type: { in: ['INCOME', 'EXPENSE'] },
                hidden: 0,
            },
            select: {
                guid: true,
                parent_guid: true,
            },
        });

        // Build parent -> children map
        const childrenMap = new Map<string, string[]>();
        for (const acc of allAccounts) {
            if (acc.parent_guid) {
                const children = childrenMap.get(acc.parent_guid) || [];
                children.push(acc.guid);
                childrenMap.set(acc.parent_guid, children);
            }
        }

        // Recursive function to get all descendant guids (including self)
        function getDescendants(guid: string): string[] {
            const result = [guid];
            const children = childrenMap.get(guid) || [];
            for (const child of children) {
                result.push(...getDescendants(child));
            }
            return result;
        }

        // Build category -> descendant guids mapping
        const incomeCategoryDescendants = new Map<string, string[]>();
        for (const cat of incomeCategories) {
            incomeCategoryDescendants.set(cat.guid, getDescendants(cat.guid));
        }

        const expenseCategoryDescendants = new Map<string, string[]>();
        for (const cat of expenseCategories) {
            expenseCategoryDescendants.set(cat.guid, getDescendants(cat.guid));
        }

        // Also include splits directly on the parent Income/Expense accounts
        // that aren't part of any category
        const allCategorizedIncomeGuids = new Set(
            [...incomeCategoryDescendants.values()].flat()
        );
        const allCategorizedExpenseGuids = new Set(
            [...expenseCategoryDescendants.values()].flat()
        );

        // Fetch all splits for income and expense accounts within date range
        const allIncomeGuids = [
            incomeParent.guid,
            ...allCategorizedIncomeGuids,
        ];
        const allExpenseGuids = [
            expenseParent.guid,
            ...allCategorizedExpenseGuids,
        ];

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
                value_num: true,
                value_denom: true,
            },
        });

        // Build a map of account_guid -> total value
        const splitTotalsByAccount = new Map<string, number>();
        for (const split of splits) {
            const value = parseFloat(toDecimal(split.value_num, split.value_denom));
            splitTotalsByAccount.set(
                split.account_guid,
                (splitTotalsByAccount.get(split.account_guid) || 0) + value
            );
        }

        // Aggregate totals per category
        function getCategoryTotal(descendantGuids: string[]): number {
            let total = 0;
            for (const guid of descendantGuids) {
                total += splitTotalsByAccount.get(guid) || 0;
            }
            return total;
        }

        // Income categories (negate since income is negative in GnuCash)
        const incomeTotals: Array<{ name: string; value: number }> = [];
        for (const cat of incomeCategories) {
            const descendants = incomeCategoryDescendants.get(cat.guid) || [];
            const total = -getCategoryTotal(descendants); // negate to positive
            if (total > 0) {
                incomeTotals.push({ name: cat.name, value: Math.round(total * 100) / 100 });
            }
        }

        // Add uncategorized income (splits directly on the parent Income account)
        const uncategorizedIncome = -(splitTotalsByAccount.get(incomeParent.guid) || 0);
        if (uncategorizedIncome > 0) {
            incomeTotals.push({ name: 'Other Income', value: Math.round(uncategorizedIncome * 100) / 100 });
        }

        // Expense categories (positive in GnuCash)
        const expenseTotals: Array<{ name: string; value: number }> = [];
        for (const cat of expenseCategories) {
            const descendants = expenseCategoryDescendants.get(cat.guid) || [];
            const total = getCategoryTotal(descendants);
            if (total > 0) {
                expenseTotals.push({ name: cat.name, value: Math.round(total * 100) / 100 });
            }
        }

        // Add uncategorized expenses
        const uncategorizedExpense = splitTotalsByAccount.get(expenseParent.guid) || 0;
        if (uncategorizedExpense > 0) {
            expenseTotals.push({ name: 'Other Expenses', value: Math.round(uncategorizedExpense * 100) / 100 });
        }

        // Calculate totals
        const totalIncome = incomeTotals.reduce((sum, i) => sum + i.value, 0);
        const totalExpenses = expenseTotals.reduce((sum, e) => sum + e.value, 0);
        const savings = totalIncome - totalExpenses;

        // Build Sankey nodes and links
        // Nodes: [income categories..., "Savings" (if positive), expense categories...]
        const nodes: Array<{ name: string }> = [];
        const links: Array<{ source: number; target: number; value: number }> = [];

        // Add income nodes
        for (const inc of incomeTotals) {
            nodes.push({ name: inc.name });
        }

        // Add savings node if positive
        const savingsNodeIndex = savings > 0 ? nodes.length : -1;
        if (savings > 0) {
            nodes.push({ name: 'Savings' });
        }

        // Add expense nodes
        const expenseStartIndex = nodes.length;
        for (const exp of expenseTotals) {
            nodes.push({ name: exp.name });
        }

        // Build links: each income source proportionally funds each expense category + savings
        if (totalIncome > 0) {
            for (let i = 0; i < incomeTotals.length; i++) {
                const incomeAmount = incomeTotals[i].value;

                // Proportion of total income from this source
                const proportion = incomeAmount / totalIncome;

                // Link to each expense category (proportional)
                for (let j = 0; j < expenseTotals.length; j++) {
                    const linkValue = Math.round(expenseTotals[j].value * proportion * 100) / 100;
                    if (linkValue > 0) {
                        links.push({
                            source: i,
                            target: expenseStartIndex + j,
                            value: linkValue,
                        });
                    }
                }

                // Link to savings (proportional)
                if (savings > 0 && savingsNodeIndex >= 0) {
                    const savingsLink = Math.round(savings * proportion * 100) / 100;
                    if (savingsLink > 0) {
                        links.push({
                            source: i,
                            target: savingsNodeIndex,
                            value: savingsLink,
                        });
                    }
                }
            }
        }

        return NextResponse.json({ nodes, links });
    } catch (error) {
        console.error('Error fetching sankey data:', error);
        return NextResponse.json(
            { error: 'Failed to fetch sankey data' },
            { status: 500 }
        );
    }
}
