'use client';

import { ReactNode } from 'react';
import { getGlossaryEntry } from '@/lib/glossary';
import { Tooltip } from './Tooltip';

export interface AbbrProps {
    /** Glossary key (canonical spelling), e.g. "QBI" or "Schedule F". */
    term: string;
    /** Custom display text; defaults to the term itself. */
    children?: ReactNode;
    /** Extra classes for the trigger wrapper. */
    className?: string;
    /** Hide the (i) icon (e.g. cramped column headers); dotted underline remains. */
    hideIcon?: boolean;
}

const warned = new Set<string>();

/** Small (i) glyph, sized to ride alongside the abbreviation text. */
function InfoGlyph() {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="ml-0.5 inline-block h-[0.72em] w-[0.72em] self-center text-foreground-muted transition-colors duration-150 group-hover:text-primary group-focus-visible:text-primary"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
        >
            <circle cx="8" cy="8" r="6.75" />
            <line x1="8" y1="7.2" x2="8" y2="11.2" strokeLinecap="round" />
            <circle cx="8" cy="4.8" r="0.9" fill="currentColor" stroke="none" />
        </svg>
    );
}

/**
 * Renders an abbreviation with a small (i) affordance and a glossary tooltip
 * (expansion + optional plain-English gloss) on hover, tap, and keyboard focus.
 *
 * Per DESIGN.md ("Abbreviations"): first occurrence of an abbreviation in a view
 * gets an <Abbr>; repeated occurrences in a table column get it in the column
 * header only. Unknown terms fall back to plain text (with a dev-only warning).
 */
export function Abbr({ term, children, className = '', hideIcon = false }: AbbrProps) {
    const entry = getGlossaryEntry(term);

    if (!entry) {
        if (process.env.NODE_ENV !== 'production' && !warned.has(term)) {
            warned.add(term);
            console.warn(`<Abbr>: unknown glossary term "${term}" — add it to src/lib/glossary.ts`);
        }
        return <>{children ?? term}</>;
    }

    return (
        <Tooltip
            ariaLabel={`${term}: ${entry.expansion}`}
            className={`group underline decoration-dotted decoration-[color:var(--foreground-muted)] underline-offset-2 hover:decoration-[color:var(--primary)] ${className}`}
            content={
                <span className="block">
                    <span className="block font-medium text-foreground">{entry.expansion}</span>
                    {entry.gloss && (
                        <span className="mt-1 block text-foreground-secondary">{entry.gloss}</span>
                    )}
                </span>
            }
        >
            {children ?? term}
            {!hideIcon && <InfoGlyph />}
        </Tooltip>
    );
}
