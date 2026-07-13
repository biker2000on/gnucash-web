'use client';

import { useCallback, useEffect, useState } from 'react';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useToast } from '@/contexts/ToastContext';

interface IngestSender {
    id: number;
    email: string;
    userId: number;
    bookGuid: string | null;
    defaultKind: 'auto' | 'receipt' | 'statement' | 'payslip';
    createdAt: string;
}

interface IngestLogEntry {
    id: number;
    fromEmail: string | null;
    subject: string | null;
    outcome: string;
    detail: string | null;
    ingestedCount: number;
    processedAt: string;
}

interface BookOption {
    guid: string;
    name: string;
}

interface IngestStatus {
    configured: boolean;
    folder: string | null;
    mailboxUser: string | null;
    senders: IngestSender[];
    log: IngestLogEntry[];
}

const KIND_OPTIONS: Array<{ value: IngestSender['defaultKind']; label: string }> = [
    { value: 'auto', label: 'Auto-detect' },
    { value: 'receipt', label: 'Receipt' },
    { value: 'statement', label: 'Statement' },
    { value: 'payslip', label: 'Payslip' },
];

function outcomeBadge(outcome: string): { color: string; label: string } {
    switch (outcome) {
        case 'ingested':
            return { color: 'bg-success', label: 'Ingested' };
        case 'skipped_sender':
            return { color: 'bg-foreground-muted', label: 'Sender not allowed' };
        case 'no_attachments':
            return { color: 'bg-foreground-muted', label: 'No attachments' };
        default:
            return { color: 'bg-error', label: 'Error' };
    }
}

export function EmailIngestSection() {
    const { success, error } = useToast();
    const [status, setStatus] = useState<IngestStatus | null>(null);
    const [books, setBooks] = useState<BookOption[]>([]);
    const [busy, setBusy] = useState(false);
    const [polling, setPolling] = useState(false);
    const [newEmail, setNewEmail] = useState('');
    const [newKind, setNewKind] = useState<IngestSender['defaultKind']>('auto');
    const [newBookGuid, setNewBookGuid] = useState('');

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/settings/email-ingest');
            if (!res.ok) throw new Error();
            setStatus(await res.json());
        } catch {
            // keep previous state
        }
    }, []);

    useEffect(() => {
        void load();
        void (async () => {
            try {
                const res = await fetch('/api/books');
                if (!res.ok) return;
                const data = await res.json();
                if (Array.isArray(data)) {
                    setBooks(data.map((b: { guid: string; name: string }) => ({ guid: b.guid, name: b.name })));
                }
            } catch {
                // book picker is optional
            }
        })();
    }, [load]);

    const addSender = async () => {
        if (!newEmail.trim()) {
            error('Sender email is required');
            return;
        }
        setBusy(true);
        try {
            const res = await fetch('/api/settings/email-ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: newEmail.trim(),
                    defaultKind: newKind,
                    bookGuid: newBookGuid || undefined,
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to add sender');
            success('Sender added to allowlist');
            setNewEmail('');
            setNewKind('auto');
            void load();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Failed to add sender');
        } finally {
            setBusy(false);
        }
    };

    const removeSender = async (sender: IngestSender) => {
        if (!window.confirm(`Remove ${sender.email} from the allowlist?`)) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/settings/email-ingest/${sender.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            success('Sender removed');
            setStatus(prev => prev
                ? { ...prev, senders: prev.senders.filter(s => s.id !== sender.id) }
                : prev);
        } catch {
            error('Failed to remove sender');
        } finally {
            setBusy(false);
        }
    };

    const pollNow = async () => {
        setPolling(true);
        try {
            const res = await fetch('/api/settings/email-ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'poll' }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Poll failed');
            if (data.enqueued) {
                success('Mailbox poll started in the background');
            } else if (data.result) {
                success(`Poll complete: ${data.result.ingested} ingested, ${data.result.skipped} skipped`);
            }
            void load();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Poll failed');
        } finally {
            setPolling(false);
        }
    };

    const configured = status?.configured === true;
    const senders = status?.senders ?? [];
    const log = status?.log ?? [];
    const bookName = (guid: string | null) =>
        guid ? (books.find(b => b.guid === guid)?.name ?? guid.slice(0, 8)) : 'Default';

    return (
        <CollapsibleConfigSection
            title="Email-in documents"
            summary={configured
                ? `${senders.length} allowed sender${senders.length === 1 ? '' : 's'}`
                : 'Not configured'}
            configured
            storageKey="settings.emailIngestOpen"
        >
            <div className="space-y-4">
                <p className="text-sm text-foreground-muted">
                    Forward receipts, statements, or payslips to a dedicated mailbox and they are
                    ingested automatically — attachments from allowlisted senders go through the
                    same pipelines as manual uploads (thumbnails, OCR, and extraction included).
                </p>

                {status && !configured && (
                    <div className="border border-border rounded-lg p-3 text-sm text-foreground-secondary space-y-1">
                        <p className="font-medium text-foreground">Mailbox not configured</p>
                        <p>
                            Set
                            <code className="mx-1 px-1 py-0.5 bg-surface-hover rounded text-xs">INGEST_IMAP_HOST</code>,
                            <code className="mx-1 px-1 py-0.5 bg-surface-hover rounded text-xs">INGEST_IMAP_USER</code>, and
                            <code className="mx-1 px-1 py-0.5 bg-surface-hover rounded text-xs">INGEST_IMAP_PASS</code>
                            (see <code className="px-1 py-0.5 bg-surface-hover rounded text-xs">.env.example</code>) and restart the app and worker.
                        </p>
                    </div>
                )}

                {configured && (
                    <div className="flex items-center gap-3 text-sm text-foreground-secondary">
                        <span className="inline-block w-2.5 h-2.5 rounded-full bg-success shrink-0" />
                        <span>
                            Watching <span className="font-mono">{status?.mailboxUser}</span>
                            {status?.folder && <> · folder <span className="font-mono">{status.folder}</span></>}
                        </span>
                        <button
                            type="button"
                            onClick={() => void pollNow()}
                            disabled={polling || busy}
                            className="ml-auto px-3 py-1.5 text-sm rounded-lg border border-border text-foreground hover:bg-surface-hover disabled:opacity-50 shrink-0"
                        >
                            {polling ? 'Polling…' : 'Poll now'}
                        </button>
                    </div>
                )}

                <div className="space-y-2">
                    <h4 className="text-sm font-medium text-foreground">Allowed senders</h4>
                    {senders.length > 0 ? (
                        <ul className="space-y-2">
                            {senders.map(sender => (
                                <li key={sender.id} className="flex items-center gap-3 border border-border rounded-lg px-3 py-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm text-foreground font-mono truncate">{sender.email}</div>
                                        <div className="text-xs text-foreground-muted">
                                            {KIND_OPTIONS.find(o => o.value === sender.defaultKind)?.label ?? sender.defaultKind}
                                            {' · '}{bookName(sender.bookGuid)}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => void removeSender(sender)}
                                        disabled={busy}
                                        className="text-xs text-error hover:underline disabled:opacity-50 shrink-0"
                                    >
                                        Remove
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-foreground-secondary">
                            No allowed senders yet — email from unknown addresses is ignored.
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            type="email"
                            value={newEmail}
                            onChange={e => setNewEmail(e.target.value)}
                            placeholder="sender@example.com"
                            className="flex-1 min-w-48 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono"
                        />
                        <select
                            value={newKind}
                            onChange={e => setNewKind(e.target.value as IngestSender['defaultKind'])}
                            className="bg-background border border-border rounded-lg px-2 py-2 text-sm text-foreground"
                        >
                            {KIND_OPTIONS.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                        </select>
                        {books.length > 1 && (
                            <select
                                value={newBookGuid}
                                onChange={e => setNewBookGuid(e.target.value)}
                                className="bg-background border border-border rounded-lg px-2 py-2 text-sm text-foreground"
                            >
                                <option value="">Active book</option>
                                {books.map(b => (
                                    <option key={b.guid} value={b.guid}>{b.name}</option>
                                ))}
                            </select>
                        )}
                        <button
                            type="button"
                            onClick={() => void addSender()}
                            disabled={busy || !newEmail.trim()}
                            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
                        >
                            {busy ? 'Adding…' : 'Add sender'}
                        </button>
                    </div>
                </div>

                {log.length > 0 && (
                    <div className="space-y-2">
                        <h4 className="text-sm font-medium text-foreground">Recent activity</h4>
                        <ul className="space-y-1.5">
                            {log.map(entry => {
                                const badge = outcomeBadge(entry.outcome);
                                return (
                                    <li key={entry.id} className="flex items-start gap-3 text-sm border border-border rounded-lg px-3 py-2">
                                        <span
                                            className={`inline-block w-2.5 h-2.5 mt-1 rounded-full shrink-0 ${badge.color}`}
                                            title={badge.label}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-foreground truncate">
                                                {entry.subject || '(no subject)'}
                                                <span className="text-foreground-muted"> — {entry.fromEmail ?? 'unknown sender'}</span>
                                            </div>
                                            <div className="text-xs text-foreground-muted truncate">
                                                {badge.label}
                                                {entry.ingestedCount > 0 && ` · ${entry.ingestedCount} document${entry.ingestedCount === 1 ? '' : 's'}`}
                                                {' · '}{new Date(entry.processedAt).toLocaleString()}
                                                {entry.detail && ` · ${entry.detail}`}
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                )}
            </div>
        </CollapsibleConfigSection>
    );
}
