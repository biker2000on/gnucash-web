'use client';

/**
 * Modals for the AccountLedger edit-mode bulk actions: bulk description
 * editing (set / find-and-replace) and bulk tag add/remove. Both submit
 * through the parent's handler, which calls PATCH /api/transactions/bulk.
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { TagPicker, type SelectedTag } from '@/components/tags/TagPicker';
import type { Tag } from '@/lib/tags';

export interface BulkDescriptionPayload {
    description?: string;
    descriptionReplace?: { find: string; replace: string };
}

interface BulkDescriptionModalProps {
    isOpen: boolean;
    count: number;
    onClose: () => void;
    onSubmit: (payload: BulkDescriptionPayload) => Promise<void>;
}

export function BulkDescriptionModal({ isOpen, count, onClose, onSubmit }: BulkDescriptionModalProps) {
    const [mode, setMode] = useState<'set' | 'replace'>('set');
    const [value, setValue] = useState('');
    const [find, setFind] = useState('');
    const [replace, setReplace] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setMode('set');
            setValue('');
            setFind('');
            setReplace('');
            setBusy(false);
        }
    }, [isOpen]);

    const canSubmit = mode === 'set' ? value.trim().length > 0 : find.length > 0;

    const handleSubmit = async () => {
        if (!canSubmit || busy) return;
        setBusy(true);
        try {
            await onSubmit(
                mode === 'set'
                    ? { description: value }
                    : { descriptionReplace: { find, replace } }
            );
            onClose();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Edit description of ${count} transaction${count !== 1 ? 's' : ''}`} size="sm">
            <div className="p-4 space-y-4">
                <div className="flex gap-2">
                    {([['set', 'Set description'], ['replace', 'Find & replace']] as const).map(([m, label]) => (
                        <button
                            key={m}
                            onClick={() => setMode(m)}
                            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                                mode === m
                                    ? 'bg-primary/10 border-primary/30 text-primary'
                                    : 'border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {mode === 'set' ? (
                    <div className="space-y-1">
                        <label className="block text-xs text-foreground-secondary" htmlFor="bulk-desc-value">
                            New description (applied to all selected)
                        </label>
                        <input
                            id="bulk-desc-value"
                            type="text"
                            value={value}
                            onChange={e => setValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') void handleSubmit(); }}
                            autoFocus
                            className="w-full px-3 py-2 text-sm bg-input-bg border border-border rounded-lg text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <label className="block text-xs text-foreground-secondary" htmlFor="bulk-desc-find">
                                Find (case-insensitive, literal text)
                            </label>
                            <input
                                id="bulk-desc-find"
                                type="text"
                                value={find}
                                onChange={e => setFind(e.target.value)}
                                autoFocus
                                className="w-full px-3 py-2 text-sm bg-input-bg border border-border rounded-lg text-foreground focus:outline-none focus:border-primary/50"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="block text-xs text-foreground-secondary" htmlFor="bulk-desc-replace">
                                Replace with
                            </label>
                            <input
                                id="bulk-desc-replace"
                                type="text"
                                value={replace}
                                onChange={e => setReplace(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') void handleSubmit(); }}
                                className="w-full px-3 py-2 text-sm bg-input-bg border border-border rounded-lg text-foreground focus:outline-none focus:border-primary/50"
                            />
                        </div>
                    </div>
                )}

                <div className="flex gap-3 justify-end pt-2">
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="px-3 py-2 text-sm rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => void handleSubmit()}
                        disabled={!canSubmit || busy}
                        className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                    >
                        {busy ? 'Applying…' : `Apply to ${count}`}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

interface BulkTagsModalProps {
    isOpen: boolean;
    count: number;
    onClose: () => void;
    onSubmit: (addTagIds: number[], removeTagIds: number[]) => Promise<void>;
}

export function BulkTagsModal({ isOpen, count, onClose, onSubmit }: BulkTagsModalProps) {
    const [addTags, setAddTags] = useState<SelectedTag[]>([]);
    const [removeTags, setRemoveTags] = useState<SelectedTag[]>([]);
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            setAddTags([]);
            setRemoveTags([]);
            setBusy(false);
            setErrorText(null);
        }
    }, [isOpen]);

    const canSubmit = addTags.length > 0 || removeTags.length > 0;

    /** Map picked tag names to ids, creating brand-new "add" tags on the fly. */
    const resolveIds = async (): Promise<{ addIds: number[]; removeIds: number[] }> => {
        const res = await fetch('/api/tags');
        const allTags: Tag[] = res.ok ? await res.json() : [];
        const byName = new Map(allTags.map(t => [t.name, t.id]));

        const addIds: number[] = [];
        for (const tag of addTags) {
            const existing = byName.get(tag.name);
            if (existing !== undefined) {
                addIds.push(existing);
                continue;
            }
            const createRes = await fetch('/api/tags', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: tag.name }),
            });
            if (!createRes.ok) {
                const data = await createRes.json().catch(() => ({}));
                throw new Error(data.error || `Failed to create tag "${tag.name}"`);
            }
            const created: Tag = await createRes.json();
            addIds.push(created.id);
        }

        // Unknown "remove" names cannot be on any transaction; drop them.
        const removeIds = removeTags
            .map(t => byName.get(t.name))
            .filter((id): id is number => id !== undefined);

        return { addIds, removeIds };
    };

    const handleSubmit = async () => {
        if (!canSubmit || busy) return;
        setBusy(true);
        setErrorText(null);
        try {
            const { addIds, removeIds } = await resolveIds();
            await onSubmit(addIds, removeIds);
            onClose();
        } catch (err) {
            setErrorText(err instanceof Error ? err.message : 'Failed to update tags');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Tags for ${count} transaction${count !== 1 ? 's' : ''}`} size="sm">
            <div className="p-4 space-y-4">
                <div className="space-y-1">
                    <label className="block text-xs text-foreground-secondary">Add tags</label>
                    <TagPicker selected={addTags} onChange={setAddTags} placeholder="Add tags to all selected..." autoFocus />
                </div>
                <div className="space-y-1">
                    <label className="block text-xs text-foreground-secondary">Remove tags</label>
                    <TagPicker selected={removeTags} onChange={setRemoveTags} placeholder="Remove tags from all selected..." />
                </div>
                {errorText && (
                    <p className="text-xs text-negative">{errorText}</p>
                )}
                <div className="flex gap-3 justify-end pt-2">
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="px-3 py-2 text-sm rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => void handleSubmit()}
                        disabled={!canSubmit || busy}
                        className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                    >
                        {busy ? 'Applying…' : `Apply to ${count}`}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
