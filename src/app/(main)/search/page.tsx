'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { DocSearchResults, DocSearchHit, SearchSnippet, DocSearchGroup } from '@/lib/doc-search';

const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 300;

const GROUP_ORDER: Array<{ key: DocSearchGroup; label: string }> = [
    { key: 'transactions', label: 'Transactions' },
    { key: 'receipts', label: 'Receipts' },
    { key: 'statements', label: 'Statements' },
    { key: 'payslips', label: 'Payslips' },
];

function HighlightedSnippet({ snippet }: { snippet: SearchSnippet }) {
    if (snippet.highlightStart < 0 || snippet.highlightEnd <= snippet.highlightStart) {
        return <span>{snippet.text}</span>;
    }
    return (
        <span>
            {snippet.text.slice(0, snippet.highlightStart)}
            <span className="text-primary font-medium">
                {snippet.text.slice(snippet.highlightStart, snippet.highlightEnd)}
            </span>
            {snippet.text.slice(snippet.highlightEnd)}
        </span>
    );
}

function HitRow({ hit }: { hit: DocSearchHit }) {
    return (
        <Link
            href={hit.href}
            className="block px-4 py-3 border-b border-border/50 last:border-b-0 hover:bg-surface-hover transition-colors"
        >
            <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm text-foreground font-medium truncate">{hit.title}</span>
                {hit.date && (
                    <span className="text-xs font-mono tabular-nums text-foreground-muted shrink-0">
                        {hit.date}
                    </span>
                )}
            </div>
            <p className="text-xs text-foreground-secondary mt-1 break-words">
                <HighlightedSnippet snippet={hit.snippet} />
            </p>
            {hit.meta && <p className="text-xs text-foreground-muted mt-0.5 truncate">{hit.meta}</p>}
        </Link>
    );
}

export default function DocumentSearchPage() {
    const [input, setInput] = useState('');
    const [results, setResults] = useState<DocSearchResults | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const trimmed = input.trim();
    const isQueryLongEnough = trimmed.length >= MIN_QUERY_LENGTH;

    useEffect(() => {
        if (!isQueryLongEnough) {
            setResults(null);
            setError(null);
            setIsLoading(false);
            return;
        }

        let cancelled = false;
        setIsLoading(true);
        setError(null);

        const timer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/search/documents?q=${encodeURIComponent(trimmed)}`);
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    throw new Error(body?.error ?? 'Search failed');
                }
                const data: DocSearchResults = await res.json();
                if (!cancelled) setResults(data);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Search failed');
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        }, DEBOUNCE_MS);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [trimmed, isQueryLongEnough]);

    return (
        <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-2xl font-semibold text-foreground">Search documents</h1>
                <p className="text-sm text-foreground-secondary mt-1">
                    Search receipts (OCR text), statement lines, payslips, and transaction
                    descriptions and memos in the active book.
                </p>
            </div>

            <input
                type="search"
                autoFocus
                data-search-input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Search receipts, statements, payslips, transactions…"
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-primary transition-colors"
            />

            {!isQueryLongEnough && (
                <div className="text-center py-16 border border-dashed border-border rounded-lg">
                    <p className="text-sm text-foreground-muted">
                        Type at least {MIN_QUERY_LENGTH} characters to search
                    </p>
                </div>
            )}

            {isQueryLongEnough && error && (
                <div className="px-4 py-3 border border-error/40 bg-error/10 rounded-lg text-sm text-error">
                    {error}
                </div>
            )}

            {isQueryLongEnough && isLoading && !results && (
                <p className="text-sm text-foreground-muted">Searching…</p>
            )}

            {isQueryLongEnough && !error && results && results.totalHits === 0 && !isLoading && (
                <div className="text-center py-16 border border-dashed border-border rounded-lg">
                    <p className="text-sm text-foreground">No matches for “{results.query}”</p>
                    <p className="text-xs text-foreground-muted mt-1">
                        Try a shorter word, a vendor name, or an amount memo.
                    </p>
                </div>
            )}

            {isQueryLongEnough && results && results.totalHits > 0 && (
                <div className={`space-y-6 ${isLoading ? 'opacity-60' : ''}`}>
                    {GROUP_ORDER.map(({ key, label }) => {
                        const hits = results[key];
                        if (hits.length === 0) return null;
                        return (
                            <section key={key} className="bg-surface border border-border rounded-lg overflow-hidden">
                                <h2 className="px-4 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium border-b border-border bg-background-tertiary/50">
                                    {label}
                                    <span className="ml-2 font-mono tabular-nums">{hits.length}</span>
                                </h2>
                                <div>
                                    {hits.map((hit) => (
                                        <HitRow key={`${key}-${hit.id}`} hit={hit} />
                                    ))}
                                </div>
                            </section>
                        );
                    })}
                    <p className="text-xs text-foreground-muted">
                        Showing up to 20 results per group. Transaction hits open the ledger
                        pre-filtered to this search.
                    </p>
                </div>
            )}
        </div>
    );
}
