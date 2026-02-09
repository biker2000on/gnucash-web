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
}

export default function BookEditorModal({ book, isOpen, onClose, onSaved }: BookEditorModalProps) {
    const [name, setName] = useState(book.name);
    const [description, setDescription] = useState(book.description || '');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        setName(book.name);
        setDescription(book.description || '');
        setError('');
    }, [book.guid]);

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
                        className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
                        className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                        placeholder="Optional description"
                        disabled={loading}
                    />
                </div>

                {error && (
                    <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
                        {error}
                    </div>
                )}

                <div className="flex gap-3 pt-2">
                    <button
                        onClick={onClose}
                        disabled={loading}
                        className="flex-1 px-4 py-2 text-sm font-medium text-foreground-secondary bg-surface-hover rounded-lg hover:bg-surface-hover/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={loading}
                        className="flex-1 px-4 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
