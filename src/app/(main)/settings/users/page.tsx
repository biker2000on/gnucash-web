'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useBooks } from '@/contexts/BookContext';

interface BookUser {
    userId: number;
    username: string;
    role: string;
    grantedAt: string;
}

interface Invitation {
    id: number;
    code: string;
    role: string;
    createdAt: string;
    expiresAt: string;
    useCount: number;
    maxUses: number;
    isRevoked: boolean;
    isExpired: boolean;
    createdBy: string;
}

const EXPIRY_OPTIONS = [
    { value: 24, label: '24 hours' },
    { value: 168, label: '7 days' },
    { value: 720, label: '30 days' },
    { value: 8760, label: '1 year' },
];

const MAX_USES_OPTIONS = [
    { value: 1, label: '1 use' },
    { value: 5, label: '5 uses' },
    { value: 25, label: '25 uses' },
    { value: 1000, label: 'Unlimited' },
];

export default function UsersPage() {
    const { success, error: showError } = useToast();
    const { activeBookGuid } = useBooks();

    const [users, setUsers] = useState<BookUser[]>([]);
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [userRole, setUserRole] = useState<string | null>(null);

    // Create invitation form state
    const [inviteRole, setInviteRole] = useState<'readonly' | 'edit'>('readonly');
    const [inviteExpiry, setInviteExpiry] = useState(168);
    const [inviteMaxUses, setInviteMaxUses] = useState(1);

    const loadData = useCallback(async () => {
        if (!activeBookGuid) return;
        try {
            // Load current users for this book
            const usersRes = await fetch(`/api/books/${activeBookGuid}/invitations`);
            if (usersRes.status === 403) {
                setUserRole('non-admin');
                setLoading(false);
                return;
            }
            if (usersRes.ok) {
                setUserRole('admin');
                const invData = await usersRes.json();
                setInvitations(invData);
            }

            // Load book users (permissions)
            const permRes = await fetch(`/api/books/${activeBookGuid}?includeUsers=true`);
            if (permRes.ok) {
                const data = await permRes.json();
                if (data.users) {
                    setUsers(data.users);
                }
            }
        } catch (err) {
            console.error('Failed to load user data:', err);
        } finally {
            setLoading(false);
        }
    }, [activeBookGuid]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const handleCreateInvitation = async () => {
        if (!activeBookGuid) return;
        setCreating(true);
        try {
            const res = await fetch(`/api/books/${activeBookGuid}/invitations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role: inviteRole,
                    expiresInHours: inviteExpiry,
                    maxUses: inviteMaxUses,
                }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to create invitation');
            }
            const data = await res.json();
            success('Invitation created');

            // Copy link to clipboard
            const link = `${window.location.origin}${data.link}`;
            await navigator.clipboard.writeText(link);
            success('Invitation link copied to clipboard');

            await loadData();
        } catch (err) {
            showError(err instanceof Error ? err.message : 'Failed to create invitation');
        } finally {
            setCreating(false);
        }
    };

    const handleCopyLink = async (code: string) => {
        const link = `${window.location.origin}/invite/${code}`;
        await navigator.clipboard.writeText(link);
        success('Link copied to clipboard');
    };

    const handleRevoke = async (code: string) => {
        try {
            const res = await fetch(`/api/invitations/${code}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to revoke');
            }
            success('Invitation revoked');
            await loadData();
        } catch (err) {
            showError(err instanceof Error ? err.message : 'Failed to revoke invitation');
        }
    };

    if (loading) {
        return (
            <div className="max-w-3xl mx-auto">
                <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading user management...</span>
                </div>
            </div>
        );
    }

    if (userRole === 'non-admin') {
        return (
            <div className="max-w-3xl mx-auto">
                <h1 className="text-2xl font-bold text-foreground mb-4">User Management</h1>
                <div className="bg-surface rounded-xl border border-border p-6">
                    <p className="text-foreground-muted">You need admin access to manage users and invitations.</p>
                </div>
            </div>
        );
    }

    const activeInvitations = invitations.filter(i => !i.isRevoked && !i.isExpired && i.useCount < i.maxUses);
    const pastInvitations = invitations.filter(i => i.isRevoked || i.isExpired || i.useCount >= i.maxUses);

    return (
        <div className="max-w-3xl mx-auto space-y-6">
            <h1 className="text-2xl font-bold text-foreground">User Management</h1>

            {/* Current Users */}
            {users.length > 0 && (
                <div className="bg-surface rounded-xl border border-border p-6">
                    <h2 className="text-lg font-semibold text-foreground mb-4">Current Users</h2>
                    <div className="space-y-2">
                        {users.map((u) => (
                            <div key={u.userId} className="flex items-center justify-between py-2 px-3 bg-background-tertiary rounded-lg">
                                <span className="text-sm font-medium text-foreground">{u.username}</span>
                                <span className={`text-xs px-2 py-0.5 rounded-full ${
                                    u.role === 'admin' ? 'bg-amber-500/20 text-amber-400' :
                                    u.role === 'edit' ? 'bg-cyan-500/20 text-cyan-400' :
                                    'bg-gray-500/20 text-gray-400'
                                }`}>
                                    {u.role}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Create Invitation */}
            <div className="bg-surface rounded-xl border border-border p-6">
                <h2 className="text-lg font-semibold text-foreground mb-4">Create Invitation</h2>
                <div className="space-y-4">
                    <p className="text-sm text-foreground-muted">
                        Generate an invitation link to share with others. They will need to create an account to accept.
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="space-y-1">
                            <label className="block text-sm text-foreground-secondary">Role</label>
                            <select
                                value={inviteRole}
                                onChange={(e) => setInviteRole(e.target.value as 'readonly' | 'edit')}
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                            >
                                <option value="readonly">Read Only</option>
                                <option value="edit">Edit</option>
                            </select>
                        </div>

                        <div className="space-y-1">
                            <label className="block text-sm text-foreground-secondary">Expires</label>
                            <select
                                value={inviteExpiry}
                                onChange={(e) => setInviteExpiry(Number(e.target.value))}
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                            >
                                {EXPIRY_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </div>

                        <div className="space-y-1">
                            <label className="block text-sm text-foreground-secondary">Max Uses</label>
                            <select
                                value={inviteMaxUses}
                                onChange={(e) => setInviteMaxUses(Number(e.target.value))}
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                            >
                                {MAX_USES_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <button
                        onClick={handleCreateInvitation}
                        disabled={creating}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {creating && (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        )}
                        <span>{creating ? 'Creating...' : 'Create Invitation Link'}</span>
                    </button>
                </div>
            </div>

            {/* Active Invitations */}
            {activeInvitations.length > 0 && (
                <div className="bg-surface rounded-xl border border-border p-6">
                    <h2 className="text-lg font-semibold text-foreground mb-4">Active Invitations</h2>
                    <div className="space-y-3">
                        {activeInvitations.map((inv) => (
                            <div key={inv.id} className="flex items-center justify-between py-3 px-4 bg-background-tertiary rounded-lg">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <code className="text-xs text-foreground-muted font-mono">
                                            {inv.code.slice(0, 12)}...
                                        </code>
                                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                                            inv.role === 'edit' ? 'bg-cyan-500/20 text-cyan-400' :
                                            'bg-gray-500/20 text-gray-400'
                                        }`}>
                                            {inv.role}
                                        </span>
                                    </div>
                                    <p className="text-xs text-foreground-muted mt-1">
                                        {inv.useCount}/{inv.maxUses} uses
                                        {' \u00b7 '}
                                        Expires {new Date(inv.expiresAt).toLocaleDateString()}
                                    </p>
                                </div>
                                <div className="flex gap-2 ml-3">
                                    <button
                                        onClick={() => handleCopyLink(inv.code)}
                                        className="px-3 py-1.5 text-xs bg-background border border-border rounded-lg hover:border-border-hover transition-colors text-foreground-secondary"
                                    >
                                        Copy Link
                                    </button>
                                    <button
                                        onClick={() => handleRevoke(inv.code)}
                                        className="px-3 py-1.5 text-xs bg-rose-600/10 border border-rose-600/30 rounded-lg hover:bg-rose-600/20 transition-colors text-rose-400"
                                    >
                                        Revoke
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Past Invitations */}
            {pastInvitations.length > 0 && (
                <div className="bg-surface rounded-xl border border-border p-6">
                    <h2 className="text-lg font-semibold text-foreground mb-4">Past Invitations</h2>
                    <div className="space-y-2">
                        {pastInvitations.map((inv) => (
                            <div key={inv.id} className="flex items-center justify-between py-2 px-3 bg-background-tertiary rounded-lg opacity-60">
                                <div>
                                    <code className="text-xs text-foreground-muted font-mono">
                                        {inv.code.slice(0, 12)}...
                                    </code>
                                    <span className="text-xs text-foreground-muted ml-2">
                                        {inv.isRevoked ? 'Revoked' : inv.isExpired ? 'Expired' : 'Used up'}
                                    </span>
                                </div>
                                <span className="text-xs text-foreground-muted">
                                    {inv.useCount}/{inv.maxUses} uses
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
