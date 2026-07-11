'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { AccountSelector } from '@/components/ui/AccountSelector';
import {
    CustomWidgetDef,
    CustomWidgetMode,
    SpendDays,
    SPEND_DAYS_OPTIONS,
    MAX_CUSTOM_WIDGET_ACCOUNTS,
    createCustomWidgetId,
    validateCustomWidgetDef,
} from '@/lib/dashboard-widgets';

interface CustomWidgetFormProps {
    isOpen: boolean;
    onClose: () => void;
    /** When set, the form edits this definition; otherwise it creates a new one. */
    initial?: CustomWidgetDef | null;
    onSave: (def: CustomWidgetDef) => void;
}

const DAYS_LABELS: Record<SpendDays, string> = {
    30: 'Last 30 days',
    90: 'Last 90 days',
    365: 'Last 365 days',
};

/**
 * Modal builder for user-defined stat widgets: name, source (account balances
 * or trailing spend), accounts, and display options. v1 display is Stat only.
 */
export default function CustomWidgetForm({ isOpen, onClose, initial, onSave }: CustomWidgetFormProps) {
    const [name, setName] = useState('');
    const [mode, setMode] = useState<CustomWidgetMode>('balance');
    const [days, setDays] = useState<SpendDays>(90);
    const [toneBySign, setToneBySign] = useState(false);
    // One entry per picker row; empty string = unselected row.
    const [accountGuids, setAccountGuids] = useState<string[]>(['']);
    const [validationError, setValidationError] = useState<string | null>(null);

    // (Re)seed form state each time the modal opens (derived during render).
    const [seed, setSeed] = useState<{ open: boolean; initialId: string | null }>({
        open: isOpen,
        initialId: initial?.id ?? null,
    });
    if (seed.open !== isOpen || seed.initialId !== (initial?.id ?? null)) {
        setSeed({ open: isOpen, initialId: initial?.id ?? null });
        if (isOpen) {
            setValidationError(null);
            if (initial) {
                setName(initial.name);
                setMode(initial.config.mode);
                setDays(initial.config.days ?? 90);
                setToneBySign(initial.config.toneBySign === true);
                setAccountGuids(
                    initial.config.accountGuids.length > 0 ? [...initial.config.accountGuids] : ['']
                );
            } else {
                setName('');
                setMode('balance');
                setDays(90);
                setToneBySign(false);
                setAccountGuids(['']);
            }
        }
    }

    const setAccountAt = (index: number, guid: string) => {
        setAccountGuids(prev => prev.map((g, i) => (i === index ? guid : g)));
    };

    const removeAccountAt = (index: number) => {
        setAccountGuids(prev => (prev.length <= 1 ? [''] : prev.filter((_, i) => i !== index)));
    };

    const addAccountRow = () => {
        setAccountGuids(prev =>
            prev.length >= MAX_CUSTOM_WIDGET_ACCOUNTS ? prev : [...prev, '']
        );
    };

    const handleSave = () => {
        const candidate: CustomWidgetDef = {
            id: initial?.id ?? createCustomWidgetId(),
            name: name.trim(),
            config: {
                mode,
                accountGuids: accountGuids.filter(Boolean),
                ...(mode === 'spend' ? { days } : {}),
                toneBySign,
            },
            viz: 'stat',
        };
        const validated = validateCustomWidgetDef(candidate);
        if (!validated) {
            setValidationError(
                !candidate.name
                    ? 'Give the widget a name.'
                    : 'Pick at least one account.'
            );
            return;
        }
        onSave(validated);
        onClose();
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={initial ? 'Edit custom widget' : 'New custom widget'}
            size="md"
        >
            <div className="p-6 space-y-5">
                {/* Name */}
                <div>
                    <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1.5">
                        Name
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="e.g. Emergency fund, Dining out"
                        maxLength={80}
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                    />
                </div>

                {/* Source */}
                <div>
                    <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1.5">
                        Source
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        {(
                            [
                                ['balance', 'Account balance', 'Sum of current balances'],
                                ['spend', 'Spend over period', 'Activity total, sign-corrected'],
                            ] as const
                        ).map(([value, label, sub]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setMode(value)}
                                className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                                    mode === value
                                        ? 'border-primary/50 bg-primary/10'
                                        : 'border-border bg-surface/50 hover:border-border-hover'
                                }`}
                            >
                                <div className={`text-sm ${mode === value ? 'text-primary' : 'text-foreground'}`}>
                                    {label}
                                </div>
                                <div className="text-[11px] text-foreground-muted">{sub}</div>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Period (spend only) */}
                {mode === 'spend' && (
                    <div>
                        <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1.5">
                            Period
                        </label>
                        <div className="flex gap-2">
                            {SPEND_DAYS_OPTIONS.map(d => (
                                <button
                                    key={d}
                                    type="button"
                                    onClick={() => setDays(d)}
                                    className={`px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                                        days === d
                                            ? 'border-primary/50 bg-primary/10 text-primary'
                                            : 'border-border text-foreground-secondary hover:border-border-hover'
                                    }`}
                                >
                                    {DAYS_LABELS[d]}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Accounts */}
                <div>
                    <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1.5">
                        Accounts
                    </label>
                    <div className="space-y-2">
                        {accountGuids.map((guid, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <AccountSelector
                                    value={guid}
                                    onChange={g => setAccountAt(index, g)}
                                    placeholder="Select account..."
                                    className="flex-1"
                                    compact
                                />
                                <button
                                    type="button"
                                    onClick={() => removeAccountAt(index)}
                                    title="Remove account"
                                    className="p-1.5 rounded-md text-foreground-muted hover:text-negative hover:bg-surface-hover transition-colors"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        ))}
                    </div>
                    {accountGuids.length < MAX_CUSTOM_WIDGET_ACCOUNTS && (
                        <button
                            type="button"
                            onClick={addAccountRow}
                            className="mt-2 px-2.5 py-1 rounded-lg border border-dashed border-border text-xs text-foreground-secondary hover:border-primary/50 hover:text-primary transition-colors"
                        >
                            + Add account
                        </button>
                    )}
                </div>

                {/* Display */}
                <div>
                    <label className="block text-xs uppercase tracking-wider text-foreground-muted mb-1.5">
                        Display
                    </label>
                    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border bg-surface/50">
                        <div>
                            <div className="text-sm text-foreground">Stat</div>
                            <div className="text-[11px] text-foreground-muted">
                                Big number. Charts are planned for a future version.
                            </div>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer shrink-0">
                            <input
                                type="checkbox"
                                checked={toneBySign}
                                onChange={e => setToneBySign(e.target.checked)}
                                className="accent-[var(--primary)]"
                            />
                            Color by sign
                        </label>
                    </div>
                </div>

                {validationError && (
                    <p className="text-xs text-negative">{validationError}</p>
                )}

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-1">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-3 py-2 rounded-lg text-sm text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        className="px-4 py-2 rounded-lg text-sm bg-primary text-primary-foreground hover:bg-primary-hover transition-colors"
                    >
                        {initial ? 'Save changes' : 'Create widget'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
