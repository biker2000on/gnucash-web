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
    });
}
