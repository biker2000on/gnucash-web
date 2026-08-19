'use client';

import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';

interface Book {
    guid: string;
    name: string;
    description?: string | null;
    accountCount?: number;
    /** The current user's role on this book: readonly | edit | admin. */
    role?: string;
}

/**
 * Outcome of an active-book switch. The server re-verifies the caller's role on
 * the target book, so a refusal must reach the UI — a click that silently does
 * nothing reads as a broken page.
 */
export interface SwitchBookResult {
    ok: boolean;
    error?: string;
}

interface BookContextType {
    activeBookGuid: string | null;
    books: Book[];
    switchBook: (guid: string, destination?: string) => Promise<SwitchBookResult>;
    refreshBooks: () => Promise<void>;
    loading: boolean;
    hasNoBooks: boolean;
}

const BookContext = createContext<BookContextType | null>(null);

export function BookProvider({ children }: { children: ReactNode }) {
    const [activeBookGuid, setActiveBookGuid] = useState<string | null>(null);
    const [books, setBooks] = useState<Book[]>([]);
    const [loading, setLoading] = useState(true);

    const refreshBooks = useCallback(async () => {
        try {
            const [booksRes, activeRes] = await Promise.all([
                fetch('/api/books'),
                fetch('/api/books/active'),
            ]);
            if (booksRes.ok) {
                const data = await booksRes.json();
                setBooks(data);
            }
            if (activeRes.ok) {
                const data = await activeRes.json();
                setActiveBookGuid(data.activeBookGuid);
            }
        } catch (err) {
            console.error('Error fetching books:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshBooks();
    }, [refreshBooks]);

    const switchBook = useCallback(async (guid: string, destination?: string): Promise<SwitchBookResult> => {
        try {
            const res = await fetch('/api/books/active', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bookGuid: guid }),
            });
            if (!res.ok) {
                // The server re-checks the role, so a refusal here is
                // authoritative even when the client's book list says otherwise
                // (stale after a revoked grant). Report it rather than leaving
                // the caller with a click that silently did nothing.
                const body = await res.json().catch(() => null);
                return { ok: false, error: body?.error ?? 'You do not have access to that book.' };
            }
            if (destination) {
                window.location.href = destination;
                return { ok: true };
            }
            // If on an account-specific ledger, redirect to account hierarchy
            // since the account GUID belongs to the old book
            const path = window.location.pathname;
            if (/^\/accounts\/[^/]+/.test(path)) {
                // Deliberate full document load, not a client navigation: the
                // book cookie just changed, so every cached client query,
                // context, and RSC payload for the old book has to be dropped.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.href = '/accounts';
            } else {
                // Full reload ensures all pages re-fetch data for the new book
                window.location.reload();
            }
            return { ok: true };
        } catch (err) {
            console.error('Error switching book:', err);
            return { ok: false, error: 'Could not reach the server to switch books.' };
        }
    }, []);

    const hasNoBooks = !loading && books.length === 0;

    const value = useMemo(
        () => ({ activeBookGuid, books, switchBook, refreshBooks, loading, hasNoBooks }),
        [activeBookGuid, books, switchBook, refreshBooks, loading, hasNoBooks]
    );

    return (
        <BookContext.Provider value={value}>
            {children}
        </BookContext.Provider>
    );
}

export function useBooks() {
    const ctx = useContext(BookContext);
    if (!ctx) throw new Error('useBooks must be used within BookProvider');
    return ctx;
}
