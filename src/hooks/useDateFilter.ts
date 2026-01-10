'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { DateRange, DATE_PRESETS } from '@/lib/datePresets';

const STORAGE_KEY = 'gnucash.dateFilter';

export function useDateFilter() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const [isInitialized, setIsInitialized] = useState(false);

    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    // On mount, restore from localStorage if URL params are empty
    useEffect(() => {
        if (isInitialized) return;

        if (!startDate && !endDate) {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                try {
                    const { startDate: s, endDate: e } = JSON.parse(saved) as DateRange;
                    if (s || e) {
                        const params = new URLSearchParams(searchParams.toString());
                        if (s) params.set('startDate', s);
                        if (e) params.set('endDate', e);
                        router.replace(`${pathname}?${params.toString()}`);
                    }
                } catch {
                    // Invalid saved data, ignore
                }
            } else {
                // Default to "This Year" if nothing saved
                const thisYear = DATE_PRESETS.find(p => p.label === 'This Year');
                if (thisYear) {
                    const { startDate: s, endDate: e } = thisYear.getValue();
                    if (s || e) {
                        const params = new URLSearchParams(searchParams.toString());
                        if (s) params.set('startDate', s);
                        if (e) params.set('endDate', e);
                        localStorage.setItem(STORAGE_KEY, JSON.stringify({ startDate: s, endDate: e }));
                        router.replace(`${pathname}?${params.toString()}`);
                    }
                }
            }
        }
        setIsInitialized(true);
    }, [isInitialized, startDate, endDate, searchParams, router, pathname]);

    const setDateFilter = useCallback((range: DateRange) => {
        const params = new URLSearchParams(searchParams.toString());

        if (range.startDate) {
            params.set('startDate', range.startDate);
        } else {
            params.delete('startDate');
        }

        if (range.endDate) {
            params.set('endDate', range.endDate);
        } else {
            params.delete('endDate');
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(range));

        const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
        router.push(newUrl);
    }, [searchParams, router, pathname]);

    const clearDateFilter = useCallback(() => {
        setDateFilter({ startDate: null, endDate: null });
    }, [setDateFilter]);

    return {
        startDate,
        endDate,
        setDateFilter,
        clearDateFilter,
        isInitialized
    };
}
