'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * Soft informational banner shown on personal-planning tools (FIRE, drawdown)
 * when the active book's entity profile is a business or nonprofit — the
 * inverse of HouseholdBookBanner. The tool still works; this is just a gentle
 * heads-up that the results assume a household's finances.
 */
export function PersonalToolNotice() {
    const [isBusinessBook, setIsBusinessBook] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/entity')
            .then(res => (res.ok ? res.json() : null))
            .then(profile => {
                if (!cancelled && profile?.entityType && profile.entityType !== 'household') {
                    setIsBusinessBook(true);
                }
            })
            .catch(() => { /* banner is best-effort */ });
        return () => { cancelled = true; };
    }, []);

    if (!isBusinessBook) return null;

    return (
        <div className="flex items-start gap-3 bg-secondary-light border border-secondary/30 rounded-lg px-4 py-3 text-sm">
            <svg className="w-4 h-4 mt-0.5 shrink-0 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-foreground-secondary">
                This tool is designed for household books — this book is a business or nonprofit,
                so the results may not apply. See{' '}
                <Link href="/planning" className="text-primary hover:text-primary-hover underline underline-offset-2">
                    Planning
                </Link>{' '}
                for tools that fit any book.
            </p>
        </div>
    );
}
