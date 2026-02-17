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

export default function BookSwitcher({ collapsed = false }: BookSwitcherProps) {
    const { activeBookGuid, books, switchBook, refreshBooks, loading } = useBooks();
    const [open, setOpen] = useState(false);
    const [wizardOpen, setWizardOpen] = useState(false);
    const [editingBook, setEditingBook] = useState<Book | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const activeBook = books.find(b => b.guid === activeBookGuid);

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
                        <IconChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                    </>
                )}
            </button>

            {open && (
                <div className={`absolute z-50 mt-1 bg-surface-elevated border border-border rounded-xl shadow-lg overflow-hidden
                    ${collapsed ? 'left-full ml-2 top-0 w-max min-w-56 max-w-80' : 'left-0 w-max min-w-full max-w-80'}`}
                >
                    <div className="py-1 max-h-64 overflow-y-auto">
                        {books.map(book => (
                            <div
                                key={book.guid}
                                className={`flex items-center w-full transition-colors
                                    ${book.guid === activeBookGuid
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
                                    className="flex-1 flex items-start gap-2 px-3 py-2 text-sm text-left"
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="whitespace-nowrap">{book.name}</div>
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
