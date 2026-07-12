'use client';

/**
 * Quick Add — thumb-friendly mobile capture screen with offline queue.
 *
 * Big keypad amount entry, expense/income toggle, from-account (last used,
 * persisted) and category picker with recent shortcuts. Saves directly to
 * /api/transactions when online; queues to IndexedDB when offline or when
 * the POST fails, then auto-syncs on reconnect.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Account } from '@/lib/types';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { useQuickAddSync } from '@/lib/hooks/useQuickAddSync';
import { useToast } from '@/contexts/ToastContext';
import {
    buildQuickAddTransaction,
    getQuickAddQueue,
    postQuickAdd,
    QuickAddKind,
} from '@/lib/quick-add-queue';
import { AmountKeypad } from './AmountKeypad';
import { AccountPickerSheet, PickerAccount } from './AccountPickerSheet';
import { PendingQueueBanner } from './PendingQueueBanner';
import { MagicAddInput } from './MagicAddInput';
import type { ParsedNlTransaction } from '@/lib/nl-parse';

// localStorage keys
const LAST_FROM_KEY = 'quickAdd.lastFromAccount';
const RECENT_CATEGORIES_KEY = 'quickAdd.recentCategories';
const ACCOUNTS_CACHE_KEY = 'quickAdd.accountsCache';
const CURRENCY_CACHE_KEY = 'quickAdd.currencyGuid';

const FROM_ACCOUNT_TYPES = new Set(['ASSET', 'BANK', 'CASH', 'CREDIT', 'LIABILITY']);
const MAX_RECENT = 6;

interface CachedAccount extends PickerAccount {
    commodity_guid?: string;
    commodity_mnemonic?: string;
    hidden?: number;
    placeholder?: number;
}

function readJson<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

export default function QuickAddPage() {
    const { success, error: toastError, info } = useToast();
    const queueState = useQuickAddSync();

    // --- Accounts: live list, with a localStorage snapshot for offline use ---
    const { data: liveAccounts } = useAccounts({ flat: true });
    const [cachedAccounts, setCachedAccounts] = useState<CachedAccount[]>([]);

    useEffect(() => {
        setCachedAccounts(readJson<CachedAccount[]>(ACCOUNTS_CACHE_KEY, []));
    }, []);

    useEffect(() => {
        const live = liveAccounts as Account[] | undefined;
        if (live && live.length > 0) {
            const snapshot: CachedAccount[] = live.map(a => ({
                guid: a.guid,
                name: a.name,
                fullname: a.fullname,
                account_type: a.account_type,
                commodity_guid: a.commodity_guid,
                commodity_mnemonic: a.commodity_mnemonic,
                hidden: a.hidden,
                placeholder: a.placeholder,
            }));
            try {
                localStorage.setItem(ACCOUNTS_CACHE_KEY, JSON.stringify(snapshot));
            } catch {
                // Storage full/unavailable — offline picker just won't have data.
            }
            setCachedAccounts(snapshot);
        }
    }, [liveAccounts]);

    const accounts: CachedAccount[] = useMemo(() => {
        const live = liveAccounts as Account[] | undefined;
        if (live && live.length > 0) return live as unknown as CachedAccount[];
        return cachedAccounts;
    }, [liveAccounts, cachedAccounts]);

    const accountMap = useMemo(() => {
        const map = new Map<string, CachedAccount>();
        for (const a of accounts) map.set(a.guid, a);
        return map;
    }, [accounts]);

    const selectable = useMemo(
        () => accounts.filter(a => a.hidden !== 1 && a.placeholder !== 1),
        [accounts]
    );

    // --- Form state ---
    const [amount, setAmount] = useState('');
    const [kind, setKind] = useState<QuickAddKind>('expense');
    const [fromGuid, setFromGuid] = useState('');
    const [toGuid, setToGuid] = useState('');
    const [description, setDescription] = useState('');
    /** YYYY-MM-DD from the NL parser; null = today (the default) */
    const [postDate, setPostDate] = useState<string | null>(null);
    const [recentCategories, setRecentCategories] = useState<string[]>([]);
    const [pickerOpen, setPickerOpen] = useState<'from' | 'to' | null>(null);
    const [saving, setSaving] = useState(false);

    // Restore last-used from-account and recent categories
    useEffect(() => {
        const lastFrom = localStorage.getItem(LAST_FROM_KEY);
        if (lastFrom) setFromGuid(lastFrom);
        setRecentCategories(readJson<string[]>(RECENT_CATEGORIES_KEY, []));
    }, []);

    const fromCandidates = useMemo(
        () => selectable.filter(a => FROM_ACCOUNT_TYPES.has(a.account_type)),
        [selectable]
    );

    const categoryType = kind === 'expense' ? 'EXPENSE' : 'INCOME';
    const categoryCandidates = useMemo(
        () => selectable.filter(a => a.account_type === categoryType),
        [selectable, categoryType]
    );

    // Recent-category shortcuts, restricted to the current kind
    const recentShortcuts = useMemo(
        () =>
            recentCategories
                .map(guid => accountMap.get(guid))
                .filter((a): a is CachedAccount => !!a && a.account_type === categoryType)
                .slice(0, MAX_RECENT),
        [recentCategories, accountMap, categoryType]
    );

    // Clear the category selection when it doesn't match the toggled kind
    useEffect(() => {
        if (toGuid && accountMap.size > 0) {
            const acc = accountMap.get(toGuid);
            if (acc && acc.account_type !== categoryType) {
                setToGuid('');
            }
        }
    }, [categoryType, toGuid, accountMap]);

    const fromAccount = fromGuid ? accountMap.get(fromGuid) : undefined;
    const toAccount = toGuid ? accountMap.get(toGuid) : undefined;

    // Keep a currency fallback cached for fully-offline saves
    useEffect(() => {
        if (fromAccount?.commodity_guid) {
            try {
                localStorage.setItem(CURRENCY_CACHE_KEY, fromAccount.commodity_guid);
            } catch {
                // non-fatal
            }
        }
    }, [fromAccount?.commodity_guid]);

    const amountNumber = parseFloat(amount) || 0;
    const canSave = amountNumber > 0 && !!fromGuid && !!toGuid && fromGuid !== toGuid && !saving;

    const rememberSelections = useCallback(
        (from: string, category: string) => {
            try {
                localStorage.setItem(LAST_FROM_KEY, from);
                const next = [category, ...recentCategories.filter(g => g !== category)].slice(
                    0,
                    MAX_RECENT * 2 // keep extras so both kinds retain shortcuts
                );
                localStorage.setItem(RECENT_CATEGORIES_KEY, JSON.stringify(next));
                setRecentCategories(next);
            } catch {
                // non-fatal
            }
        },
        [recentCategories]
    );

    // Prefill the form from an AI parse result — user still confirms with Save.
    const handleParsed = useCallback(
        (parsed: ParsedNlTransaction) => {
            setKind(parsed.direction);
            setAmount(parsed.amount.toFixed(2));
            setDescription(parsed.description);
            setPostDate(parsed.date);
            if (parsed.suggestedCategoryGuid && accountMap.has(parsed.suggestedCategoryGuid)) {
                setToGuid(parsed.suggestedCategoryGuid);
            }
            info('Prefilled from your text — review and save');
        },
        [accountMap, info]
    );

    const handleSave = useCallback(async () => {
        if (!canSave) return;

        const currencyGuid =
            fromAccount?.commodity_guid || localStorage.getItem(CURRENCY_CACHE_KEY) || '';
        if (!currencyGuid) {
            toastError('No currency available yet — open this page once while online first.');
            return;
        }

        let payload;
        try {
            payload = buildQuickAddTransaction({
                kind,
                amount: amountNumber,
                accountGuid: fromGuid,
                categoryGuid: toGuid,
                currencyGuid,
                description:
                    description.trim() ||
                    (toAccount ? `Quick add: ${toAccount.name}` : 'Quick add'),
                postDate: postDate ?? undefined,
            });
        } catch (err) {
            toastError(err instanceof Error ? err.message : 'Invalid entry');
            return;
        }

        setSaving(true);
        try {
            rememberSelections(fromGuid, toGuid);

            let queued = false;
            if (typeof navigator !== 'undefined' && navigator.onLine) {
                const result = await postQuickAdd(payload);
                if (result.synced) {
                    success('Transaction saved');
                } else {
                    await getQuickAddQueue().enqueue(payload);
                    queued = true;
                }
            } else {
                await getQuickAddQueue().enqueue(payload);
                queued = true;
            }

            if (queued) {
                info('Queued — will sync when online');
                await queueState.refresh();
            }

            // Reset for the next entry (keep account selections)
            setAmount('');
            setDescription('');
            setPostDate(null);
        } finally {
            setSaving(false);
        }
    }, [
        canSave,
        kind,
        amountNumber,
        fromGuid,
        toGuid,
        fromAccount,
        toAccount,
        description,
        postDate,
        rememberSelections,
        success,
        info,
        toastError,
        queueState,
    ]);

    const currencyLabel = fromAccount?.commodity_mnemonic || '';

    return (
        <div className="max-w-md mx-auto px-4 py-4 space-y-4 pb-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold text-foreground">Quick Add</h1>
                {!queueState.isOnline && (
                    <span className="text-xs px-2 py-1 rounded-full bg-surface border border-border text-warning">
                        Offline
                    </span>
                )}
            </div>

            {/* Natural-language magic input (hidden when AI is unconfigured) */}
            <MagicAddInput isOnline={queueState.isOnline} onParsed={handleParsed} />

            {/* Pending queue */}
            <PendingQueueBanner
                items={queueState.items}
                isSyncing={queueState.isSyncing}
                isOnline={queueState.isOnline}
                onSync={() => void queueState.sync()}
                onRetry={id => void queueState.retryItem(id)}
                onRemove={id => void queueState.removeItem(id)}
            />

            {/* Expense / Income toggle */}
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Transaction type">
                {(['expense', 'income'] as const).map(k => (
                    <button
                        key={k}
                        type="button"
                        onClick={() => setKind(k)}
                        aria-pressed={kind === k}
                        className={`h-12 min-h-[44px] rounded-lg text-sm font-medium border transition-colors ${
                            kind === k
                                ? 'bg-primary-light border-primary text-primary'
                                : 'bg-surface border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                        }`}
                    >
                        {k === 'expense' ? 'Expense' : 'Income'}
                    </button>
                ))}
            </div>

            {/* Amount display */}
            <div className="text-center py-2">
                <div
                    className={`font-mono text-5xl tracking-tight ${
                        amount ? 'text-foreground' : 'text-foreground-muted'
                    }`}
                    style={{ fontFeatureSettings: "'tnum'" }}
                    aria-live="polite"
                >
                    {amount || '0.00'}
                    {currencyLabel && (
                        <span className="text-base text-foreground-muted ml-2">{currencyLabel}</span>
                    )}
                </div>
                {postDate && (
                    <div className="mt-2 flex justify-center">
                        <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-surface border border-border text-foreground-secondary">
                            <span className="font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                                {postDate}
                            </span>
                            <button
                                type="button"
                                onClick={() => setPostDate(null)}
                                aria-label="Use today's date instead"
                                className="text-foreground-muted hover:text-foreground transition-colors"
                            >
                                ×
                            </button>
                        </span>
                    </div>
                )}
            </div>

            {/* Keypad */}
            <AmountKeypad value={amount} onChange={setAmount} />

            {/* From account */}
            <div>
                <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                    {kind === 'expense' ? 'Pay from' : 'Deposit to'}
                </label>
                <button
                    type="button"
                    onClick={() => setPickerOpen('from')}
                    className="w-full h-12 min-h-[44px] flex items-center justify-between px-3 bg-surface border border-border rounded-lg text-sm hover:border-border-hover transition-colors"
                >
                    <span className={fromAccount ? 'text-foreground' : 'text-foreground-muted'}>
                        {fromAccount?.name || 'Select account...'}
                    </span>
                    <svg className="w-4 h-4 text-foreground-muted" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
            </div>

            {/* Category with recent shortcuts */}
            <div>
                <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                    {kind === 'expense' ? 'Category' : 'Income source'}
                </label>
                {recentShortcuts.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                        {recentShortcuts.map(acc => (
                            <button
                                key={acc.guid}
                                type="button"
                                onClick={() => setToGuid(acc.guid)}
                                className={`min-h-[44px] px-3 rounded-lg text-sm border transition-colors ${
                                    toGuid === acc.guid
                                        ? 'bg-primary-light border-primary text-primary'
                                        : 'bg-surface border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                                }`}
                            >
                                {acc.name}
                            </button>
                        ))}
                    </div>
                )}
                <button
                    type="button"
                    onClick={() => setPickerOpen('to')}
                    className="w-full h-12 min-h-[44px] flex items-center justify-between px-3 bg-surface border border-border rounded-lg text-sm hover:border-border-hover transition-colors"
                >
                    <span className={toAccount ? 'text-foreground' : 'text-foreground-muted'}>
                        {toAccount?.name || `Select ${kind === 'expense' ? 'category' : 'source'}...`}
                    </span>
                    <svg className="w-4 h-4 text-foreground-muted" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
            </div>

            {/* Description (optional) */}
            <div>
                <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                    Description <span className="normal-case">(optional)</span>
                </label>
                <input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder={toAccount ? `Quick add: ${toAccount.name}` : 'What was it?'}
                    className="w-full h-12 bg-input-bg border border-border rounded-lg px-3 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50"
                />
            </div>

            {/* Save */}
            <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!canSave}
                className="w-full h-14 min-h-[44px] rounded-lg bg-primary hover:bg-primary-hover disabled:bg-primary/40 text-primary-foreground text-base font-semibold transition-colors flex items-center justify-center gap-2"
            >
                {saving ? (
                    <>
                        <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                        Saving...
                    </>
                ) : queueState.isOnline ? (
                    'Save'
                ) : (
                    'Save offline'
                )}
            </button>

            {/* Account pickers */}
            <AccountPickerSheet
                open={pickerOpen === 'from'}
                title={kind === 'expense' ? 'Pay from' : 'Deposit to'}
                accounts={fromCandidates}
                selectedGuid={fromGuid}
                onSelect={acc => {
                    setFromGuid(acc.guid);
                    setPickerOpen(null);
                }}
                onClose={() => setPickerOpen(null)}
            />
            <AccountPickerSheet
                open={pickerOpen === 'to'}
                title={kind === 'expense' ? 'Category' : 'Income source'}
                accounts={categoryCandidates}
                selectedGuid={toGuid}
                onSelect={acc => {
                    setToGuid(acc.guid);
                    setPickerOpen(null);
                }}
                onClose={() => setPickerOpen(null)}
            />
        </div>
    );
}
