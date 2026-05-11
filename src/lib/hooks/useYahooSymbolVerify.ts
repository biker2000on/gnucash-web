'use client';

import { useCallback, useRef, useState } from 'react';

export type VerifyStatus = 'idle' | 'pending' | 'verified' | 'not_found';

export interface VerifyResult {
    status: VerifyStatus;
    fullname?: string;
    symbol?: string;
}

interface CachedResult {
    exists: boolean;
    fullname?: string;
}

const cache = new Map<string, CachedResult>();

function cacheKey(symbol: string, namespace?: string): string {
    return `${(namespace || '').toUpperCase()}::${symbol.trim().toUpperCase()}`;
}

export async function verifySymbol(symbol: string, namespace?: string): Promise<CachedResult> {
    const trimmed = symbol.trim();
    if (!trimmed) return { exists: false };

    if ((namespace || '').toUpperCase() === 'CURRENCY') {
        return { exists: true };
    }

    const key = cacheKey(trimmed, namespace);
    const cached = cache.get(key);
    if (cached) return cached;

    try {
        const params = new URLSearchParams({ symbol: trimmed });
        if (namespace) params.set('namespace', namespace);
        const res = await fetch(`/api/commodities/verify-symbol?${params.toString()}`);
        if (!res.ok) {
            const fallback = { exists: false };
            cache.set(key, fallback);
            return fallback;
        }
        const json = await res.json() as CachedResult;
        cache.set(key, json);
        return json;
    } catch {
        const fallback = { exists: false };
        cache.set(key, fallback);
        return fallback;
    }
}

/**
 * Verify many symbols in one request. Returns a map keyed by symbol (uppercased).
 * Populates the shared per-symbol cache so subsequent individual verifySymbol()
 * calls are free.
 */
export async function verifySymbolsBulk(
    items: Array<{ symbol: string; namespace?: string }>
): Promise<Map<string, CachedResult>> {
    const out = new Map<string, CachedResult>();
    const toFetch: string[] = [];
    for (const { symbol, namespace } of items) {
        const trimmed = symbol.trim();
        if (!trimmed) continue;
        const ns = (namespace || '').toUpperCase();
        if (ns === 'CURRENCY') {
            out.set(trimmed.toUpperCase(), { exists: true });
            continue;
        }
        const cached = cache.get(cacheKey(trimmed, namespace));
        if (cached) {
            out.set(trimmed.toUpperCase(), cached);
        } else {
            toFetch.push(trimmed);
        }
    }
    if (toFetch.length === 0) return out;

    try {
        const res = await fetch('/api/commodities/verify-symbol', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbols: toFetch }),
        });
        if (!res.ok) {
            for (const s of toFetch) {
                const fallback = { exists: false };
                cache.set(cacheKey(s), fallback);
                out.set(s.toUpperCase(), fallback);
            }
            return out;
        }
        const json = (await res.json()) as { results: Record<string, CachedResult> };
        for (const s of toFetch) {
            const r = json.results?.[s] ?? { exists: false };
            // Cache under both with-namespace and without — bulk is namespace-agnostic
            const item = items.find((it) => it.symbol.trim() === s);
            cache.set(cacheKey(s, item?.namespace), r);
            cache.set(cacheKey(s), r);
            out.set(s.toUpperCase(), r);
        }
    } catch {
        for (const s of toFetch) {
            const fallback = { exists: false };
            cache.set(cacheKey(s), fallback);
            out.set(s.toUpperCase(), fallback);
        }
    }
    return out;
}

/**
 * Hook for verifying a ticker symbol against Yahoo Finance with caching.
 * Returns a result and a `verify()` function the caller invokes (typically on blur).
 */
export function useYahooSymbolVerify(): {
    result: VerifyResult;
    verify: (symbol: string, namespace?: string) => Promise<VerifyResult>;
    reset: () => void;
} {
    const [result, setResult] = useState<VerifyResult>({ status: 'idle' });
    const requestIdRef = useRef(0);

    const verify = useCallback(async (symbol: string, namespace?: string): Promise<VerifyResult> => {
        const trimmed = symbol.trim();
        if (!trimmed) {
            const idle: VerifyResult = { status: 'idle' };
            setResult(idle);
            return idle;
        }
        const id = ++requestIdRef.current;
        setResult({ status: 'pending', symbol: trimmed });
        const lookup = await verifySymbol(trimmed, namespace);
        // Drop stale results if a newer verify() has started
        if (id !== requestIdRef.current) {
            return {
                status: lookup.exists ? 'verified' : 'not_found',
                fullname: lookup.fullname,
                symbol: trimmed,
            };
        }
        const next: VerifyResult = {
            status: lookup.exists ? 'verified' : 'not_found',
            fullname: lookup.fullname,
            symbol: trimmed,
        };
        setResult(next);
        return next;
    }, []);

    const reset = useCallback(() => {
        requestIdRef.current++;
        setResult({ status: 'idle' });
    }, []);

    return { result, verify, reset };
}
