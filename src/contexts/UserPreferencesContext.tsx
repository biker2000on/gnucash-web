"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode, useMemo } from 'react';
import { BalanceReversal } from '@/lib/format';

interface UserPreferencesContextType {
    balanceReversal: BalanceReversal;
    setBalanceReversal: (value: BalanceReversal) => Promise<void>;
    defaultTaxRate: number;
    setDefaultTaxRate: (rate: number) => Promise<void>;
    loading: boolean;
}

const UserPreferencesContext = createContext<UserPreferencesContextType | undefined>(undefined);

const STORAGE_KEY = 'gnucash-web-preferences';

interface UserPreferencesProviderProps {
    children: ReactNode;
}

export function UserPreferencesProvider({ children }: UserPreferencesProviderProps) {
    const [balanceReversal, setBalanceReversalState] = useState<BalanceReversal>('none');
    const [defaultTaxRate, setDefaultTaxRateState] = useState<number>(0);
    const [loading, setLoading] = useState(true);

    // Load preferences from API on mount
    useEffect(() => {
        async function loadPreferences() {
            try {
                // First check localStorage for cached value
                const cached = localStorage.getItem(STORAGE_KEY);
                if (cached) {
                    try {
                        const parsed = JSON.parse(cached);
                        if (parsed.balanceReversal) {
                            setBalanceReversalState(parsed.balanceReversal);
                        }
                        if (parsed.defaultTaxRate !== undefined) {
                            setDefaultTaxRateState(parsed.defaultTaxRate);
                        }
                    } catch {
                        // Invalid cache, ignore
                    }
                }

                // Then fetch from API
                const res = await fetch('/api/user/preferences');
                if (res.ok) {
                    const data = await res.json();
                    setBalanceReversalState(data.balanceReversal || 'none');
                    setDefaultTaxRateState(data.defaultTaxRate || 0);
                    // Update cache
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                }
            } catch {
                // If API fails, fall back to cached or default
                console.warn('Failed to load user preferences from API');
            } finally {
                setLoading(false);
            }
        }

        loadPreferences();
    }, []);

    const setBalanceReversal = useCallback(async (value: BalanceReversal) => {
        // Optimistically update state
        setBalanceReversalState(value);

        // Update cache
        const cached = localStorage.getItem(STORAGE_KEY);
        const existing = cached ? JSON.parse(cached) : {};
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, balanceReversal: value }));

        // Persist to API
        try {
            const res = await fetch('/api/user/preferences', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ balanceReversal: value }),
            });

            if (!res.ok) {
                throw new Error('Failed to save preference');
            }
        } catch (error) {
            console.error('Failed to save balance reversal preference:', error);
            // Could revert state here, but optimistic update is usually fine
            throw error;
        }
    }, []);

    const setDefaultTaxRate = useCallback(async (value: number) => {
        // Optimistically update state
        setDefaultTaxRateState(value);

        // Update cache
        const cached = localStorage.getItem(STORAGE_KEY);
        const existing = cached ? JSON.parse(cached) : {};
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, defaultTaxRate: value }));

        // Persist to API
        try {
            const res = await fetch('/api/user/preferences', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ defaultTaxRate: value }),
            });

            if (!res.ok) {
                throw new Error('Failed to save tax rate');
            }
        } catch (error) {
            console.error('Failed to save tax rate:', error);
            throw error;
        }
    }, []);

    const value = useMemo<UserPreferencesContextType>(() => ({
        balanceReversal,
        setBalanceReversal,
        defaultTaxRate,
        setDefaultTaxRate,
        loading,
    }), [balanceReversal, setBalanceReversal, defaultTaxRate, setDefaultTaxRate, loading]);

    return (
        <UserPreferencesContext.Provider value={value}>
            {children}
        </UserPreferencesContext.Provider>
    );
}

export function useUserPreferences() {
    const context = useContext(UserPreferencesContext);
    if (context === undefined) {
        throw new Error('useUserPreferences must be used within a UserPreferencesProvider');
    }
    return context;
}
