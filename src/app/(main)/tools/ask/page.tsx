'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useBooks } from '@/contexts/BookContext';
import type { AskExchange } from './types';
import ChatMessage from './ChatMessage';

const STARTER_QUESTIONS = [
    'How much did we spend on restaurants in Q1 2026?',
    'What were my top 5 expense categories last month?',
    'How much income have we earned so far this year?',
    'Which months in 2025 had the highest grocery spending?',
];

const MAX_STORED_EXCHANGES = 50;
const MAX_STORED_ROWS = 50;

function storageKey(bookGuid: string) {
    return `askBooks:history:${bookGuid}`;
}

function loadHistory(bookGuid: string): AskExchange[] {
    try {
        const raw = localStorage.getItem(storageKey(bookGuid));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(e => e && typeof e.question === 'string') : [];
    } catch {
        return [];
    }
}

function saveHistory(bookGuid: string, exchanges: AskExchange[]) {
    try {
        const compact = exchanges
            .filter(e => !e.pending)
            .slice(-MAX_STORED_EXCHANGES)
            .map(e => ({ ...e, rows: e.rows?.slice(0, MAX_STORED_ROWS) }));
        localStorage.setItem(storageKey(bookGuid), JSON.stringify(compact));
    } catch {
        // localStorage full or unavailable — chat still works in-memory
    }
}

export default function AskBooksPage() {
    const { activeBookGuid } = useBooks();
    const [exchanges, setExchanges] = useState<AskExchange[]>([]);
    const [historyLoaded, setHistoryLoaded] = useState(false);
    const [question, setQuestion] = useState('');
    const [busy, setBusy] = useState(false);
    const [configured, setConfigured] = useState<boolean | null>(null);
    const [familyScope, setFamilyScope] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Is an AI provider configured?
    useEffect(() => {
        let cancelled = false;
        fetch('/api/ai/query')
            .then(res => (res.ok ? res.json() : { configured: false }))
            .then(data => { if (!cancelled) setConfigured(!!data.configured); })
            .catch(() => { if (!cancelled) setConfigured(false); });
        return () => { cancelled = true; };
    }, []);

    // Per-book persisted history
    useEffect(() => {
        if (!activeBookGuid) return;
        setExchanges(loadHistory(activeBookGuid));
        setHistoryLoaded(true);
    }, [activeBookGuid]);

    useEffect(() => {
        if (activeBookGuid && historyLoaded) saveHistory(activeBookGuid, exchanges);
    }, [activeBookGuid, historyLoaded, exchanges]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [exchanges.length, busy]);

    const ask = useCallback(async (text: string) => {
        const q = text.trim();
        if (!q || busy) return;

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setQuestion('');
        setBusy(true);

        // Prior turns give the model context for follow-ups.
        const history = exchanges
            .filter(e => !e.pending && !e.error && e.answer)
            .slice(-4)
            .flatMap(e => [
                { role: 'user' as const, content: e.question },
                { role: 'assistant' as const, content: e.answer! },
            ]);

        setExchanges(prev => [...prev, { id, question: q, pending: true }]);

        try {
            const res = await fetch('/api/ai/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: q, history, scope: familyScope ? 'family' : 'book' }),
            });
            const data = await res.json().catch(() => ({}));

            setExchanges(prev => prev.map(e => {
                if (e.id !== id) return e;
                if (!res.ok) {
                    return { id, question: q, error: data.error || `Request failed (${res.status})`, sql: data.sql };
                }
                return {
                    id,
                    question: q,
                    answer: data.answer,
                    sql: data.sql,
                    rows: Array.isArray(data.rows) ? data.rows : [],
                    links: Array.isArray(data.links) ? data.links : [],
                };
            }));
        } catch {
            setExchanges(prev => prev.map(e =>
                e.id === id ? { id, question: q, error: 'Network error — please try again.' } : e
            ));
        } finally {
            setBusy(false);
            inputRef.current?.focus();
        }
    }, [busy, exchanges, familyScope]);

    const clearHistory = useCallback(() => {
        setExchanges([]);
        if (activeBookGuid) {
            try { localStorage.removeItem(storageKey(activeBookGuid)); } catch { /* ignore */ }
        }
    }, [activeBookGuid]);

    return (
        <div className="flex flex-col min-h-[24rem] h-[calc(100dvh-6.5rem)] md:h-[calc(100dvh-8.5rem)] max-w-4xl mx-auto">
            <header className="flex flex-wrap items-end justify-between gap-3 pb-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Ask Your Books</h1>
                    <p className="text-foreground-muted mt-1 text-sm">
                        Ask questions in plain English — answered with read-only queries against your book.
                    </p>
                </div>
                {exchanges.length > 0 && (
                    <button
                        type="button"
                        onClick={clearHistory}
                        className="px-3 py-1.5 text-xs rounded-lg border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors duration-150"
                    >
                        Clear history
                    </button>
                )}
                <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground-secondary">
                    <input
                        type="checkbox"
                        checked={familyScope}
                        onChange={event => setFamilyScope(event.target.checked)}
                    />
                    Authorized family graph
                </label>
            </header>

            {configured === false && (
                <div className="mb-4 rounded-xl border border-warning/40 bg-surface/30 p-4 text-sm text-foreground-secondary">
                    No AI provider is configured, so questions can&apos;t be answered yet.{' '}
                    Set up a provider under{' '}
                    <Link href="/settings" className="text-primary hover:text-primary-hover">
                        Settings → AI
                    </Link>
                    .
                </div>
            )}

            {/* Conversation */}
            <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-surface/30 p-4 space-y-6">
                {exchanges.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center gap-4 text-center py-8">
                        <p className="text-sm text-foreground-muted">
                            Try one of these to get started:
                        </p>
                        <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                            {STARTER_QUESTIONS.map(s => (
                                <button
                                    key={s}
                                    type="button"
                                    disabled={busy || configured === false}
                                    onClick={() => ask(s)}
                                    className="px-3 py-1.5 rounded-full border border-border bg-surface text-xs text-foreground-secondary hover:text-primary hover:border-primary/40 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    exchanges.map(e => <ChatMessage key={e.id} exchange={e} />)
                )}
                <div ref={bottomRef} />
            </div>

            {/* Composer */}
            <form
                className="mt-4 flex items-end gap-2"
                onSubmit={e => { e.preventDefault(); ask(question); }}
            >
                <textarea
                    ref={inputRef}
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            ask(question);
                        }
                    }}
                    rows={2}
                    placeholder={configured === false
                        ? 'Configure an AI provider to start asking questions'
                        : 'e.g. How much did we spend on groceries last month?'}
                    disabled={configured === false}
                    className="flex-1 resize-none bg-input-bg border border-border rounded-lg py-2.5 px-3 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
                />
                <button
                    type="submit"
                    disabled={busy || !question.trim() || configured === false}
                    className="px-4 py-2.5 bg-primary hover:bg-primary-hover text-primary-foreground text-sm font-medium rounded-lg transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {busy ? 'Asking…' : 'Ask'}
                </button>
            </form>

            <p className="mt-2 text-xs text-foreground-muted">
                Answers are computed by AI-generated, read-only SQL scoped to {familyScope ? 'the authorized family graph' : 'the active book'}. Verify
                important numbers against the reports.
            </p>
        </div>
    );
}
