'use client';

/**
 * Compact natural-language "magic" input for the Quick Add screen.
 *
 * Probes GET /api/ai/parse-transaction once to learn whether an AI provider
 * is configured — hidden entirely when it is not. When offline the input is
 * disabled with a tooltip (parsing requires connectivity), but the rest of
 * the page keeps working. On a successful parse the result is handed to the
 * parent, which prefills the existing form state for user confirmation —
 * nothing is auto-saved.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ParsedNlTransaction } from '@/lib/nl-parse';

// Cache the probe result so offline loads can still show the (disabled) input.
const AI_CONFIGURED_CACHE_KEY = 'quickAdd.aiConfigured';

interface MagicAddInputProps {
    isOnline: boolean;
    onParsed: (parsed: ParsedNlTransaction) => void;
}

export function MagicAddInput({ isOnline, onParsed }: MagicAddInputProps) {
    const [configured, setConfigured] = useState<boolean | null>(null);
    const [text, setText] = useState('');
    const [parsing, setParsing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Probe once per mount; fall back to the cached answer when offline.
    useEffect(() => {
        let cancelled = false;
        const cached = (() => {
            try {
                return localStorage.getItem(AI_CONFIGURED_CACHE_KEY);
            } catch {
                return null;
            }
        })();

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            setConfigured(cached === 'true');
            return;
        }

        fetch('/api/ai/parse-transaction')
            .then(res => (res.ok ? res.json() : { configured: false }))
            .then((json: { configured?: boolean }) => {
                if (cancelled) return;
                const isConfigured = json.configured === true;
                setConfigured(isConfigured);
                try {
                    localStorage.setItem(AI_CONFIGURED_CACHE_KEY, String(isConfigured));
                } catch {
                    // non-fatal
                }
            })
            .catch(() => {
                if (!cancelled) setConfigured(cached === 'true');
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const disabled = !isOnline || parsing;

    const handleParse = useCallback(async () => {
        const trimmed = text.trim();
        if (!trimmed || disabled) return;

        setParsing(true);
        setError(null);
        try {
            const res = await fetch('/api/ai/parse-transaction', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: trimmed }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) {
                setError(
                    typeof json?.error === 'string'
                        ? json.error
                        : 'Could not parse that — try rephrasing.'
                );
                return;
            }
            onParsed(json as ParsedNlTransaction);
            setText('');
        } catch {
            setError('Network error — check your connection and try again.');
        } finally {
            setParsing(false);
        }
    }, [text, disabled, onParsed]);

    // Hidden entirely when AI is unconfigured (or the probe hasn't answered yet).
    if (configured !== true) return null;

    return (
        <div>
            <div
                className="flex items-center gap-2"
                title={!isOnline ? 'Natural-language entry needs a connection — you are offline' : undefined}
            >
                <input
                    type="text"
                    value={text}
                    onChange={e => {
                        setText(e.target.value);
                        if (error) setError(null);
                    }}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleParse();
                        }
                    }}
                    disabled={disabled}
                    placeholder="Try: $40 gas yesterday"
                    aria-label="Describe a transaction in plain language"
                    className="flex-1 h-11 min-h-[44px] bg-input-bg border border-border rounded-lg px-3 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 disabled:opacity-50"
                />
                <button
                    type="button"
                    onClick={() => void handleParse()}
                    disabled={disabled || !text.trim()}
                    aria-label="Parse with AI"
                    className="h-11 w-11 min-h-[44px] shrink-0 flex items-center justify-center rounded-lg bg-primary-light border border-primary text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-40 disabled:hover:bg-primary-light disabled:hover:text-primary transition-colors"
                >
                    {parsing ? (
                        <div className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                    ) : (
                        /* Sparkle icon */
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"
                            />
                        </svg>
                    )}
                </button>
            </div>
            {!isOnline && (
                <p className="mt-1 text-xs text-foreground-muted">
                    Natural-language entry needs a connection — offline right now.
                </p>
            )}
            {error && <p className="mt-1 text-xs text-error">{error}</p>}
        </div>
    );
}
