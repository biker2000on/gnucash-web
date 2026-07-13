'use client';

import { useCallback, useEffect, useState } from 'react';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useToast } from '@/contexts/ToastContext';

// Mirrors SHARE_SECTIONS in @/lib/share-links (server-only module — it pulls
// in node:crypto and prisma, so the client keeps its own copy of the list).
type ShareSection = 'balance_sheet' | 'income_statement_ytd' | 'net_worth';
const SHARE_SECTIONS: Array<{ key: ShareSection; label: string }> = [
    { key: 'balance_sheet', label: 'Balance Sheet' },
    { key: 'income_statement_ytd', label: 'Income Statement (YTD)' },
    { key: 'net_worth', label: 'Net Worth Summary' },
];

interface ShareLink {
    id: number;
    label: string;
    prefix: string;
    sections: ShareSection[];
    expiresAt: string;
    createdAt: string;
    viewCount: number;
    expired: boolean;
}

const EXPIRY_OPTIONS: Array<{ days: number; label: string }> = [
    { days: 7, label: '7 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
];

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
}

export function ShareLinksSection() {
    const { success, error } = useToast();
    const [links, setLinks] = useState<ShareLink[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);

    // Create modal state
    const [showCreate, setShowCreate] = useState(false);
    const [label, setLabel] = useState('');
    const [expiryDays, setExpiryDays] = useState(30);
    const [sections, setSections] = useState<ShareSection[]>(SHARE_SECTIONS.map(s => s.key));
    const [newUrl, setNewUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/settings/share-links');
            if (!res.ok) throw new Error();
            const data = await res.json();
            setLinks(data.links ?? []);
        } catch {
            // silently keep old list; toast on user-initiated actions only
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const toggleSection = (key: ShareSection) => {
        setSections(prev => (prev.includes(key) ? prev.filter(s => s !== key) : [...prev, key]));
    };

    const create = async () => {
        if (!label.trim()) {
            error('Give the link a label');
            return;
        }
        if (sections.length === 0) {
            error('Select at least one section');
            return;
        }
        setBusy(true);
        try {
            const res = await fetch('/api/settings/share-links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: label.trim(), expiryDays, sections }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to create share link');
            setNewUrl(`${window.location.origin}${data.url}`);
            setCopied(false);
            setLabel('');
            success('Share link created');
            void load();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Failed to create share link');
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (link: ShareLink) => {
        if (!window.confirm(`Revoke share link "${link.label}"? Anyone holding the URL loses access immediately.`)) {
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/settings/share-links/${link.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            success('Share link revoked');
            setLinks(prev => prev.filter(l => l.id !== link.id));
        } catch {
            error('Failed to revoke share link');
        } finally {
            setBusy(false);
        }
    };

    const copyUrl = async () => {
        if (!newUrl) return;
        try {
            await navigator.clipboard.writeText(newUrl);
            setCopied(true);
        } catch {
            error('Copy failed — select and copy manually');
        }
    };

    const closeCreate = () => {
        setShowCreate(false);
        setNewUrl(null);
        setCopied(false);
    };

    const active = links.filter(l => !l.expired);

    return (
        <CollapsibleConfigSection
            title="Accountant Share Links"
            summary={active.length > 0 ? `${active.length} active link${active.length === 1 ? '' : 's'}` : 'None'}
            configured={links.length > 0}
            storageKey="settings.shareLinksOpen"
        >
            <div className="space-y-4">
                <p className="text-sm text-foreground-muted">
                    Share a read-only, time-boxed report bundle with your accountant — no login
                    needed. The link renders a snapshot of the selected reports and nothing else;
                    it grants no access to the app. Creating links requires admin access.
                </p>

                {loaded && links.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-foreground-muted border-b border-border">
                                    <th className="py-2 pr-3 font-medium">Label</th>
                                    <th className="py-2 pr-3 font-medium">Link</th>
                                    <th className="py-2 pr-3 font-medium">Sections</th>
                                    <th className="py-2 pr-3 font-medium">Expires</th>
                                    <th className="py-2 pr-3 font-medium text-right">Views</th>
                                    <th className="py-2 font-medium" />
                                </tr>
                            </thead>
                            <tbody>
                                {links.map(l => (
                                    <tr key={l.id} className="border-b border-border last:border-0">
                                        <td className="py-2 pr-3 text-foreground">{l.label}</td>
                                        <td className="py-2 pr-3 font-mono text-xs text-foreground-secondary">{l.prefix}…</td>
                                        <td className="py-2 pr-3 text-xs text-foreground-secondary">
                                            {l.sections.length}/{SHARE_SECTIONS.length}
                                        </td>
                                        <td className="py-2 pr-3">
                                            {l.expired ? (
                                                <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-surface-hover text-foreground-muted">
                                                    Expired
                                                </span>
                                            ) : (
                                                <span className="text-foreground-secondary">{formatDate(l.expiresAt)}</span>
                                            )}
                                        </td>
                                        <td className="py-2 pr-3 text-right font-mono text-xs text-foreground-secondary">
                                            {l.viewCount}
                                        </td>
                                        <td className="py-2 text-right">
                                            <button
                                                type="button"
                                                onClick={() => void revoke(l)}
                                                disabled={busy}
                                                className="text-xs text-error hover:underline disabled:opacity-50"
                                            >
                                                Revoke
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {loaded && links.length === 0 && (
                    <p className="text-sm text-foreground-secondary">No share links yet.</p>
                )}

                <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    disabled={busy}
                    className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
                >
                    Create share link
                </button>

                {showCreate && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
                        <div className="bg-surface border border-border rounded-xl w-full max-w-md p-5 space-y-4">
                            {!newUrl ? (
                                <>
                                    <h3 className="text-base font-semibold text-foreground">Create share link</h3>
                                    <label className="block space-y-1">
                                        <span className="text-sm text-foreground">Label</span>
                                        <input
                                            type="text"
                                            value={label}
                                            maxLength={100}
                                            onChange={e => setLabel(e.target.value)}
                                            placeholder="e.g. 2026 tax prep — Jane CPA"
                                            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                                        />
                                    </label>
                                    <label className="block space-y-1">
                                        <span className="text-sm text-foreground">Expires after</span>
                                        <select
                                            value={expiryDays}
                                            onChange={e => setExpiryDays(parseInt(e.target.value, 10))}
                                            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                                        >
                                            {EXPIRY_OPTIONS.map(o => (
                                                <option key={o.days} value={o.days}>{o.label}</option>
                                            ))}
                                        </select>
                                    </label>
                                    <fieldset className="space-y-1.5">
                                        <legend className="text-sm text-foreground">Sections to include</legend>
                                        {SHARE_SECTIONS.map(s => (
                                            <label key={s.key} className="flex items-center gap-2 text-sm text-foreground-secondary">
                                                <input
                                                    type="checkbox"
                                                    checked={sections.includes(s.key)}
                                                    onChange={() => toggleSection(s.key)}
                                                    className="accent-[var(--primary)]"
                                                />
                                                {s.label}
                                            </label>
                                        ))}
                                    </fieldset>
                                    <div className="flex justify-end gap-2 pt-1">
                                        <button
                                            type="button"
                                            onClick={closeCreate}
                                            disabled={busy}
                                            className="px-3 py-1.5 text-sm rounded-lg border border-border text-foreground hover:bg-surface-hover"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void create()}
                                            disabled={busy || !label.trim() || sections.length === 0}
                                            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
                                        >
                                            {busy ? 'Creating…' : 'Create'}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <h3 className="text-base font-semibold text-foreground">Share link created</h3>
                                    <p className="text-sm text-warning">
                                        Copy this URL now — you won&apos;t see it again. Anyone with the URL can
                                        view the selected reports until it expires.
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <code className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground break-all select-all">
                                            {newUrl}
                                        </code>
                                        <button
                                            type="button"
                                            onClick={() => void copyUrl()}
                                            className="px-3 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-surface-hover shrink-0"
                                        >
                                            {copied ? 'Copied' : 'Copy'}
                                        </button>
                                    </div>
                                    <div className="flex justify-end pt-1">
                                        <button
                                            type="button"
                                            onClick={closeCreate}
                                            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:opacity-90"
                                        >
                                            Done
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </CollapsibleConfigSection>
    );
}
