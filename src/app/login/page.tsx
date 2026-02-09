'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';

export default function LoginPage() {
    const router = useRouter();
    const [mode, setMode] = useState<'login' | 'register'>('login');
    const [checking, setChecking] = useState(true);

    // Check if already logged in
    useEffect(() => {
        async function checkAuth() {
            try {
                const res = await fetch('/api/auth/me');
                if (res.ok) {
                    router.push('/accounts');
                    return;
                }
            } catch {
                // Not logged in
            }
            setChecking(false);
        }
        checkAuth();
    }, [router]);

    if (checking) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-background-secondary via-background to-background flex items-center justify-center p-4">
            <LoginForm
                mode={mode}
                onToggleMode={() => setMode(mode === 'login' ? 'register' : 'login')}
            />
        </div>
    );
}
