"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode, useMemo, useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextType {
    theme: Theme;
    resolvedTheme: ResolvedTheme;
    setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'gnucash-web-theme';

// Subscribe to system theme changes
function subscribeToSystemTheme(callback: () => void): () => void {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', callback);
    return () => mediaQuery.removeEventListener('change', callback);
}

function getSystemThemeSnapshot(): ResolvedTheme {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getSystemThemeServerSnapshot(): ResolvedTheme {
    return 'dark'; // Default to dark for SSR
}

function getStoredTheme(): Theme {
    if (typeof window === 'undefined') return 'system';
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
            return stored;
        }
    } catch {
        // localStorage might not be available
    }
    return 'system';
}

interface ThemeProviderProps {
    children: ReactNode;
    defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme = 'system' }: ThemeProviderProps) {
    // Track the user's theme preference
    const [theme, setThemeState] = useState<Theme>(() => {
        if (typeof window === 'undefined') return defaultTheme;
        return getStoredTheme();
    });

    // Subscribe to system theme changes using useSyncExternalStore
    const systemTheme = useSyncExternalStore(
        subscribeToSystemTheme,
        getSystemThemeSnapshot,
        getSystemThemeServerSnapshot
    );

    // Compute resolved theme based on current theme setting and system preference
    const resolvedTheme = useMemo<ResolvedTheme>(() => {
        if (theme === 'system') {
            return systemTheme;
        }
        return theme;
    }, [theme, systemTheme]);

    // Apply theme to document
    const applyTheme = useCallback((resolved: ResolvedTheme) => {
        const root = document.documentElement;
        root.classList.remove('light', 'dark');
        root.classList.add(resolved);
    }, []);

    // Apply theme when it changes
    useEffect(() => {
        applyTheme(resolvedTheme);
        // Enable transitions after initial theme is applied
        requestAnimationFrame(() => {
            document.documentElement.classList.add('theme-ready');
        });
    }, [resolvedTheme, applyTheme]);

    // Update theme
    const setTheme = useCallback((newTheme: Theme) => {
        setThemeState(newTheme);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, newTheme);
        } catch {
            // localStorage might not be available
        }
    }, []);

    const value = useMemo<ThemeContextType>(() => ({
        theme,
        resolvedTheme,
        setTheme,
    }), [theme, resolvedTheme, setTheme]);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}

// Script to prevent flash of unstyled content (FOUC)
// This runs before React hydrates and sets the correct theme class
export function ThemeScript() {
    const script = `
        (function() {
            try {
                var theme = localStorage.getItem('${THEME_STORAGE_KEY}');
                var resolved = theme;
                if (!theme || theme === 'system') {
                    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                }
                document.documentElement.classList.add(resolved);
            } catch (e) {
                document.documentElement.classList.add('dark');
            }
        })();
    `;

    return (
        <script
            dangerouslySetInnerHTML={{ __html: script }}
            suppressHydrationWarning
        />
    );
}
