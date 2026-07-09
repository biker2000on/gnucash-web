'use client';

import { useEffect, useState } from 'react';

/**
 * Soft informational banner shown on business pages when the active book's
 * entity profile is a household. Business features still work; this is just
 * a gentle heads-up that they're intended for business books.
 */
export function HouseholdBookBanner() {
    const [isHousehold, setIsHousehold] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/entity')
            .then(res => (res.ok ? res.json() : null))
            .then(profile => {
                if (!cancelled && profile?.entityType === 'household') {
                    setIsHousehold(true);
                }
            })
            .catch(() => { /* banner is best-effort */ });
        return () => { cancelled = true; };
    }, []);

    if (!isHousehold) return null;

    return (
        <div className="flex items-start gap-3 bg-secondary-light border border-secondary/30 rounded-lg px-4 py-3 text-sm">
            <svg className="w-4 h-4 mt-0.5 shrink-0 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-foreground-secondary">
                This book is marked as a household — business features are intended for business books.
                You can change the book&apos;s entity type in Settings.
            </p>
        </div>
    );
}
