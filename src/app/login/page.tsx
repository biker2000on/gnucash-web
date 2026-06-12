'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';

const OIDC_ERROR_MESSAGES: Record<string, string> = {
    oidc_state: 'Your sign-in session expired. Please try again.',
    oidc_cancelled: 'Sign-in was cancelled.',
    oidc_failed: 'Single sign-on failed. Please try again or use your password.',
    oidc_unavailable: 'Single sign-on is temporarily unavailable. Please use your password.',
    link_requires_login: 'Log in first, then link your account from the Profile page.',
};

function LoginPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const redirectTo = searchParams.get('redirect') || '/';
    const [mode, setMode] = useState<'login' | 'register'>('login');
    const [checking, setChecking] = useState(true);
    const [oidcProvider, setOidcProvider] = useState<string | null>(null);

    const oidcPending = searchParams.get('oidc_pending') !== null;
    const pendingUsername = searchParams.get('username');
    const errorParam = searchParams.get('error');

    const notice = oidcPending
        ? `An account named ${pendingUsername ? `"${pendingUsername}"` : 'with that username'} already exists. ` +
          'To protect your data, sign in with your password once, then link your single sign-on identity from the Profile page.'
        : null;
    const flowError = errorParam ? (OIDC_ERROR_MESSAGES[errorParam] || 'Sign-in failed. Please try again.') : null;

    // Check if already logged in + discover available providers
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
            try {
                const res = await fetch('/api/auth/providers');
                if (res.ok) {
                    const data = await res.json();
                    setOidcProvider(data.oidc?.name ?? null);
                }
            } catch {
                // OIDC button simply won't show
            }
            setChecking(false);
        }
        checkAuth();
    }, [router, redirectTo]);

    if (checking) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
            <LoginForm
                mode={mode}
                onToggleMode={() => setMode(mode === 'login' ? 'register' : 'login')}
                redirectTo={redirectTo}
                oidcProvider={oidcProvider}
                notice={notice}
                flowError={flowError}
            />
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
        }>
            <LoginPageContent />
        </Suspense>
    );
}
