'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';

function LoginPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const redirectTo = searchParams.get('redirect') || '/accounts';
    const [mode, setMode] = useState<'login' | 'register'>('login');
    const [checking, setChecking] = useState(true);

    // Check if already logged in
    useEffect(() => {
        async function checkAuth() {
            try {
                const res = await fetch('/api/auth/me');
                if (res.ok) {
                    router.push(redirectTo);
                    return;
                }
            } catch {
                // Not logged in
            }
            setChecking(false);
        }
        checkAuth();
    }, [router, redirectTo]);

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
                redirectTo={redirectTo}
            />
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
            </div>
        }>
            <LoginPageContent />
        </Suspense>
    );
}
