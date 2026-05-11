'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useYahooSymbolVerify, type VerifyStatus } from '@/lib/hooks/useYahooSymbolVerify';
import { useToast } from '@/contexts/ToastContext';
import { NamespaceSelector } from './NamespaceSelector';

export interface CommodityFormValues {
    guid?: string;
    namespace: string;
    mnemonic: string;
    fullname: string;
    cusip: string;
    fraction: number;
    quoteFlag: boolean;
    quoteSource: string;
    quoteTz: string;
}

interface CommodityEditorModalProps {
    isOpen: boolean;
    mode: 'create' | 'edit';
    initial?: CommodityFormValues;
    namespaceSuggestions?: string[];
    onClose: () => void;
    onSaved: () => void;
}

const EMPTY: CommodityFormValues = {
    namespace: 'NASDAQ',
    mnemonic: '',
    fullname: '',
    cusip: '',
    fraction: 10000,
    quoteFlag: true,
    quoteSource: '',
    quoteTz: '',
};

function VerifyIndicator({ status, fullname }: { status: VerifyStatus; fullname?: string }) {
    if (status === 'idle') return null;
    if (status === 'pending') {
        return (
            <span className="text-xs text-foreground-muted inline-flex items-center gap-1">
                <span className="inline-block w-3 h-3 border-2 border-foreground-muted/40 border-t-foreground-muted rounded-full animate-spin" />
                Checking Yahoo…
            </span>
        );
    }
    if (status === 'verified') {
        return (
            <span className="text-xs text-success inline-flex items-center gap-1">
                <span aria-hidden>✅</span>
                {fullname ? `Verified: ${fullname}` : 'Verified on Yahoo Finance'}
            </span>
        );
    }
    return (
        <span className="text-xs text-warning inline-flex items-center gap-1">
            <span aria-hidden>⚠️</span>
            Not found on Yahoo Finance
        </span>
    );
}

export function CommodityEditorModal({
    isOpen,
    mode,
    initial,
    namespaceSuggestions = [],
    onClose,
    onSaved,
}: CommodityEditorModalProps) {
    const { success, error: showError } = useToast();
    const [form, setForm] = useState<CommodityFormValues>(initial ?? EMPTY);
    const [saving, setSaving] = useState(false);
    const [fieldError, setFieldError] = useState<string | null>(null);
    const { result, verify, reset } = useYahooSymbolVerify();
    const originalMnemonicRef = useRef<string>(initial?.mnemonic ?? '');

    // Reset state whenever the modal opens with new data
    useEffect(() => {
        if (!isOpen) return;
        const seed = initial ?? EMPTY;
        setForm(seed);
        setFieldError(null);
        originalMnemonicRef.current = seed.mnemonic;
        reset();
        // Verify pre-filled symbol on edit
        if (mode === 'edit' && seed.mnemonic && seed.namespace !== 'CURRENCY') {
            void verify(seed.mnemonic, seed.namespace);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const update = <K extends keyof CommodityFormValues>(key: K, value: CommodityFormValues[K]) => {
        setForm((prev) => ({ ...prev, [key]: value }));
        if (key === 'namespace' || key === 'mnemonic') {
            reset();
        }
    };

    const handleMnemonicBlur = async () => {
        const sym = form.mnemonic.trim();
        if (!sym) {
            reset();
            return;
        }
        const lookup = await verify(sym, form.namespace);
        if (lookup.status === 'verified' && lookup.fullname && !form.fullname.trim()) {
            setForm((prev) => ({ ...prev, fullname: lookup.fullname || '' }));
        }
    };

    const validate = (): string | null => {
        if (!form.namespace.trim()) return 'Namespace is required';
        if (!form.mnemonic.trim()) return 'Symbol is required';
        if (!Number.isFinite(form.fraction) || form.fraction < 1 || !Number.isInteger(form.fraction)) {
            return 'Fraction must be a positive integer';
        }
        return null;
    };

    const handleSave = async () => {
        if (saving) return;
        const err = validate();
        if (err) {
            setFieldError(err);
            return;
        }
        setFieldError(null);

        const mnemonicChanged = form.mnemonic.trim() !== originalMnemonicRef.current.trim();
        const needsVerify = (mode === 'create' || mnemonicChanged) && form.namespace.toUpperCase() !== 'CURRENCY';
        if (needsVerify) {
            const lookup = await verify(form.mnemonic, form.namespace);
            if (lookup.status === 'not_found') {
                const ok = window.confirm(
                    `Symbol "${form.mnemonic.trim()}" was not found on Yahoo Finance.\n\nSave anyway?`
                );
                if (!ok) return;
            }
        }

        setSaving(true);
        try {
            const payload = {
                namespace: form.namespace.trim(),
                mnemonic: form.mnemonic.trim(),
                fullname: form.fullname.trim() || null,
                cusip: form.cusip.trim() || null,
                fraction: form.fraction,
                quote_flag: form.quoteFlag,
                quote_source: form.quoteSource.trim() || null,
                quote_tz: form.quoteTz.trim() || null,
            };
            const url = '/api/commodities';
            const method = mode === 'create' ? 'POST' : 'PATCH';
            const body = mode === 'create' ? payload : { guid: form.guid, ...payload };
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (res.status === 409) {
                    setFieldError(data.error || 'A commodity with this namespace + symbol already exists');
                    return;
                }
                throw new Error(data.error || 'Failed to save commodity');
            }
            success(mode === 'create' ? `Added ${form.mnemonic.trim()}` : `Saved ${form.mnemonic.trim()}`);
            onSaved();
            onClose();
        } catch (e) {
            showError(e instanceof Error ? e.message : 'Failed to save commodity');
        } finally {
            setSaving(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void handleSave();
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={mode === 'create' ? 'Add Commodity' : 'Edit Commodity'}
            size="lg"
        >
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    void handleSave();
                }}
                onKeyDown={handleKeyDown}
                className="p-6 space-y-4"
            >
                {fieldError && (
                    <div className="bg-warning/10 border border-warning/30 text-warning rounded-lg px-3 py-2 text-sm">
                        {fieldError}
                    </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">
                            Namespace
                        </label>
                        <NamespaceSelector
                            value={form.namespace}
                            options={namespaceSuggestions}
                            onChange={(v) => update('namespace', v)}
                            placeholder="NASDAQ, NYSE, FUND, CURRENCY..."
                            className="w-full"
                        />
                    </div>

                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">
                            Symbol
                        </label>
                        <input
                            value={form.mnemonic}
                            onChange={(e) => update('mnemonic', e.target.value.toUpperCase())}
                            onBlur={handleMnemonicBlur}
                            placeholder="AAPL"
                            autoFocus={mode === 'create'}
                            className="w-full font-mono bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                        <div className="mt-1 min-h-[1rem]">
                            {form.namespace.toUpperCase() !== 'CURRENCY' && (
                                <VerifyIndicator status={result.status} fullname={result.fullname} />
                            )}
                        </div>
                    </div>
                </div>

                <div>
                    <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">
                        Full Name
                    </label>
                    <input
                        value={form.fullname}
                        onChange={(e) => update('fullname', e.target.value)}
                        placeholder="Apple Inc."
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                    />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">
                            CUSIP
                        </label>
                        <input
                            value={form.cusip}
                            onChange={(e) => update('cusip', e.target.value)}
                            placeholder="Optional"
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>
                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">
                            Fraction
                        </label>
                        <input
                            type="number"
                            min={1}
                            step={1}
                            value={form.fraction}
                            onChange={(e) => {
                                const parsed = parseInt(e.target.value, 10);
                                update('fraction', Number.isFinite(parsed) ? parsed : 0);
                            }}
                            className="w-full font-mono bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                        <p className="text-xs text-foreground-muted mt-1">
                            Smallest unit; e.g., 100 = 2 decimals, 1000000 = 6 decimals.
                        </p>
                    </div>
                </div>

                <div className="border-t border-border pt-4">
                    <label className="inline-flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer">
                        <input
                            type="checkbox"
                            checked={form.quoteFlag}
                            onChange={(e) => update('quoteFlag', e.target.checked)}
                            className="w-4 h-4 rounded border-border bg-background-tertiary"
                        />
                        Enable historical price quotes
                    </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">
                            Quote Source
                        </label>
                        <input
                            value={form.quoteSource}
                            onChange={(e) => update('quoteSource', e.target.value)}
                            placeholder="Finance::Quote"
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>
                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1">
                            Quote Timezone
                        </label>
                        <input
                            value={form.quoteTz}
                            onChange={(e) => update('quoteTz', e.target.value)}
                            placeholder="America/New_York"
                            className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-border">
                    <p className="text-xs text-foreground-muted">
                        <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded text-foreground-secondary">Ctrl+Enter</kbd> to save, <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded text-foreground-secondary">Esc</kbd> to close
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm bg-background-tertiary text-foreground-secondary hover:bg-surface-hover rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={saving}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/40 text-primary-foreground rounded-lg transition-colors disabled:cursor-not-allowed"
                        >
                            {saving ? 'Saving…' : mode === 'create' ? 'Add Commodity' : 'Save'}
                        </button>
                    </div>
                </div>
            </form>
        </Modal>
    );
}
