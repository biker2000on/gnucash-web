'use client';

import { useState } from 'react';

interface LoginFormProps {
    mode: 'login' | 'register';
    onToggleMode: () => void;
    redirectTo?: string;
    /** Display name of the configured OIDC provider, or null when disabled. */
    oidcProvider?: string | null;
    /** Informational message (e.g. ?oidc_pending) shown above the form. */
    notice?: string | null;
    /** Error message from query params (e.g. a failed OIDC flow). */
    flowError?: string | null;
}

const LOGIN_INSTALL_PENDING_KEY = 'pwa-install-pending-after-login';
const INSTALL_STATE_CHANGE_EVENT = 'pwa-install-state-change';

export function LoginForm({ mode, onToggleMode, redirectTo = '/dashboard', oidcProvider = null, notice = null, flowError = null }: LoginFormProps) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    // Second step shown only for users who opted into two-factor authentication
    const [totpStep, setTotpStep] = useState(false);
    const [totpCode, setTotpCode] = useState('');
    const [useRecoveryCode, setUseRecoveryCode] = useState(false);

    const completeLogin = () => {
        sessionStorage.setItem(LOGIN_INSTALL_PENDING_KEY, 'true');
        window.dispatchEvent(new Event(INSTALL_STATE_CHANGE_EVENT));

        // Hard redirect to ensure the session cookie is fully committed
        // before any useEffect hooks fire API calls on the destination page
        window.location.href = redirectTo;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (mode === 'register' && password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        setLoading(true);

        try {
            const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Authentication failed');
            }

            // Users with two-factor authentication enabled get a code prompt
            // before the session is created. Everyone else proceeds as usual.
            if (data.totpRequired) {
                setTotpStep(true);
                setTotpCode('');
                setUseRecoveryCode(false);
                return;
            }

            completeLogin();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setLoading(false);
        }
    };

    const handleTotpSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);

        try {
            const res = await fetch('/api/auth/totp/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: totpCode.trim() }),
            });

            const data = await res.json();

            if (!res.ok) {
                if (data.challengeExpired) {
                    // Challenge expired or too many attempts — back to password step
                    setTotpStep(false);
                    setTotpCode('');
                    setUseRecoveryCode(false);
                    setPassword('');
                }
                throw new Error(data.error || 'Verification failed');
            }

            completeLogin();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setLoading(false);
        }
    };

    const backToLogin = () => {
        setTotpStep(false);
        setTotpCode('');
        setUseRecoveryCode(false);
        setError(null);
    };

    // Password strength indicator for registration
    const getPasswordStrength = (pass: string): { score: number; label: string; color: string } => {
        let score = 0;
        if (pass.length >= 8) score++;
        if (pass.length >= 12) score++;
        if (/[A-Z]/.test(pass)) score++;
        if (/[a-z]/.test(pass)) score++;
        if (/[0-9]/.test(pass)) score++;
        if (/[^A-Za-z0-9]/.test(pass)) score++;

        if (score <= 2) return { score, label: 'Weak', color: 'bg-rose-500' };
        if (score <= 4) return { score, label: 'Fair', color: 'bg-yellow-500' };
        return { score, label: 'Strong', color: 'bg-primary' };
    };

    const passwordStrength = getPasswordStrength(password);

    if (totpStep) {
        return (
            <div className="w-full max-w-md">
                <div className="bg-surface/50 backdrop-blur-xl border border-border rounded-2xl p-8">
                    <div className="text-center mb-8">
                        <h1 className="text-2xl font-bold text-primary">
                            GnuCash Web
                        </h1>
                        <p className="text-foreground-muted mt-2">
                            Two-factor authentication
                        </p>
                    </div>

                    {error && (
                        <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-sm">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleTotpSubmit} className="space-y-6">
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
                                {useRecoveryCode ? 'Recovery code' : 'Authentication code'}
                            </label>
                            <input
                                key={useRecoveryCode ? 'recovery' : 'totp'}
                                type="text"
                                inputMode={useRecoveryCode ? 'text' : 'numeric'}
                                autoComplete="one-time-code"
                                autoFocus
                                value={totpCode}
                                onChange={e =>
                                    setTotpCode(
                                        useRecoveryCode
                                            ? e.target.value
                                            : e.target.value.replace(/\D/g, '').slice(0, 6)
                                    )
                                }
                                required
                                maxLength={useRecoveryCode ? 16 : 6}
                                className="w-full bg-input-bg border border-input-border rounded-lg px-4 py-3 text-foreground text-center text-xl tracking-[0.3em] font-mono focus:outline-none focus:border-primary/50 transition-colors"
                                placeholder={useRecoveryCode ? 'xxxx-xxxx' : '000000'}
                            />
                            <p className="mt-2 text-xs text-foreground-muted">
                                {useRecoveryCode
                                    ? 'Enter one of the recovery codes you saved when enabling two-factor authentication. Each code works once.'
                                    : 'Enter the 6-digit code from your authenticator app.'}
                            </p>
                        </div>

                        <button
                            type="submit"
                            disabled={loading || totpCode.trim().length === 0}
                            className="w-full py-3 bg-primary hover:bg-primary-hover disabled:bg-foreground-muted text-primary-foreground font-medium rounded-lg transition-all"
                        >
                            {loading ? (
                                <span className="flex items-center justify-center gap-2">
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Verifying...
                                </span>
                            ) : (
                                'Verify'
                            )}
                        </button>
                    </form>

                    <div className="mt-6 flex items-center justify-between text-sm">
                        <button
                            onClick={backToLogin}
                            className="text-foreground-secondary hover:text-primary-hover transition-colors"
                        >
                            Back to login
                        </button>
                        <button
                            onClick={() => {
                                setUseRecoveryCode(!useRecoveryCode);
                                setTotpCode('');
                                setError(null);
                            }}
                            className="text-foreground-secondary hover:text-primary-hover transition-colors"
                        >
                            {useRecoveryCode ? 'Use authenticator code' : 'Use a recovery code'}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full max-w-md">
            <div className="bg-surface/50 backdrop-blur-xl border border-border rounded-2xl p-8">
                <div className="text-center mb-8">
                    <h1 className="text-2xl font-bold text-primary">
                        GnuCash Web
                    </h1>
                    <p className="text-foreground-muted mt-2">
                        {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
                    </p>
                </div>

                {notice && (
                    <div className="mb-6 p-4 bg-primary/10 border border-primary/30 rounded-lg text-primary text-sm">
                        {notice}
                    </div>
                )}

                {(error || flowError) && (
                    <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-sm">
                        {error || flowError}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
                            Username
                        </label>
                        <input
                            type="text"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            required
                            minLength={3}
                            className="w-full bg-input-bg border border-input-border rounded-lg px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-colors"
                            placeholder="Enter username"
                        />
                    </div>

                    <div>
                        <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
                            Password
                        </label>
                        <input
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            required
                            minLength={8}
                            className="w-full bg-input-bg border border-input-border rounded-lg px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-colors"
                            placeholder="Enter password"
                        />
                        {mode === 'register' && password && (
                            <div className="mt-2">
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 h-1 bg-surface-elevated rounded overflow-hidden">
                                        <div
                                            className={`h-full ${passwordStrength.color} transition-all`}
                                            style={{ width: `${(passwordStrength.score / 6) * 100}%` }}
                                        />
                                    </div>
                                    <span className="text-xs text-foreground-muted">{passwordStrength.label}</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {mode === 'register' && (
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
                                Confirm Password
                            </label>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={e => setConfirmPassword(e.target.value)}
                                required
                                className="w-full bg-input-bg border border-input-border rounded-lg px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-colors"
                                placeholder="Confirm password"
                            />
                            {confirmPassword && password !== confirmPassword && (
                                <p className="mt-1 text-xs text-rose-400">Passwords do not match</p>
                            )}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading || (mode === 'register' && password !== confirmPassword)}
                        className="w-full py-3 bg-primary hover:bg-primary-hover disabled:bg-foreground-muted text-primary-foreground font-medium rounded-lg transition-all"
                    >
                        {loading ? (
                            <span className="flex items-center justify-center gap-2">
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                {mode === 'login' ? 'Signing in...' : 'Creating account...'}
                            </span>
                        ) : (
                            mode === 'login' ? 'Sign In' : 'Create Account'
                        )}
                    </button>
                </form>

                {oidcProvider && (
                    <div className="mt-6">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="flex-1 h-px bg-border" />
                            <span className="text-xs text-foreground-muted uppercase tracking-wider">or</span>
                            <div className="flex-1 h-px bg-border" />
                        </div>
                        <a
                            href={`/api/auth/oidc/login?redirect=${encodeURIComponent(redirectTo)}`}
                            className="w-full flex items-center justify-center gap-2 py-3 bg-surface-elevated hover:bg-surface-hover border border-border hover:border-border-hover text-foreground font-medium rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4 text-foreground-secondary" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                            </svg>
                            Sign in with {oidcProvider}
                        </a>
                    </div>
                )}

                <div className="mt-6 text-center">
                    <button
                        onClick={onToggleMode}
                        className="text-sm text-foreground-secondary hover:text-primary-hover transition-colors"
                    >
                        {mode === 'login'
                            ? "Don't have an account? Sign up"
                            : 'Already have an account? Sign in'
                        }
                    </button>
                </div>
            </div>
        </div>
    );
}
