import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Account } from '@/lib/types';

export function useAccounts(options?: { flat?: boolean }) {
    return useQuery({
        queryKey: ['accounts', { flat: options?.flat ?? true }],
        queryFn: async () => {
            const res = await fetch(`/api/accounts?flat=${options?.flat ?? true}`);
            if (!res.ok) throw new Error('Failed to fetch accounts');
            return res.json() as Promise<Account[]>;
        },
    });
}

export function useInvalidateAccounts() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: ['accounts'] });
}
