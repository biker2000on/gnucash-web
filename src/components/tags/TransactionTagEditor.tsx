'use client';

/**
 * Small modal for editing a single transaction's tags, opened from the
 * transaction context menu ("Tags..."). Loads the current tag list, lets the
 * user add/remove via TagPicker, and PUTs the full list on save.
 */

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { TagPicker, type SelectedTag } from './TagPicker';
import { useToast } from '@/contexts/ToastContext';
import type { Tag } from '@/lib/tags';

interface TransactionTagEditorProps {
    transactionGuid: string | null;
    isOpen: boolean;
    onClose: () => void;
    /** Called with the saved tag list so callers can update local row state. */
    onSaved?: (transactionGuid: string, tags: Tag[]) => void;
}

export function TransactionTagEditor({ transactionGuid, isOpen, onClose, onSaved }: TransactionTagEditorProps) {
    const { success, error } = useToast();
    const [tags, setTags] = useState<SelectedTag[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!isOpen || !transactionGuid) return;
        let cancelled = false;
        setLoading(true);
        fetch(`/api/transactions/${transactionGuid}/tags`)
            .then(res => (res.ok ? res.json() : []))
            .then((data: Tag[]) => {
                if (!cancelled) setTags(data.map(t => ({ name: t.name, color: t.color })));
            })
            .catch(() => { if (!cancelled) setTags([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [isOpen, transactionGuid]);

    const handleSave = async () => {
        if (!transactionGuid) return;
        setSaving(true);
        try {
            const res = await fetch(`/api/transactions/${transactionGuid}/tags`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags: tags.map(t => t.name) }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save tags');
            }
            const saved: Tag[] = await res.json();
            success('Tags updated');
            onSaved?.(transactionGuid, saved);
            onClose();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save tags');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Edit Tags" size="sm">
            <div className="space-y-4">
                {loading ? (
                    <div className="flex items-center justify-center py-6">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    </div>
                ) : (
                    <TagPicker selected={tags} onChange={setTags} autoFocus />
                )}
                <p className="text-xs text-foreground-muted">
                    Type to search or create tags. Find tagged transactions later with <span className="font-mono text-foreground-secondary">#tag</span> in the ledger search.
                </p>
                <div className="flex justify-end gap-3 pt-2 border-t border-border">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || loading}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                    >
                        {saving ? 'Saving...' : 'Save Tags'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
