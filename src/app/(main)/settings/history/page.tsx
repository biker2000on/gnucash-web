'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';

interface AuditEntry {
    id: number;
    action: string;
    entityType: string;
    entityGuid: string;
    oldValues: unknown;
    newValues: unknown;
    createdAt: string;
    user: string | null;
    undoable: boolean;
}

const PAGE_SIZE = 50;

const ACTION_STYLES: Record<string, string> = {
    CREATE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    UPDATE: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    DELETE: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

const UNDO_LABEL: Record<string, string> = {
    CREATE: 'Delete',
    UPDATE: 'Revert',
    DELETE: 'Restore',
};

function summarize(entry: AuditEntry): string {
    const values = (entry.newValues ?? entry.oldValues) as Record<string, unknown> | null;
    if (!values || typeof values !== 'object') return entry.entityGuid.slice(0, 8);
    const desc = values.description ?? values.name;
    return typeof desc === 'string' && desc ? desc : entry.entityGuid.slice(0, 8);
}

export default function HistoryPage() {
    const { success, error } = useToast();
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [entityType, setEntityType] = useState('');
    const [action, setAction] = useState('');
    const [expanded, setExpanded] = useState<number | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [loaded, setLoaded] = useState(false);

    const load = useCallback((nextOffset: number, type: string, act: string) => {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
        if (type) params.set('entityType', type);
        if (act) params.set('action', act);
        fetch(`/api/audit?${params}`)
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                if (data) {
                    setEntries(data.entries);
                    setTotal(data.total);
                    setOffset(nextOffset);
                }
            })
            .catch(() => undefined)
            .finally(() => setLoaded(true));
    }, []);

    useEffect(() => {
        load(0, entityType, action);
    }, [load, entityType, action]);

    const undo = async (entry: AuditEntry) => {
        setBusyId(entry.id);
        try {
            const res = await fetch(`/api/audit/${entry.id}/undo`, { method: 'POST' });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error ?? 'Undo failed');
            success(body?.message ?? 'Undone');
            load(offset, entityType, action);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Undo failed');
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Change History"
                subtitle="Every recorded mutation, newest first. Transaction entries can be undone."
            />

            <div className="flex flex-wrap gap-3">
                <select
                    value={entityType}
                    onChange={e => setEntityType(e.target.value)}
                    className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-foreground"
                >
                    <option value="">All types</option>
                    <option value="TRANSACTION">Transactions</option>
                    <option value="ACCOUNT">Accounts</option>
                    <option value="BUDGET">Budgets</option>
                    <option value="SCHEDULED_TRANSACTION">Scheduled</option>
                    <option value="TAG">Tags</option>
                    <option value="INVOICE">Invoices</option>
                    <option value="PRICE">Prices</option>
                </select>
                <select
                    value={action}
                    onChange={e => setAction(e.target.value)}
                    className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-foreground"
                >
                    <option value="">All actions</option>
                    <option value="CREATE">Create</option>
                    <option value="UPDATE">Update</option>
                    <option value="DELETE">Delete</option>
                </select>
            </div>

            <div className="border border-border rounded-xl overflow-hidden divide-y divide-border">
                {!loaded ? (
                    <div className="px-4 py-10 text-center text-sm text-foreground-tertiary">Loading…</div>
                ) : entries.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-foreground-tertiary">
                        No history yet. Mutations are recorded from now on as you work.
                    </div>
                ) : (
                    entries.map(entry => (
                        <div key={entry.id}>
                            <div className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-surface-hover/40 transition-colors">
                                <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${ACTION_STYLES[entry.action] ?? 'border-border text-foreground-muted'}`}>
                                    {entry.action}
                                </span>
                                <span className="shrink-0 text-xs text-foreground-tertiary w-28">{entry.entityType.toLowerCase().replace(/_/g, ' ')}</span>
                                <button
                                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                                    className="flex-1 min-w-0 text-left text-foreground truncate hover:text-primary transition-colors"
                                    title="Show details"
                                >
                                    {summarize(entry)}
                                </button>
                                <span className="shrink-0 text-xs text-foreground-tertiary hidden sm:inline">{entry.user ?? '—'}</span>
                                <span className="shrink-0 text-xs text-foreground-tertiary font-mono">
                                    {new Date(entry.createdAt).toLocaleString()}
                                </span>
                                {entry.undoable && (
                                    <button
                                        onClick={() => undo(entry)}
                                        disabled={busyId === entry.id}
                                        className="shrink-0 px-2.5 py-1 rounded-md border border-border text-xs text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
                                    >
                                        {busyId === entry.id ? '…' : (UNDO_LABEL[entry.action] ?? 'Undo')}
                                    </button>
                                )}
                            </div>
                            {expanded === entry.id && (
                                <div className="px-4 pb-3 grid sm:grid-cols-2 gap-3 bg-background-secondary/40">
                                    <div>
                                        <div className="text-[10px] uppercase tracking-wider text-foreground-tertiary py-1.5">Before</div>
                                        <pre className="text-xs font-mono text-foreground-secondary bg-background border border-border rounded-lg p-2 overflow-x-auto max-h-64">
                                            {entry.oldValues ? JSON.stringify(entry.oldValues, null, 2) : '—'}
                                        </pre>
                                    </div>
                                    <div>
                                        <div className="text-[10px] uppercase tracking-wider text-foreground-tertiary py-1.5">After</div>
                                        <pre className="text-xs font-mono text-foreground-secondary bg-background border border-border rounded-lg p-2 overflow-x-auto max-h-64">
                                            {entry.newValues ? JSON.stringify(entry.newValues, null, 2) : '—'}
                                        </pre>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            {total > PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm text-foreground-muted">
                    <button
                        onClick={() => load(Math.max(0, offset - PAGE_SIZE), entityType, action)}
                        disabled={offset === 0}
                        className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-40 hover:border-border-hover transition-colors"
                    >
                        Newer
                    </button>
                    <span>
                        {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
                    </span>
                    <button
                        onClick={() => load(offset + PAGE_SIZE, entityType, action)}
                        disabled={offset + PAGE_SIZE >= total}
                        className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-40 hover:border-border-hover transition-colors"
                    >
                        Older
                    </button>
                </div>
            )}
        </div>
    );
}
