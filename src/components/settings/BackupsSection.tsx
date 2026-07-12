'use client';

import { useCallback, useEffect, useState } from 'react';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useToast } from '@/contexts/ToastContext';

interface BackupItem {
    id: number;
    sizeBytes: number;
    createdAt: string;
}

function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
}

export function BackupsSection() {
    const { success, error } = useToast();
    const [backups, setBackups] = useState<BackupItem[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [running, setRunning] = useState(false);

    const refresh = useCallback(() => {
        fetch('/api/settings/backups')
            .then(r => (r.ok ? r.json() : null))
            .then(data => setBackups(data?.backups ?? []))
            .catch(() => undefined)
            .finally(() => setLoaded(true));
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const runNow = async () => {
        setRunning(true);
        try {
            const res = await fetch('/api/settings/backups', { method: 'POST' });
            if (!res.ok) throw new Error();
            const body = await res.json();
            if (body.status === 'completed') {
                success('Backup completed');
                refresh();
            } else {
                success('Backup queued — it will appear in the list shortly');
                setTimeout(refresh, 5000);
            }
        } catch {
            error('Failed to run backup');
        } finally {
            setRunning(false);
        }
    };

    const remove = async (id: number) => {
        try {
            const res = await fetch(`/api/settings/backups/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            setBackups(prev => prev.filter(b => b.id !== id));
            success('Backup deleted');
        } catch {
            error('Failed to delete backup');
        }
    };

    return (
        <CollapsibleConfigSection
            title="Book Backups"
            summary={backups.length > 0 ? `${backups.length} stored` : 'Nightly'}
            configured={backups.length > 0}
            storageKey="settings.backupsOpen"
        >
            <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <p className="text-sm text-foreground-muted">
                        Every book is exported nightly (02:30 UTC) to compressed GnuCash XML — openable in
                        GnuCash desktop or restorable via Import/Export. Retention keeps the newest{' '}
                        {process.env.NEXT_PUBLIC_BACKUP_RETENTION || '30'} per book (BACKUP_RETENTION).
                    </p>
                    <button
                        onClick={runNow}
                        disabled={running}
                        className="inline-flex items-center justify-center px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors shrink-0 disabled:opacity-50"
                    >
                        {running ? 'Running…' : 'Back up now'}
                    </button>
                </div>

                {!loaded ? (
                    <p className="text-sm text-foreground-tertiary">Loading…</p>
                ) : backups.length === 0 ? (
                    <p className="text-sm text-foreground-tertiary">No backups yet for this book.</p>
                ) : (
                    <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
                        {backups.map(b => (
                            <div key={b.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                                <div className="min-w-0">
                                    <span className="text-foreground font-medium">
                                        {new Date(b.createdAt).toLocaleString()}
                                    </span>
                                    <span className="ml-2 text-foreground-tertiary font-mono text-xs">{formatSize(b.sizeBytes)}</span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <a
                                        href={`/api/settings/backups/${b.id}`}
                                        className="px-2.5 py-1 rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors text-xs"
                                    >
                                        Download
                                    </a>
                                    <button
                                        onClick={() => remove(b.id)}
                                        className="px-2.5 py-1 rounded-md border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 transition-colors text-xs"
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </CollapsibleConfigSection>
    );
}
