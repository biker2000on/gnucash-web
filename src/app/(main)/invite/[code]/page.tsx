'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useToast } from '@/contexts/ToastContext';
import { useBooks } from '@/contexts/BookContext';

interface InvitationDetails {
    code: string;
    bookGuid: string;
    bookName: string;
    role: string;
    createdBy: string;
    expiresAt: string;
    usesRemaining: number;
}

export default function InviteAcceptPage() {
    const { code } = useParams<{ code: string }>();
    const router = useRouter();
    const { success, error: showError } = useToast();
    const { refreshBooks, switchBook } = useBooks();

    const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
    const [loading, setLoading] = useState(true);
    const [accepting, setAccepting] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    useEffect(() => {
        async function loadInvitation() {
            try {
                const res = await fetch(`/api/invitations/${code}`);
                if (res.status === 410) {
                    const data = await res.json();
                    setErrorMsg(data.error || 'This invitation is no longer valid.');
                    return;
                }
                if (res.status === 404) {
                    setErrorMsg('Invitation not found.');
                    return;
                }
                if (!res.ok) {
                    setErrorMsg('Failed to load invitation.');
                    return;
                }
                setInvitation(await res.json());
            } catch {
                setErrorMsg('Failed to load invitation.');
            } finally {
                setLoading(false);
            }
        }
        loadInvitation();
    }, [code]);

    const handleAccept = async () => {
        if (!invitation) return;
        setAccepting(true);
        try {
            const res = await fetch(`/api/invitations/${code}/accept`, {
                method: 'POST',
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to accept invitation');
            }

            const data = await res.json();
            success(`You now have ${data.role} access to this book`);

            // Refresh books list and switch to the new book
            await refreshBooks();
            await switchBook(data.bookGuid);
            router.push('/accounts');
        } catch (err) {
            showError(err instanceof Error ? err.message : 'Failed to accept invitation');
        } finally {
            setAccepting(false);
        }
    };

    if (loading) {
        return (
            <div className="max-w-lg mx-auto mt-20">
                <div className="flex items-center justify-center gap-3">
                    <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading invitation...</span>
                </div>
            </div>
        );
    }

    if (errorMsg) {
        return (
            <div className="max-w-lg mx-auto mt-20">
                <div className="bg-surface rounded-xl border border-border p-8 text-center">
                    <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-rose-500/10 flex items-center justify-center">
                        <svg className="w-6 h-6 text-rose-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                        </svg>
                    </div>
                    <h2 className="text-lg font-semibold text-foreground mb-2">Invitation Unavailable</h2>
                    <p className="text-foreground-muted">{errorMsg}</p>
                </div>
            </div>
        );
    }

    if (!invitation) return null;

    return (
        <div className="max-w-lg mx-auto mt-20">
            <div className="bg-surface rounded-xl border border-border p-8">
                <div className="text-center mb-6">
                    <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-emerald-500/10 flex items-center justify-center">
                        <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                        </svg>
                    </div>
                    <h2 className="text-xl font-semibold text-foreground mb-1">You&apos;ve Been Invited</h2>
                    <p className="text-foreground-muted">You&apos;ve been invited to access a financial book.</p>
                </div>

                <div className="space-y-3 mb-6">
                    <div className="flex justify-between py-2 px-3 bg-background-tertiary rounded-lg">
                        <span className="text-sm text-foreground-secondary">Book</span>
                        <span className="text-sm font-medium text-foreground">{invitation.bookName}</span>
                    </div>
                    <div className="flex justify-between py-2 px-3 bg-background-tertiary rounded-lg">
                        <span className="text-sm text-foreground-secondary">Role</span>
                        <span className={`text-sm font-medium ${
                            invitation.role === 'edit' ? 'text-cyan-400' : 'text-gray-400'
                        }`}>
                            {invitation.role === 'edit' ? 'Edit' : 'Read Only'}
                        </span>
                    </div>
                    <div className="flex justify-between py-2 px-3 bg-background-tertiary rounded-lg">
                        <span className="text-sm text-foreground-secondary">Invited by</span>
                        <span className="text-sm font-medium text-foreground">{invitation.createdBy}</span>
                    </div>
                    <div className="flex justify-between py-2 px-3 bg-background-tertiary rounded-lg">
                        <span className="text-sm text-foreground-secondary">Expires</span>
                        <span className="text-sm text-foreground-muted">
                            {new Date(invitation.expiresAt).toLocaleDateString()}
                        </span>
                    </div>
                </div>

                <button
                    onClick={handleAccept}
                    disabled={accepting}
                    className="w-full bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 disabled:opacity-50 text-white font-medium px-4 py-3 rounded-lg transition-all disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                    {accepting && (
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    )}
                    <span>{accepting ? 'Accepting...' : 'Accept Invitation'}</span>
                </button>
            </div>
        </div>
    );
}
