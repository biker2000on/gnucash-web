'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface User {
    id: number;
    username: string;
}

export function UserMenu() {
    const router = useRouter();
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Fetch current user
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

    // Close menu on outside click
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleLogout = async () => {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
            setUser(null);
            router.push('/login');
            router.refresh();
        } catch (err) {
            console.error('Logout error:', err);
        }
    };

    if (loading) {
        return (
            <div className="w-8 h-8 rounded-full bg-neutral-800 animate-pulse" />
        );
    }

    if (!user) {
        return (
            <Link
                href="/login"
                className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
            >
                Sign In
            </Link>
        );
    }

    return (
        <div className="relative" ref={menuRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-neutral-800 transition-colors"
            >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center text-white font-medium">
                    {user.username.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm text-neutral-300 hidden sm:block">{user.username}</span>
                <svg className={`w-4 h-4 text-neutral-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-48 bg-neutral-900 border border-neutral-800 rounded-lg shadow-lg overflow-hidden z-50">
                    <div className="px-4 py-3 border-b border-neutral-800">
                        <p className="text-sm text-neutral-100 font-medium">{user.username}</p>
                        <p className="text-xs text-neutral-500">Logged in</p>
                    </div>
                    <div className="py-1">
                        <Link
                            href="/profile"
                            onClick={() => setIsOpen(false)}
                            className="w-full px-4 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-800 transition-colors flex items-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            Profile Settings
                        </Link>
                        <button
                            onClick={handleLogout}
                            className="w-full px-4 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-800 transition-colors flex items-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                            </svg>
                            Sign Out
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
