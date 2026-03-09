'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { DateRange, DATE_PRESETS } from '@/lib/datePresets';

const STORAGE_KEY = 'gnucash.dateFilter';
const INITIALIZED_KEY = 'gnucash.dateFilter.initialized';
const DATE_FILTER_EVENT = 'gnucash-date-filter-change';

export function useDateFilter() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const subscribe = useCallback((onStoreChange: () => void) => {
        const handleChange = () => onStoreChange();
        window.addEventListener(DATE_FILTER_EVENT, handleChange);
        window.addEventListener('storage', handleChange);
        return () => {
            window.removeEventListener(DATE_FILTER_EVENT, handleChange);
            window.removeEventListener('storage', handleChange);
        };
    }, []);
    const isInitialized = useSyncExternalStore(
        subscribe,
        () => {
            if (startDate || endDate) {
                return true;
            }

            return sessionStorage.getItem(INITIALIZED_KEY) === 'true';
        },
        () => false
    );

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
        sessionStorage.setItem(INITIALIZED_KEY, 'true');
        window.dispatchEvent(new Event(DATE_FILTER_EVENT));
    }, [endDate, isInitialized, pathname, router, searchParams, startDate]);

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
        sessionStorage.setItem(INITIALIZED_KEY, 'true');
        window.dispatchEvent(new Event(DATE_FILTER_EVENT));

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
