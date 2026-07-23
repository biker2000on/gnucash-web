import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewStatusMap } from '@/app/api/accounts/review-status/route';
import type { JobProgressEventPayload } from '@/contexts/JobProgressContext';

export function useReviewStatus() {
    const queryClient = useQueryClient();
    const query = useQuery<ReviewStatusMap>({
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

    useEffect(() => {
        const refreshAfterSimpleFinSync = (event: Event) => {
            const detail = (event as CustomEvent<JobProgressEventPayload>).detail;
            if (
                detail?.kind === 'sync-simplefin'
                && (detail.status === 'completed' || detail.status === 'failed')
            ) {
                void queryClient.invalidateQueries({ queryKey: ['accounts', 'review-status'] });
            }
        };

        window.addEventListener('job-progress', refreshAfterSimpleFinSync);
        return () => window.removeEventListener('job-progress', refreshAfterSimpleFinSync);
    }, [queryClient]);

    return query;
}
