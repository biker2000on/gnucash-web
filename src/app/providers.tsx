'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ToastProvider } from '@/contexts/ToastContext';
import { JobProgressProvider, JobProgressToasts } from '@/contexts/JobProgressContext';
import { KeyboardShortcutProvider } from '@/contexts/KeyboardShortcutContext';

export function Providers({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(() => new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 5 * 60 * 1000, // 5 minutes
                gcTime: 30 * 60 * 1000, // 30 minutes
            },
        },
    }));

    return (
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <JobProgressProvider>
                    <KeyboardShortcutProvider>
                        {children}
                    </KeyboardShortcutProvider>
                    <JobProgressToasts />
                </JobProgressProvider>
            </ToastProvider>
        </QueryClientProvider>
    );
}
