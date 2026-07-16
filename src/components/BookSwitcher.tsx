'use client';

import { useState, useRef, useEffect } from 'react';
import { useBooks } from '@/contexts/BookContext';
import BookEditorModal from '@/components/BookEditorModal';
import NewBookWizard from '@/components/NewBookWizard';

function IconBook({ className = "w-4 h-4" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.25278C12 6.25278 10.5 3 7 3C3.5 3 2 5 2 7.5V19.5C2 19.5 3.5 18 7 18C10.5 18 12 20 12 20M12 6.25278C12 6.25278 13.5 3 17 3C20.5 3 22 5 22 7.5V19.5C22 19.5 20.5 18 17 18C13.5 18 12 20 12 20M12 6.25278V20" />
        </svg>
    );
}

function IconChevronDown({ className = "w-4 h-4" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
    );
}

function IconPlus({ className = "w-4 h-4" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M12 5v14M5 12h14" />
        </svg>
    );
}

function IconCheck({ className = "w-4 h-4" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
    );
}

function IconPencil({ className = "w-4 h-4" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
    );
}

interface BookSwitcherProps {
    collapsed?: boolean;
}

interface Book {
    guid: string;
    name: string;
    description?: string | null;
    accountCount?: number;
}

function isDemoBook(book: Book | undefined): boolean {
    return !!book?.description?.startsWith('DEMO');
}

function DemoBadge() {
    return (
        <span className="inline-block px-1 py-px rounded bg-warning/15 text-warning text-[10px] font-semibold tracking-wide shrink-0 leading-4 align-middle">
            DEMO
        </span>
    );
}

export default function BookSwitcher({ collapsed = false }: BookSwitcherProps) {
    const { activeBookGuid, books, switchBook, refreshBooks, loading } = useBooks();
    const [open, setOpen] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [wizardOpen, setWizardOpen] = useState(false);
    const [editingBook, setEditingBook] = useState<Book | null>(null);
    const [demoPickerOpen, setDemoPickerOpen] = useState(false);
    const [demoCreating, setDemoCreating] = useState<'household' | 'business' | null>(null);
    const [demoError, setDemoError] = useState<string | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const createDemoBook = async (kind: 'household' | 'business') => {
        if (demoCreating) return;
        setDemoCreating(kind);
        setDemoError(null);
        try {
            const res = await fetch('/api/books/demo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to create demo book');
            setOpen(false);
            setDemoPickerOpen(false);
            await refreshBooks();
            await switchBook(data.bookGuid);
        } catch (err) {
            setDemoError(err instanceof Error ? err.message : 'Failed to create demo book');
        } finally {
            setDemoCreating(null);
        }
    };

    const activeBook = books.find(b => b.guid === activeBookGuid);

    // Reset highlighted index to active book when opening
    useEffect(() => {
        if (open) {
            const frame = requestAnimationFrame(() => {
                const activeIndex = books.findIndex(b => b.guid === activeBookGuid);
                setHighlightedIndex(activeIndex >= 0 ? activeIndex : 0);
                // Focus the list container for keyboard events
                listRef.current?.focus();
            });
            return () => cancelAnimationFrame(frame);
        }
    }, [open, books, activeBookGuid]);

    // Close dropdown on click outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Keyboard navigation for the dropdown
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!open) return;
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                e.stopPropagation();
                setHighlightedIndex(i => Math.min(i + 1, books.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                setHighlightedIndex(i => Math.max(i - 1, 0));
                break;
            case 'Enter': {
                e.preventDefault();
                e.stopPropagation();
                const book = books[highlightedIndex];
                if (book) {
                    if (book.guid !== activeBookGuid) {
                        switchBook(book.guid);
                    }
                    setOpen(false);
                }
                break;
            }
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                break;
        }
    };

    if (loading) {
        return null;
    }

    // If no books exist at all, don't render
    if (books.length === 0) {
        return null;
    }

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setOpen(!open)}
                className={`flex items-center w-full rounded-xl transition-all duration-200 text-sidebar-text hover:bg-sidebar-hover hover:text-foreground
                    ${collapsed ? 'justify-center px-0 py-3' : 'px-4 py-2.5 gap-2'}`}
                title={collapsed ? (activeBook?.name || 'Select Book') : undefined}
            >
                <IconBook className="w-4 h-4 shrink-0" />
                {!collapsed && (
                    <>
                        <span className="flex-1 text-left text-sm font-medium truncate">
                            {activeBook?.name || 'Select Book'}
                        </span>
                        {isDemoBook(activeBook) && <DemoBadge />}
                        <IconChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                    </>
                )}
            </button>

            {open && (
                <div
                    ref={listRef}
                    tabIndex={-1}
                    onKeyDown={handleKeyDown}
                    data-popover
                    className={`absolute z-50 mt-1 bg-surface-elevated border border-border rounded-xl shadow-lg overflow-hidden outline-none
                    ${collapsed ? 'left-full ml-2 top-0 w-max min-w-56 max-w-80' : 'left-0 w-max min-w-full max-w-80'}`}
                >
                    <div className="py-1 max-h-64 overflow-y-auto">
                        {books.map((book, index) => (
                            <div
                                key={book.guid}
                                className={`flex items-center w-full transition-colors
                                    ${index === highlightedIndex
                                        ? 'bg-primary/20 text-foreground'
                                        : book.guid === activeBookGuid
                                            ? 'text-sidebar-text-active bg-sidebar-active-bg/50'
                                            : 'text-foreground-secondary hover:bg-surface-hover'
                                    }`}
                            >
                                <button
                                    onClick={async () => {
                                        if (book.guid !== activeBookGuid) {
                                            await switchBook(book.guid);
                                        }
                                        setOpen(false);
                                    }}
                                    onMouseEnter={() => setHighlightedIndex(index)}
                                    className="flex-1 flex items-start gap-2 px-3 py-2 text-sm text-left"
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="whitespace-nowrap flex items-center gap-1.5">
                                            <span>{book.name}</span>
                                            {isDemoBook(book) && <DemoBadge />}
                                        </div>
                                        {book.description && (
                                            <div className="text-xs text-foreground-tertiary whitespace-nowrap mt-0.5">
                                                {book.description.length > 50
                                                    ? `${book.description.substring(0, 50)}...`
                                                    : book.description}
                                            </div>
                                        )}
                                    </div>
                                    {book.guid === activeBookGuid && (
                                        <IconCheck className="w-4 h-4 shrink-0 text-sidebar-text-active mt-0.5" />
                                    )}
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingBook(book);
                                        setOpen(false);
                                    }}
                                    className="p-2 hover:bg-surface-hover/50 transition-colors"
                                    title="Edit book"
                                >
                                    <IconPencil className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="border-t border-border">
                        <button
                            onClick={() => { setWizardOpen(true); setOpen(false); }}
                            className="flex items-center w-full px-3 py-2 text-sm text-foreground-secondary hover:bg-surface-hover transition-colors gap-2"
                        >
                            <IconPlus className="w-4 h-4" />
                            <span>New Book</span>
                        </button>
                        {!demoPickerOpen ? (
                            <button
                                onClick={() => setDemoPickerOpen(true)}
                                className="flex items-center w-full px-3 pb-2 pt-0.5 text-xs text-foreground-muted hover:text-foreground transition-colors"
                            >
                                Try a demo book
                            </button>
                        ) : (
                            <div className="px-3 pb-2 pt-0.5 space-y-1.5">
                                <div className="text-xs text-foreground-muted">Create a demo book with sample data:</div>
                                <div className="flex gap-1.5">
                                    <button
                                        onClick={() => void createDemoBook('household')}
                                        disabled={demoCreating !== null}
                                        className="flex-1 px-2 py-1 text-xs rounded-md border border-border text-foreground-secondary hover:bg-surface-hover transition-colors disabled:opacity-50"
                                    >
                                        {demoCreating === 'household' ? 'Creating…' : 'Household'}
                                    </button>
                                    <button
                                        onClick={() => void createDemoBook('business')}
                                        disabled={demoCreating !== null}
                                        className="flex-1 px-2 py-1 text-xs rounded-md border border-border text-foreground-secondary hover:bg-surface-hover transition-colors disabled:opacity-50"
                                    >
                                        {demoCreating === 'business' ? 'Creating…' : 'Business'}
                                    </button>
                                </div>
                                {demoError && (
                                    <div className="text-xs text-error">{demoError}</div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {editingBook && (
                <BookEditorModal
                    book={editingBook}
                    isOpen={!!editingBook}
                    onClose={() => setEditingBook(null)}
                    onSaved={() => {
                        setEditingBook(null);
                        refreshBooks();
                    }}
                    onDeleted={async (remainingBooks) => {
                        setEditingBook(null);
                        if (remainingBooks > 0) {
                            await refreshBooks();
                            // Switch to the first available book
                            const booksRes = await fetch('/api/books');
                            if (booksRes.ok) {
                                const updatedBooks = await booksRes.json();
                                if (updatedBooks.length > 0) {
                                    await switchBook(updatedBooks[0].guid);
                                }
                            }
                        } else {
                            await refreshBooks();
                            setWizardOpen(true);
                        }
                    }}
                />
            )}

            <NewBookWizard
                isOpen={wizardOpen}
                onClose={() => setWizardOpen(false)}
                onSuccess={async (bookGuid) => {
                    setWizardOpen(false);
                    await refreshBooks();
                    await switchBook(bookGuid);
                }}
            />
        </div>
    );
}
