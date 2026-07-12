'use client';

import { useCallback, useEffect, useState } from 'react';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useToast } from '@/contexts/ToastContext';

interface ApiToken {
    id: number;
    name: string;
    prefix: string;
    role: 'readonly' | 'edit';
    bookGuid: string | null;
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
}

const EXPIRY_OPTIONS: Array<{ key: string; label: string; days: number | null }> = [
    { key: '30d', label: '30 days', days: 30 },
    { key: '90d', label: '90 days', days: 90 },
    { key: '1y', label: '1 year', days: 365 },
    { key: 'never', label: 'No expiration', days: null },
];

function formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString();
}

export function ApiTokensSection() {
    const { success, error } = useToast();
    const [tokens, setTokens] = useState<ApiToken[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);

    // Create modal state
    const [showCreate, setShowCreate] = useState(false);
    const [name, setName] = useState('');
    const [role, setRole] = useState<'readonly' | 'edit'>('readonly');
    const [expiry, setExpiry] = useState('90d');
    const [newSecret, setNewSecret] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/settings/api-tokens');
            if (!res.ok) throw new Error();
            const data = await res.json();
            setTokens(data.tokens ?? []);
        } catch {
            // silently keep old list; toast on user-initiated actions only
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const create = async () => {
        if (!name.trim()) {
            error('Give the token a name');
            return;
        }
        setBusy(true);
        try {
            const days = EXPIRY_OPTIONS.find(o => o.key === expiry)?.days ?? null;
            const expiresAt = days ? new Date(Date.now() + days * 86400_000).toISOString() : undefined;
            const res = await fetch('/api/settings/api-tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), role, expiresAt }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || 'Failed to create token');
            setNewSecret(data.secret);
            setCopied(false);
            setName('');
            success('API token created');
            void load();
        } catch (e) {
            error(e instanceof Error ? e.message : 'Failed to create token');
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (token: ApiToken) => {
        if (!window.confirm(`Revoke token "${token.name}"? API clients using it will stop working immediately.`)) {
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/settings/api-tokens/${token.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            success('Token revoked');
            setTokens(prev => prev.filter(t => t.id !== token.id));
        } catch {
            error('Failed to revoke token');
        } finally {
            setBusy(false);
        }
    };

    const copySecret = async () => {
        if (!newSecret) return;
        try {
            await navigator.clipboard.writeText(newSecret);
            setCopied(true);
        } catch {
            error('Copy failed — select and copy manually');
        }
    };

    const closeCreate = () => {
        setShowCreate(false);
        setNewSecret(null);
        setCopied(false);
    };

    return (
        <CollapsibleConfigSection
            title="API Tokens"
            summary={tokens.length > 0 ? `${tokens.length} active token${tokens.length === 1 ? '' : 's'}` : 'None'}
            configured={tokens.length > 0}
            storageKey="settings.apiTokensOpen"
        >
            <div className="space-y-4">
                <p className="text-sm text-foreground-muted">
                    Personal access tokens let scripts and integrations call the API with
                    <code className="mx-1 px-1 py-0.5 bg-surface-hover rounded text-xs">Authorization: Bearer gcw_...</code>
                    Tokens are limited to read-only or edit access and can never exceed your own role.
                    See <code className="px-1 py-0.5 bg-surface-hover rounded text-xs">docs/api-tokens.md</code> for usage.
                </p>

                {loaded && tokens.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-foreground-muted border-b border-border">
                                    <th className="py-2 pr-3 font-medium">Name</th>
                                    <th className="py-2 pr-3 font-medium">Token</th>
                                    <th className="py-2 pr-3 font-medium">Role</th>
                                    <th className="py-2 pr-3 font-medium">Expires</th>
                                    <th className="py-2 pr-3 font-medium">Last used</th>
                                    <th className="py-2 font-medium" />
                                </tr>
                            </thead>
                            <tbody>
                                {tokens.map(t => (
                                    <tr key={t.id} className="border-b border-border last:border-0">
                                        <td className="py-2 pr-3 text-foreground">{t.name}</td>
                                        <td className="py-2 pr-3 font-mono text-xs text-foreground-secondary">{t.prefix}…</td>
                                        <td className="py-2 pr-3">
                                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${
                                                t.role === 'edit'
                                                    ? 'bg-warning/10 text-warning'
                                                    : 'bg-surface-hover text-foreground-secondary'
                                            }`}>
                                                {t.role}
                                            </span>
                                        </td>
                                        <td className="py-2 pr-3 text-foreground-secondary">{t.expiresAt ? formatDate(t.expiresAt) : 'Never'}</td>
                                        <td className="py-2 pr-3 text-foreground-secondary">{formatDate(t.lastUsedAt)}</td>
                                        <td className="py-2 text-right">
                                            <button
                                                type="button"
                                                onClick={() => void revoke(t)}
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

                {loaded && tokens.length === 0 && (
                    <p className="text-sm text-foreground-secondary">No API tokens yet.</p>
                )}

                <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    disabled={busy}
                    className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
                >
                    Create token
                </button>

                {showCreate && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
                        <div className="bg-surface border border-border rounded-xl w-full max-w-md p-5 space-y-4">
                            {!newSecret ? (
                                <>
                                    <h3 className="text-base font-semibold text-foreground">Create API token</h3>
                                    <label className="block space-y-1">
                                        <span className="text-sm text-foreground">Name</span>
                                        <input
                                            type="text"
                                            value={name}
                                            maxLength={100}
                                            onChange={e => setName(e.target.value)}
                                            placeholder="e.g. Home Assistant"
                                            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                                        />
                                    </label>
                                    <label className="block space-y-1">
                                        <span className="text-sm text-foreground">Access</span>
                                        <select
                                            value={role}
                                            onChange={e => setRole(e.target.value as 'readonly' | 'edit')}
                                            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                                        >
                                            <option value="readonly">Read-only</option>
                                            <option value="edit">Read and write</option>
                                        </select>
                                    </label>
                                    <label className="block space-y-1">
                                        <span className="text-sm text-foreground">Expires</span>
                                        <select
                                            value={expiry}
                                            onChange={e => setExpiry(e.target.value)}
                                            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                                        >
                                            {EXPIRY_OPTIONS.map(o => (
                                                <option key={o.key} value={o.key}>{o.label}</option>
                                            ))}
                                        </select>
                                    </label>
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
                                            disabled={busy || !name.trim()}
                                            className="px-3 py-1.5 text-sm rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
                                        >
                                            {busy ? 'Creating…' : 'Create'}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <h3 className="text-base font-semibold text-foreground">Token created</h3>
                                    <p className="text-sm text-warning">
                                        Copy this token now — you won&apos;t see it again.
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <code className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground break-all select-all">
                                            {newSecret}
                                        </code>
                                        <button
                                            type="button"
                                            onClick={() => void copySecret()}
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
