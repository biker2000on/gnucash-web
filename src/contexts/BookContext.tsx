'use client';

import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';

interface Book {
    guid: string;
    name: string;
    description?: string | null;
    accountCount?: number;
}

interface BookContextType {
    activeBookGuid: string | null;
    books: Book[];
    switchBook: (guid: string) => Promise<void>;
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

    const switchBook = useCallback(async (guid: string) => {
        try {
            const res = await fetch('/api/books/active', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bookGuid: guid }),
            });
            if (res.ok) {
                // If on an account-specific ledger, redirect to account hierarchy
                // since the account GUID belongs to the old book
                const path = window.location.pathname;
                if (/^\/accounts\/[^/]+/.test(path)) {
                    window.location.href = '/accounts';
                } else {
                    // Full reload ensures all pages re-fetch data for the new book
                    window.location.reload();
                }
            }
        } catch (err) {
            console.error('Error switching book:', err);
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
