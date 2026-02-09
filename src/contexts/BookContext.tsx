'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useRouter } from 'next/navigation';

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
}

const BookContext = createContext<BookContextType | null>(null);

export function BookProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
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
                setActiveBookGuid(guid);
                router.refresh();
            }
        } catch (err) {
            console.error('Error switching book:', err);
        }
    }, [router]);

    return (
        <BookContext.Provider value={{ activeBookGuid, books, switchBook, refreshBooks, loading }}>
            {children}
        </BookContext.Provider>
    );
}

export function useBooks() {
    const ctx = useContext(BookContext);
    if (!ctx) throw new Error('useBooks must be used within BookProvider');
    return ctx;
}
