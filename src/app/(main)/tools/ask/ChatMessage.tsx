'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AskExchange } from './types';
import ResultTable from './ResultTable';

/** One user question + assistant answer pair, rendered as chat bubbles. */
export default function ChatMessage({ exchange }: { exchange: AskExchange }) {
    const [showSql, setShowSql] = useState(false);

    return (
        <div className="space-y-3">
            {/* User bubble */}
            <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg rounded-br-sm bg-primary-light border border-primary/30 px-4 py-2.5 text-sm text-foreground whitespace-pre-wrap break-words">
                    {exchange.question}
                </div>
            </div>

            {/* Assistant bubble */}
            <div className="flex justify-start">
                <div className="max-w-[85%] min-w-0 rounded-lg rounded-bl-sm bg-surface border border-border px-4 py-2.5 space-y-3">
                    {exchange.pending && (
                        <p className="text-sm text-foreground-muted animate-pulse">
                            Thinking — generating and running a query…
                        </p>
                    )}

                    {exchange.error && (
                        <p className="text-sm text-error">{exchange.error}</p>
                    )}

                    {exchange.answer && (
                        <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                            {exchange.answer}
                        </p>
                    )}

                    {exchange.rows && exchange.rows.length > 0 && (
                        <ResultTable rows={exchange.rows} />
                    )}

                    {exchange.links && exchange.links.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {exchange.links.map(link => (
                                <Link
                                    key={link.href}
                                    href={link.href}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-primary/40 bg-primary-light text-primary text-xs hover:border-primary transition-colors duration-150"
                                >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                    {link.label}
                                </Link>
                            ))}
                        </div>
                    )}

                    {exchange.sql && (
                        <div>
                            <button
                                type="button"
                                onClick={() => setShowSql(s => !s)}
                                className="text-xs text-foreground-muted hover:text-foreground-secondary transition-colors duration-150"
                                aria-expanded={showSql}
                            >
                                {showSql ? '▾ Hide SQL' : '▸ Show SQL'}
                            </button>
                            {showSql && (
                                <pre className="mt-2 p-3 rounded-lg bg-background-tertiary border border-border text-xs font-mono text-foreground-secondary overflow-x-auto whitespace-pre-wrap break-words">
                                    {exchange.sql}
                                </pre>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
