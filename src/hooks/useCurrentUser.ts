'use client';

import { useState, useEffect } from 'react';

export interface CurrentUser {
    id: number;
    username: string;
    email: string | null;
    displayName: string | null;
    authMethod: string;
    hasPassword: boolean;
    oidcLinked: boolean;
    oidcProvider: string | null;
    role: 'readonly' | 'edit' | 'admin' | null;
}

interface CurrentUserState {
    user: CurrentUser | null;
    loading: boolean;
    /** True only when the role is known to be readonly. */
    isReadonly: boolean;
}

// Simple module-level cache so many components can call the hook without
// each issuing a network request.
let cachedUser: CurrentUser | null = null;
let inflight: Promise<CurrentUser | null> | null = null;

async function fetchCurrentUser(): Promise<CurrentUser | null> {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return null;
        const data = await res.json();
        return data.user ?? null;
    } catch {
        return null;
    }
}

/**
 * Current user + role for the active book. Used to gate mutating UI for
 * readonly users (server-side checks remain the source of truth).
 */
export function useCurrentUser(): CurrentUserState {
    const [user, setUser] = useState<CurrentUser | null>(cachedUser);
    const [loading, setLoading] = useState(cachedUser === null);

    useEffect(() => {
        if (cachedUser) return;
        let cancelled = false;
        if (!inflight) {
            inflight = fetchCurrentUser().then((u) => {
                cachedUser = u;
                inflight = null;
                return u;
            });
        }
        inflight.then((u) => {
            if (!cancelled) {
                setUser(u);
                setLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);

    return {
        user,
        loading,
        isReadonly: user?.role === 'readonly',
    };
}

export const READONLY_TOOLTIP = 'Read-only access';
