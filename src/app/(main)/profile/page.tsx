'use client';

import { useState, useEffect } from 'react';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { BalanceReversal } from '@/lib/format';

interface User {
    id: number;
    username: string;
}

const BALANCE_REVERSAL_OPTIONS: { value: BalanceReversal; label: string; description: string }[] = [
    {
        value: 'none',
        label: 'None (Raw Values)',
        description: 'Show raw GnuCash accounting values. Income and liabilities appear negative.',
    },
    {
        value: 'credit',
        label: 'Credit Accounts',
        description: 'Reverse credit-balance accounts (Income, Liability, Equity). Income and liabilities appear positive.',
    },
    {
        value: 'income_expense',
        label: 'Income & Expense',
        description: 'Reverse both Income and Expense accounts. Both appear as positive values.',
    },
];

export default function ProfilePage() {
    const { balanceReversal, setBalanceReversal, loading: prefsLoading } = useUserPreferences();
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

    const handleBalanceReversalChange = async (value: BalanceReversal) => {
        setSaving(true);
        setSaveMessage(null);

        try {
            await setBalanceReversal(value);
            setSaveMessage({ type: 'success', text: 'Preference saved successfully' });
            // Clear success message after 3 seconds
            setTimeout(() => setSaveMessage(null), 3000);
        } catch (error) {
            setSaveMessage({ type: 'error', text: 'Failed to save preference' });
        } finally {
            setSaving(false);
        }
    };

    if (loading || prefsLoading) {
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
                    Customize how GnuCash Web displays your financial data.
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

            {/* Balance Display Settings */}
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl">
                <h3 className="text-lg font-semibold text-foreground mb-2">Balance Display</h3>
                <p className="text-sm text-foreground-muted mb-6">
                    Choose how account balances are displayed throughout the app. This affects the Accounts page, ledgers, and reports.
                </p>

                {saveMessage && (
                    <div
                        className={`mb-4 px-4 py-2 rounded-lg text-sm ${
                            saveMessage.type === 'success'
                                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                                : 'bg-rose-500/10 border border-rose-500/30 text-rose-400'
                        }`}
                    >
                        {saveMessage.text}
                    </div>
                )}

                <div className="space-y-3">
                    {BALANCE_REVERSAL_OPTIONS.map((option) => (
                        <label
                            key={option.value}
                            className={`block p-4 rounded-xl border cursor-pointer transition-all ${
                                balanceReversal === option.value
                                    ? 'bg-emerald-500/10 border-emerald-500/50'
                                    : 'bg-surface/50 border-border hover:border-border-hover'
                            }`}
                        >
                            <div className="flex items-start gap-3">
                                <input
                                    type="radio"
                                    name="balanceReversal"
                                    value={option.value}
                                    checked={balanceReversal === option.value}
                                    onChange={() => handleBalanceReversalChange(option.value)}
                                    disabled={saving}
                                    className="mt-1 w-4 h-4 text-emerald-500 bg-background-tertiary border-border-hover focus:ring-emerald-500/50"
                                />
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium text-foreground">{option.label}</span>
                                        {saving && balanceReversal === option.value && (
                                            <div className="w-3 h-3 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                                        )}
                                    </div>
                                    <p className="text-sm text-foreground-muted mt-1">{option.description}</p>
                                </div>
                            </div>
                        </label>
                    ))}
                </div>
            </div>

            {/* Help Section */}
            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl">
                <h3 className="text-lg font-semibold text-foreground mb-2">Understanding Balance Reversal</h3>
                <div className="prose prose-sm prose-invert text-foreground-secondary">
                    <p>
                        In double-entry accounting, some accounts naturally have credit balances (shown as negative in GnuCash).
                        These include:
                    </p>
                    <ul className="list-disc list-inside space-y-1 mt-2">
                        <li><strong className="text-foreground-secondary">Income</strong> - Money you earn appears negative</li>
                        <li><strong className="text-foreground-secondary">Liabilities</strong> - Debts you owe appear negative</li>
                        <li><strong className="text-foreground-secondary">Equity</strong> - Net worth appears negative</li>
                    </ul>
                    <p className="mt-4">
                        The balance reversal setting lets you display these accounts with positive values for easier reading,
                        while still maintaining proper accounting relationships.
                    </p>
                </div>
            </div>
        </div>
    );
}
