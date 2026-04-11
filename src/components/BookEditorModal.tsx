'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';

interface Book {
    guid: string;
    name: string;
    description?: string | null;
}

interface BookEditorModalProps {
    book: Book;
    isOpen: boolean;
    onClose: () => void;
    onSaved: () => void;
    onDeleted: (remainingBooks: number) => void;
}

export default function BookEditorModal({ book, isOpen, onClose, onSaved, onDeleted }: BookEditorModalProps) {
    const [name, setName] = useState(book.name);
    const [description, setDescription] = useState(book.description || '');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        setName(book.name);
        setDescription(book.description || '');
        setError('');
        setConfirmingDelete(false);
    }, [book.description, book.guid, book.name]);

    const handleSave = async () => {
        if (!name.trim()) {
            setError('Name is required');
            return;
        }

        setError('');
        setLoading(true);

        try {
            const res = await fetch(`/api/books/${book.guid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    description: description.trim() || null,
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                setError(data.error || 'Failed to update book');
                return;
            }

            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update book');
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async () => {
        setError('');
        setDeleting(true);

        try {
            const res = await fetch(`/api/books/${book.guid}`, {
                method: 'DELETE',
            });

            if (!res.ok) {
                const data = await res.json();
                setError(data.error || 'Failed to delete book');
                return;
            }

            const data = await res.json();
            onDeleted(data.remainingBooks);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete book');
        } finally {
            setDeleting(false);
            setConfirmingDelete(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Edit Book" size="md">
            <div className="p-6 space-y-4">
                <div>
                    <label htmlFor="book-name" className="block text-sm font-medium text-foreground mb-1.5">
                        Name <span className="text-red-400">*</span>
                    </label>
                    <input
                        id="book-name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-primary"
                        placeholder="Book name"
                        disabled={loading}
                    />
                </div>

                <div>
                    <label htmlFor="book-description" className="block text-sm font-medium text-foreground mb-1.5">
                        Description
                    </label>
                    <textarea
                        id="book-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={4}
                        className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                        placeholder="Optional description"
                        disabled={loading}
                    />
                </div>

                {error && (
                    <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
                        {error}
                    </div>
                )}

                {/* Delete section */}
                <div className="border-t border-border pt-4">
                    {!confirmingDelete ? (
                        <button
                            onClick={() => setConfirmingDelete(true)}
                            disabled={loading || deleting}
                            className="px-4 py-2 text-sm font-medium text-red-400 bg-red-500/10 rounded-lg hover:bg-red-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Delete Book
                        </button>
                    ) : (
                        <div className="px-3 py-3 bg-red-500/10 border border-red-500/30 rounded-lg space-y-3">
                            <p className="text-sm text-red-400">
                                This will permanently delete <strong>{book.name}</strong> and all its accounts and transactions. This cannot be undone.
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setConfirmingDelete(false)}
                                    disabled={deleting}
                                    className="flex-1 px-4 py-2 text-sm font-medium text-foreground-secondary bg-surface-hover rounded-lg hover:bg-surface-hover/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting}
                                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {deleting ? 'Deleting...' : 'Yes, Delete'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex gap-3 pt-2">
                    <button
                        onClick={onClose}
                        disabled={loading || deleting}
                        className="flex-1 px-4 py-2 text-sm font-medium text-foreground-secondary bg-surface-hover rounded-lg hover:bg-surface-hover/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={loading || deleting}
                        className="flex-1 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
