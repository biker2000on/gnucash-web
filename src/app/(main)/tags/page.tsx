'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import TagChip, { tagColorClass } from '@/components/tags/TagChip';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';
import { TAG_COLORS, normalizeTagName, isValidTagName, type Tag } from '@/lib/tags';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';

export default function TagsPage() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const [tags, setTags] = useState<Tag[]>([]);
    const [loading, setLoading] = useState(true);
    const [newTagName, setNewTagName] = useState('');
    const [creating, setCreating] = useState(false);

    // Edit modal state
    const [editingTag, setEditingTag] = useState<Tag | null>(null);
    const [editName, setEditName] = useState('');
    const [editColor, setEditColor] = useState<string | null>(null);
    const [editDescription, setEditDescription] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);

    // Delete confirmation state
    const [deletingTag, setDeletingTag] = useState<Tag | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchTags = useCallback(async () => {
        try {
            const res = await fetch('/api/tags');
            if (!res.ok) throw new Error('Failed to fetch tags');
            setTags(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load tags');
        } finally {
            setLoading(false);
        }
    }, [error]);

    useEffect(() => {
        fetchTags();
    }, [fetchTags]);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        const name = normalizeTagName(newTagName);
        if (!isValidTagName(name)) {
            error('Tag names may only contain lowercase letters, digits, hyphens, and underscores.');
            return;
        }
        setCreating(true);
        try {
            const res = await fetch('/api/tags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to create tag');
            }
            setNewTagName('');
            success(`Created tag #${name}`);
            await fetchTags();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to create tag');
        } finally {
            setCreating(false);
        }
    };

    const openEdit = (tag: Tag) => {
        setEditingTag(tag);
        setEditName(tag.name);
        setEditColor(tag.color);
        setEditDescription(tag.description ?? '');
    };

    const handleSaveEdit = async () => {
        if (!editingTag) return;
        const name = normalizeTagName(editName);
        if (!isValidTagName(name)) {
            error('Tag names may only contain lowercase letters, digits, hyphens, and underscores.');
            return;
        }
        setSavingEdit(true);
        try {
            const res = await fetch(`/api/tags/${editingTag.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color: editColor, description: editDescription || null }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to update tag');
            }
            success(`Updated tag #${name}`);
            setEditingTag(null);
            await fetchTags();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to update tag');
        } finally {
            setSavingEdit(false);
        }
    };

    const handleDelete = async () => {
        if (!deletingTag) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/tags/${deletingTag.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete tag');
            }
            success(`Deleted tag #${deletingTag.name}`);
            setDeletingTag(null);
            await fetchTags();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete tag');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="space-y-6">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Tags</h1>
                    <p className="text-foreground-muted">
                        Flat labels for accounts and transactions. Search any ledger with <span className="font-mono text-foreground-secondary">#tag</span>.
                    </p>
                </div>
                <form onSubmit={handleCreate} className="flex gap-2">
                    <input
                        type="text"
                        value={newTagName}
                        onChange={(e) => setNewTagName(e.target.value)}
                        placeholder="New tag name..."
                        className="bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all"
                    />
                    <button
                        type="submit"
                        disabled={creating || !newTagName.trim() || isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        {creating ? 'Creating...' : '+ Create Tag'}
                    </button>
                </form>
            </header>

            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl overflow-hidden shadow-2xl">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading tags...</span>
                    </div>
                ) : tags.length === 0 ? (
                    <div className="p-12 text-center text-foreground-muted">
                        No tags yet. Create one above, or tag a transaction from its context menu (right-click → Tags…).
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Tag</th>
                                    <th className="px-4 py-2 font-semibold">Description</th>
                                    <th className="px-4 py-2 font-semibold text-right">Transactions</th>
                                    <th className="px-4 py-2 font-semibold text-right">Accounts</th>
                                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {tags.map(tag => (
                                    <tr key={tag.id} className="hover:bg-white/[0.02] transition-colors">
                                        <td className="px-4 py-3">
                                            <Link
                                                href={`/ledger?search=${encodeURIComponent(`#${tag.name}`)}`}
                                                title={`Show transactions tagged #${tag.name}`}
                                            >
                                                <TagChip name={tag.name} color={tag.color} size="sm" className="cursor-pointer hover:brightness-125 transition-all" />
                                            </Link>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-foreground-secondary max-w-md truncate">
                                            {tag.description || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-sm font-mono text-right text-foreground-secondary">
                                            {tag.transaction_count ?? 0}
                                        </td>
                                        <td className="px-4 py-3 text-sm font-mono text-right text-foreground-secondary">
                                            {tag.account_count ?? 0}
                                        </td>
                                        <td className="px-4 py-3 text-right whitespace-nowrap">
                                            <button
                                                type="button"
                                                onClick={() => openEdit(tag)}
                                                className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setDeletingTag(tag)}
                                                className="ml-1 px-2 py-1 text-xs rounded-md text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 transition-colors"
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Edit tag modal */}
            <Modal isOpen={!!editingTag} onClose={() => setEditingTag(null)} title="Edit Tag" size="sm">
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-foreground-secondary mb-2">Name</label>
                        <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 transition-all"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-foreground-secondary mb-2">Color</label>
                        <div className="flex flex-wrap gap-1.5">
                            {TAG_COLORS.map(color => (
                                <button
                                    key={color}
                                    type="button"
                                    onClick={() => setEditColor(color)}
                                    title={color}
                                    className={`px-2 py-1 rounded text-[10px] font-medium border transition-all ${tagColorClass(color)} ${
                                        editColor === color ? 'ring-2 ring-primary/60' : 'opacity-70 hover:opacity-100'
                                    }`}
                                >
                                    {color}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-foreground-secondary mb-2">Description</label>
                        <textarea
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            rows={2}
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 transition-all resize-none"
                            placeholder="Optional description..."
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditingTag(null)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleSaveEdit}
                            disabled={savingEdit}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                        >
                            {savingEdit ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Delete confirmation */}
            <ConfirmationDialog
                isOpen={!!deletingTag}
                onConfirm={handleDelete}
                onCancel={() => setDeletingTag(null)}
                title="Delete Tag"
                message={deletingTag
                    ? `Delete tag #${deletingTag.name}? It is used on ${deletingTag.transaction_count ?? 0} transaction${(deletingTag.transaction_count ?? 0) === 1 ? '' : 's'} and ${deletingTag.account_count ?? 0} account${(deletingTag.account_count ?? 0) === 1 ? '' : 's'}. The tag will be removed everywhere. This cannot be undone.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
