'use client';

/**
 * Two-factor authentication (TOTP) settings section.
 *
 * Fully self-contained: talks to /api/auth/totp/* and can be mounted
 * anywhere inside an authenticated page. 2FA is strictly optional —
 * the copy and flows make that explicit.
 */

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';

interface TotpStatus {
    enabled: boolean;
    pending: boolean;
    enabledAt: string | null;
    recoveryCodesRemaining: number;
}

type View = 'idle' | 'enroll' | 'disable' | 'regenerate';

export function TwoFactorSection() {
    const { success, error: toastError } = useToast();

    const [status, setStatus] = useState<TotpStatus | null>(null);
    const [view, setView] = useState<View>('idle');
    const [busy, setBusy] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);

    // Enrollment state
    const [secret, setSecret] = useState<string | null>(null);
    const [uri, setUri] = useState<string | null>(null);
    const [confirmCode, setConfirmCode] = useState('');

    // Recovery codes are shown exactly once, right after confirm/regenerate
    const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

    // Code input for disable / regenerate
    const [actionCode, setActionCode] = useState('');

    const loadStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/auth/totp/status');
            if (!res.ok) throw new Error();
            setStatus(await res.json());
        } catch {
            setStatus(null);
            toastError('Failed to load two-factor authentication status');
        }
    }, [toastError]);

    useEffect(() => {
        void loadStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const copyText = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            success(`${label} copied to clipboard`);
        } catch {
            toastError('Copy failed — select and copy manually');
        }
    };

    const downloadCodes = (codes: string[]) => {
        const content = [
            'GnuCash Web — two-factor authentication recovery codes',
            `Generated: ${new Date().toISOString()}`,
            '',
            'Each code can be used once in place of an authenticator code.',
            '',
            ...codes,
            '',
        ].join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'gnucash-web-recovery-codes.txt';
        a.click();
        URL.revokeObjectURL(url);
    };

    const beginEnroll = async () => {
        setBusy(true);
        setFormError(null);
        try {
            const res = await fetch('/api/auth/totp/begin', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to start enrollment');
            setSecret(data.secret);
            setUri(data.otpauthUri);
            setConfirmCode('');
            setView('enroll');
        } catch (err) {
            toastError(err instanceof Error ? err.message : 'Failed to start enrollment');
        } finally {
            setBusy(false);
        }
    };

    const confirmEnroll = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setFormError(null);
        try {
            const res = await fetch('/api/auth/totp/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: confirmCode.trim() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Confirmation failed');
            setRecoveryCodes(data.recoveryCodes);
            setSecret(null);
            setUri(null);
            setView('idle');
            success('Two-factor authentication enabled');
            void loadStatus();
        } catch (err) {
            setFormError(err instanceof Error ? err.message : 'Confirmation failed');
        } finally {
            setBusy(false);
        }
    };

    const cancelEnroll = async () => {
        // A pending (unconfirmed) enrollment can be discarded without a code
        setSecret(null);
        setUri(null);
        setConfirmCode('');
        setFormError(null);
        setView('idle');
        try {
            await fetch('/api/auth/totp/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: '' }),
            });
        } catch {
            // Pending secret left behind is harmless; it is never enabled
        }
        void loadStatus();
    };

    const submitDisable = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setFormError(null);
        try {
            const res = await fetch('/api/auth/totp/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: actionCode.trim() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to disable');
            setActionCode('');
            setView('idle');
            setRecoveryCodes(null);
            success('Two-factor authentication disabled');
            void loadStatus();
        } catch (err) {
            setFormError(err instanceof Error ? err.message : 'Failed to disable');
        } finally {
            setBusy(false);
        }
    };

    const submitRegenerate = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setFormError(null);
        try {
            const res = await fetch('/api/auth/totp/recovery', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: actionCode.trim() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to regenerate codes');
            setActionCode('');
            setView('idle');
            setRecoveryCodes(data.recoveryCodes);
            success('New recovery codes generated — previous codes no longer work');
            void loadStatus();
        } catch (err) {
            setFormError(err instanceof Error ? err.message : 'Failed to regenerate codes');
        } finally {
            setBusy(false);
        }
    };

    const codeInput = (value: string, onChange: (v: string) => void, allowRecovery: boolean) => (
        <input
            type="text"
            inputMode={allowRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            value={value}
            onChange={e => onChange(allowRecovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))}
            required
            maxLength={allowRecovery ? 16 : 6}
            placeholder={allowRecovery ? '000000 or xxxx-xxxx' : '000000'}
            className="w-40 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50 transition-colors"
        />
    );

    return (
        <div className="bg-surface border border-border rounded-xl">
            <div className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-baseline gap-3 flex-wrap min-w-0">
                    <span className="text-sm font-semibold text-foreground">Two-Factor Authentication</span>
                    {status && (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                            status.enabled
                                ? 'bg-primary/10 text-primary border border-primary/30'
                                : 'bg-surface-hover text-foreground-muted border border-border'
                        }`}>
                            {status.enabled ? 'Enabled' : 'Off'}
                        </span>
                    )}
                </div>
            </div>

            <div className="px-4 pb-4 border-t border-border pt-3 space-y-4">
                <p className="text-sm text-foreground-muted">
                    Add an optional second step to password sign-in using a time-based code from an
                    authenticator app (Aegis, Google Authenticator, 1Password, …). This is entirely
                    optional — nothing changes unless you turn it on, and single sign-on logins are
                    unaffected.
                </p>

                {!status && (
                    <div className="text-sm text-foreground-muted">Loading…</div>
                )}

                {/* ---- Recovery codes, shown exactly once ---- */}
                {recoveryCodes && (
                    <div className="p-4 bg-warning/10 border border-warning/30 rounded-lg space-y-3">
                        <div className="text-sm font-medium text-foreground">
                            Save your recovery codes now — they will not be shown again
                        </div>
                        <p className="text-xs text-foreground-muted">
                            If you lose access to your authenticator app, each of these codes can be used
                            once to sign in.
                        </p>
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono text-sm text-foreground">
                            {recoveryCodes.map(code => (
                                <span key={code} className="bg-background border border-border rounded px-2 py-1 text-center">
                                    {code}
                                </span>
                            ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={() => void copyText(recoveryCodes.join('\n'), 'Recovery codes')}
                                className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-hover border border-border rounded-lg text-foreground transition-colors"
                            >
                                Copy all
                            </button>
                            <button
                                type="button"
                                onClick={() => downloadCodes(recoveryCodes)}
                                className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-hover border border-border rounded-lg text-foreground transition-colors"
                            >
                                Download .txt
                            </button>
                            <button
                                type="button"
                                onClick={() => setRecoveryCodes(null)}
                                className="px-3 py-1.5 text-xs bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                            >
                                I&apos;ve saved these
                            </button>
                        </div>
                    </div>
                )}

                {/* ---- Not enabled: offer opt-in ---- */}
                {status && !status.enabled && view === 'idle' && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void beginEnroll()}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:opacity-60 text-primary-foreground font-medium rounded-lg transition-colors"
                    >
                        Enable two-factor authentication
                    </button>
                )}

                {/* ---- Enrollment flow ---- */}
                {view === 'enroll' && secret && uri && (
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <div className="text-sm font-medium text-foreground">1. Add to your authenticator app</div>
                            <p className="text-xs text-foreground-muted">
                                Scan or enter manually in your authenticator app. The secret and setup link
                                below contain the same key.
                            </p>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground break-all">
                                    {secret.replace(/(.{4})/g, '$1 ').trim()}
                                </code>
                                <button
                                    type="button"
                                    onClick={() => void copyText(secret, 'Secret')}
                                    className="px-3 py-2 text-xs bg-surface-elevated hover:bg-surface-hover border border-border rounded-lg text-foreground transition-colors shrink-0"
                                >
                                    Copy
                                </button>
                            </div>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground-secondary break-all">
                                    {uri}
                                </code>
                                <button
                                    type="button"
                                    onClick={() => void copyText(uri, 'Setup link')}
                                    className="px-3 py-2 text-xs bg-surface-elevated hover:bg-surface-hover border border-border rounded-lg text-foreground transition-colors shrink-0"
                                >
                                    Copy
                                </button>
                            </div>
                        </div>

                        <form onSubmit={confirmEnroll} className="space-y-2">
                            <div className="text-sm font-medium text-foreground">2. Enter the 6-digit code it shows</div>
                            {formError && <p className="text-xs text-rose-400">{formError}</p>}
                            <div className="flex items-center gap-2">
                                {codeInput(confirmCode, setConfirmCode, false)}
                                <button
                                    type="submit"
                                    disabled={busy || confirmCode.length !== 6}
                                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:opacity-60 text-primary-foreground font-medium rounded-lg transition-colors"
                                >
                                    {busy ? 'Verifying…' : 'Turn on'}
                                </button>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void cancelEnroll()}
                                    className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </form>
                    </div>
                )}

                {/* ---- Enabled: status + manage ---- */}
                {status?.enabled && view === 'idle' && (
                    <div className="space-y-3">
                        <div className="text-sm text-foreground-secondary">
                            Enabled{status.enabledAt ? ` on ${new Date(status.enabledAt).toLocaleDateString()}` : ''} ·{' '}
                            {status.recoveryCodesRemaining} recovery {status.recoveryCodesRemaining === 1 ? 'code' : 'codes'} remaining
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={() => { setView('regenerate'); setActionCode(''); setFormError(null); }}
                                className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-hover border border-border rounded-lg text-foreground transition-colors"
                            >
                                Regenerate recovery codes
                            </button>
                            <button
                                type="button"
                                onClick={() => { setView('disable'); setActionCode(''); setFormError(null); }}
                                className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-hover border border-rose-500/40 rounded-lg text-rose-400 transition-colors"
                            >
                                Disable
                            </button>
                        </div>
                    </div>
                )}

                {/* ---- Disable / regenerate confirmation forms ---- */}
                {(view === 'disable' || view === 'regenerate') && (
                    <form onSubmit={view === 'disable' ? submitDisable : submitRegenerate} className="space-y-2">
                        <div className="text-sm font-medium text-foreground">
                            {view === 'disable'
                                ? 'Disable two-factor authentication'
                                : 'Regenerate recovery codes'}
                        </div>
                        <p className="text-xs text-foreground-muted">
                            {view === 'disable'
                                ? 'Enter a current authenticator code (or an unused recovery code) to confirm. Password-only sign-in will be restored.'
                                : 'Enter a current authenticator code (or an unused recovery code). All previous recovery codes stop working.'}
                        </p>
                        {formError && <p className="text-xs text-rose-400">{formError}</p>}
                        <div className="flex items-center gap-2">
                            {codeInput(actionCode, setActionCode, true)}
                            <button
                                type="submit"
                                disabled={busy || actionCode.trim().length === 0}
                                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-60 ${
                                    view === 'disable'
                                        ? 'bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-400'
                                        : 'bg-primary hover:bg-primary-hover text-primary-foreground'
                                }`}
                            >
                                {busy ? 'Working…' : view === 'disable' ? 'Disable' : 'Regenerate'}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => { setView('idle'); setActionCode(''); setFormError(null); }}
                                className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
