import { useQuery } from '@tanstack/react-query';
import { ReviewStatusMap } from '@/app/api/accounts/review-status/route';

export function useReviewStatus() {
    return useQuery<ReviewStatusMap>({
        queryKey: ['accounts', 'review-status'],
        queryFn: async () => {
            const res = await fetch('/api/accounts/review-status');
            if (!res.ok) throw new Error('Failed to fetch review status');
            return res.json();
        },
        staleTime: 1000 * 30, // 30 seconds
        // Counts can change from server-side paths too (SimpleFin sync, payslip
        // posting), so always refresh in the background when the tree mounts.
        // Cached data still renders instantly; the badge updates when fresh
        // counts arrive.
        refetchOnMount: 'always',
    });
}
