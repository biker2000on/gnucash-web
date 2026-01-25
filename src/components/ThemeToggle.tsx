"use client";

import { useTheme } from '@/contexts/ThemeContext';

interface ThemeToggleProps {
    className?: string;
}

export function ThemeToggle({ className = '' }: ThemeToggleProps) {
    const { theme, setTheme } = useTheme();

    const themes: { value: 'light' | 'dark' | 'system'; label: string; icon: React.ReactNode }[] = [
        {
            value: 'light',
            label: 'Light',
            icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
            ),
        },
        {
            value: 'dark',
            label: 'Dark',
            icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
            ),
        },
        {
            value: 'system',
            label: 'System',
            icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
            ),
        },
    ];

    return (
        <div className={`flex items-center gap-1 p-1 rounded-xl bg-neutral-200 dark:bg-neutral-800 transition-colors ${className}`}>
            {themes.map(({ value, label, icon }) => (
                <button
                    key={value}
                    onClick={() => setTheme(value)}
                    className={`
                        flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium
                        transition-all duration-200
                        ${theme === value
                            ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-sm'
                            : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200'
                        }
                    `}
                    title={label}
                    aria-label={`Switch to ${label.toLowerCase()} theme`}
                >
                    {icon}
                    <span className="hidden sm:inline">{label}</span>
                </button>
            ))}
        </div>
    );
}

// Compact version for tight spaces
export function ThemeToggleCompact({ className = '' }: ThemeToggleProps) {
    const { theme, resolvedTheme, setTheme } = useTheme();

    const cycleTheme = () => {
        const order: ('light' | 'dark' | 'system')[] = ['light', 'dark', 'system'];
        const currentIndex = order.indexOf(theme);
        const nextIndex = (currentIndex + 1) % order.length;
        setTheme(order[nextIndex]);
    };

    const getIcon = () => {
        if (theme === 'system') {
            return (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
            );
        }
        if (resolvedTheme === 'dark') {
            return (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
            );
        }
        return (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
        );
    };

    const getLabel = () => {
        if (theme === 'system') return 'System';
        if (theme === 'dark') return 'Dark';
        return 'Light';
    };

    return (
        <button
            onClick={cycleTheme}
            className={`
                p-2 rounded-lg
                text-neutral-600 dark:text-neutral-400
                hover:bg-neutral-200 dark:hover:bg-neutral-800
                hover:text-neutral-900 dark:hover:text-neutral-100
                transition-all duration-200
                ${className}
            `}
            title={`Theme: ${getLabel()}. Click to change.`}
            aria-label={`Current theme: ${getLabel()}. Click to cycle through themes.`}
        >
            {getIcon()}
        </button>
    );
}
