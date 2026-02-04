import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Account, AccountWithChildren, AccountBalance } from '@/lib/types';

interface UseAccountsOptions {
    flat?: boolean;
    startDate?: string | null;
    endDate?: string | null;
}

/**
 * Recursively merges account hierarchy with balance data
 */
function mergeAccountsWithBalances(
    hierarchy: AccountWithChildren[],
    balances: AccountBalance[]
): AccountWithChildren[] {
    const balanceMap = new Map(balances.map(b => [b.guid, b]));

    function mergeNode(node: AccountWithChildren): AccountWithChildren {
        const balance = balanceMap.get(node.guid);
        return {
            ...node,
            total_balance: balance?.total_balance ?? '0',
            period_balance: balance?.period_balance ?? '0',
            total_balance_usd: balance?.total_balance_usd,
            period_balance_usd: balance?.period_balance_usd,
            children: node.children.map(mergeNode), // RECURSIVE
        };
    }

    return hierarchy.map(mergeNode);
}

export function useAccounts(options?: UseAccountsOptions) {
    const flat = options?.flat ?? true;
    const startDate = options?.startDate;
    const endDate = options?.endDate;

    // Query 1: Static hierarchy (cached indefinitely)
    const hierarchyQuery = useQuery({
        queryKey: ['accounts', 'hierarchy', { flat }],
        queryFn: async () => {
            const params = new URLSearchParams();
            params.set('flat', String(flat));
            params.set('noBalances', 'true'); // Fetch without balances
            const res = await fetch(`/api/accounts?${params}`);
            if (!res.ok) throw new Error('Failed to fetch account hierarchy');
            return res.json() as Promise<Account[] | AccountWithChildren[]>;
        },
        staleTime: Infinity, // Never stale - hierarchy is static
        gcTime: 1000 * 60 * 60 * 24, // 24 hours
    });

    // Query 2: Dynamic balances (refetch on date change)
    const balancesQuery = useQuery({
        queryKey: ['accounts', 'balances', { startDate, endDate }],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (startDate) params.set('startDate', startDate);
            if (endDate) params.set('endDate', endDate);
            const res = await fetch(`/api/accounts/balances?${params}`);
            if (!res.ok) throw new Error('Failed to fetch account balances');
            return res.json() as Promise<AccountBalance[]>;
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: !flat, // Only fetch balances when not in flat mode
    });

    // Merge hierarchy with balances
    const mergedData = useMemo(() => {
        if (flat) {
            return hierarchyQuery.data; // Flat mode doesn't need balances merge
        }
        if (!hierarchyQuery.data) return undefined;
        if (!balancesQuery.data) return hierarchyQuery.data; // Show hierarchy while loading balances
        return mergeAccountsWithBalances(
            hierarchyQuery.data as AccountWithChildren[],
            balancesQuery.data
        );
    }, [flat, hierarchyQuery.data, balancesQuery.data]);

    return {
        data: mergedData,
        isLoading: hierarchyQuery.isLoading || (!flat && balancesQuery.isLoading),
        isHierarchyLoading: hierarchyQuery.isLoading,
        isBalancesLoading: balancesQuery.isLoading,
        isInitialLoad: hierarchyQuery.isLoading && balancesQuery.isLoading,
        error: hierarchyQuery.error || balancesQuery.error,
        refetch: async () => {
            await hierarchyQuery.refetch();
            if (!flat) await balancesQuery.refetch();
        },
    };
}

export function useInvalidateAccounts() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: ['accounts'] });
}
