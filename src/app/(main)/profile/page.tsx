'use client';

import { useState, useEffect } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { usePWAInstall } from '@/contexts/PWAInstallContext';

interface User {
    id: number;
    username: string;
}

const THEME_OPTIONS: { value: 'light' | 'dark' | 'system'; label: string; description: string; icon: string }[] = [
    {
        value: 'light',
        label: 'Light',
        description: 'Always use light theme',
        icon: '☀️',
    },
    {
        value: 'dark',
        label: 'Dark',
        description: 'Always use dark theme',
        icon: '🌙',
    },
    {
        value: 'system',
        label: 'System',
        description: 'Match your system preference',
        icon: '💻',
    },
];

export default function ProfilePage() {
    const { theme, setTheme } = useTheme();
    const { canInstall, isInstalled, isIos, isAndroid, isMobile, promptInstall } = usePWAInstall();
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [changingPassword, setChangingPassword] = useState(false);
    const [installingApp, setInstallingApp] = useState(false);
    const [installMessage, setInstallMessage] = useState<string | null>(null);
    const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    useEffect(() => {
        async function fetchUser() {
            try {
                const res = await fetch('/api/auth/me');
                if (res.ok) {
                    const data = await res.json();
                    setUser(data.user);
                }
            } catch {
                // Not logged in
            } finally {
                setLoading(false);
            }
        }
        fetchUser();
    }, []);

    const handlePasswordChange = async (e: React.FormEvent) => {
        e.preventDefault();
        setPasswordMessage(null);

        if (newPassword !== confirmPassword) {
            setPasswordMessage({ type: 'error', text: 'New passwords do not match' });
            return;
        }

        if (newPassword.length < 8) {
            setPasswordMessage({ type: 'error', text: 'New password must be at least 8 characters' });
            return;
        }

        setChangingPassword(true);
        try {
            const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword }),
            });

            const data = await res.json();

            if (!res.ok) {
                setPasswordMessage({ type: 'error', text: data.error || 'Failed to change password' });
                return;
            }

            setPasswordMessage({ type: 'success', text: 'Password changed successfully' });
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
            setTimeout(() => setPasswordMessage(null), 5000);
        } catch {
            setPasswordMessage({ type: 'error', text: 'Failed to change password' });
        } finally {
            setChangingPassword(false);
        }
    };

    const handleInstallApp = async () => {
        setInstallMessage(null);
        setInstallingApp(true);

        try {
            const result = await promptInstall();

            if (result === 'unavailable') {
                setInstallMessage('Install is not available in this browser. Use the browser menu to add the app to your home screen.');
                return;
            }

            if (result === 'dismissed') {
                setInstallMessage('Install prompt dismissed. You can try again from this page at any time.');
                return;
            }

            setInstallMessage('Install prompt opened. Once accepted, the app will appear on your device.');
        } finally {
            setInstallingApp(false);
        }
    };

    if (loading) {
        return (
            <div className="max-w-2xl mx-auto">
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-8 shadow-2xl">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading profile...</span>
                    </div>
                </div>
            </div>
        );
    }

    if (!user) {
        return (
            <div className="max-w-2xl mx-auto">
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-8 shadow-2xl text-center">
                    <p className="text-foreground-secondary">Please sign in to view your profile.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-2xl mx-auto space-y-6">
            <header>
                <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
                    Profile Settings
                    <span className="text-xs font-normal px-2 py-1 rounded bg-background-tertiary text-foreground-muted border border-border-hover uppercase tracking-tighter">
                        Preferences
                    </span>
                </h1>
                <p className="mt-2 text-foreground-muted">
                    Manage your account and appearance settings.
                </p>
            </header>

            {/* User Info Card */}
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl">
                <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center text-white text-2xl font-bold">
                        {user.username.charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <h2 className="text-xl font-semibold text-foreground">{user.username}</h2>
                        <p className="text-sm text-foreground-muted">User ID: {user.id}</p>
                    </div>
                </div>
            </div>

            {/* Theme Settings */}
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl">
                <h3 className="text-lg font-semibold text-foreground mb-2">Theme</h3>
                <p className="text-sm text-foreground-muted mb-6">
                    Choose your preferred color scheme. System mode automatically matches your device settings.
                </p>

                <div className="space-y-3">
                    {THEME_OPTIONS.map((option) => (
                        <label
                            key={option.value}
                            className={`block p-4 rounded-xl border cursor-pointer transition-all ${
                                theme === option.value
                                    ? 'bg-emerald-500/10 border-emerald-500/50'
                                    : 'bg-surface/50 border-border hover:border-border-hover'
                            }`}
                        >
                            <div className="flex items-start gap-3">
                                <input
                                    type="radio"
                                    name="theme"
                                    value={option.value}
                                    checked={theme === option.value}
                                    onChange={() => setTheme(option.value)}
                                    className="mt-1 w-4 h-4 text-emerald-500 bg-background-tertiary border-border-hover focus:ring-emerald-500/50"
                                />
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-lg">{option.icon}</span>
                                        <span className="font-medium text-foreground">{option.label}</span>
                                    </div>
                                    <p className="text-sm text-foreground-muted mt-1">{option.description}</p>
                                </div>
                            </div>
                        </label>
                    ))}
                </div>
            </div>

            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl">
                <h3 className="text-lg font-semibold text-foreground mb-2">Install App</h3>
                <p className="text-sm text-foreground-muted mb-6">
                    Install GnuCash Web on your phone or computer for a faster app-like experience. Updates are applied automatically through the service worker.
                </p>

                {installMessage && (
                    <div className="mb-4 px-4 py-3 rounded-lg text-sm bg-cyan-500/10 border border-cyan-500/30 text-cyan-300">
                        {installMessage}
                    </div>
                )}

                {isInstalled ? (
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
                        This app is already installed on this device.
                    </div>
                ) : (
                    <div className="space-y-4">
                        {canInstall && !isIos && (
                            <button
                                type="button"
                                onClick={handleInstallApp}
                                disabled={installingApp}
                                className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {installingApp && (
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                )}
                                <span>{installingApp ? 'Opening Install Prompt...' : 'Install on This Device'}</span>
                            </button>
                        )}

                        <div className="rounded-xl border border-border bg-background-tertiary/40 px-4 py-4 text-sm text-foreground-secondary space-y-2">
                            {isIos ? (
                                <>
                                    <p className="text-foreground font-medium">iPhone or iPad</p>
                                    <p>Open this site in Safari, tap Share, then choose Add to Home Screen.</p>
                                </>
                            ) : isAndroid ? (
                                <>
                                    <p className="text-foreground font-medium">Android</p>
                                    <p>Use the install button above. If it is unavailable, open the browser menu and choose Install app or Add to Home screen.</p>
                                </>
                            ) : isMobile ? (
                                <>
                                    <p className="text-foreground font-medium">Mobile browser</p>
                                    <p>Use your browser menu to add this app to your home screen if the install button is unavailable.</p>
                                </>
                            ) : (
                                <>
                                    <p className="text-foreground font-medium">Desktop</p>
                                    <p>Use the install button above. If your browser does not support it, check the address bar or browser menu for an install action.</p>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Change Password */}
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl">
                <h3 className="text-lg font-semibold text-foreground mb-2">Change Password</h3>
                <p className="text-sm text-foreground-muted mb-6">
                    Update your account password. You will need to enter your current password to confirm the change.
                </p>

                {passwordMessage && (
                    <div
                        className={`mb-4 px-4 py-2 rounded-lg text-sm ${
                            passwordMessage.type === 'success'
                                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                                : 'bg-rose-500/10 border border-rose-500/30 text-rose-400'
                        }`}
                    >
                        {passwordMessage.text}
                    </div>
                )}

                <form onSubmit={handlePasswordChange} className="space-y-4">
                    <div>
                        <label className="block text-sm text-foreground-secondary mb-1">Current Password</label>
                        <input
                            type="password"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            required
                            className="w-full bg-background-tertiary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-emerald-500/50"
                        />
                    </div>
                    <div>
                        <label className="block text-sm text-foreground-secondary mb-1">New Password</label>
                        <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            required
                            minLength={8}
                            className="w-full bg-background-tertiary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-emerald-500/50"
                        />
                    </div>
                    <div>
                        <label className="block text-sm text-foreground-secondary mb-1">Confirm New Password</label>
                        <input
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            required
                            minLength={8}
                            className="w-full bg-background-tertiary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-emerald-500/50"
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {changingPassword && (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        )}
                        <span>{changingPassword ? 'Changing Password...' : 'Change Password'}</span>
                    </button>
                </form>
            </div>
        </div>
    );
}
