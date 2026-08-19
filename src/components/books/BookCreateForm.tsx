'use client';

import { ReactNode, useState } from 'react';
import { CurrencySelect } from '@/components/CurrencySelect';

/** The one message both book-creation surfaces show for a missing name. */
export const BOOK_NAME_REQUIRED = 'Please enter a book name';

/**
 * Shared name validation. Returns the message to show, or null when the name
 * is usable. Both creation surfaces (`NewBookForm` -> POST /api/books/default
 * and the wizard's import step -> POST /api/books/from-template) call this, so
 * the rule cannot drift between them.
 */
export function validateBookName(name: string): string | null {
    return name.trim() === '' ? BOOK_NAME_REQUIRED : null;
}

export interface BookCreateValues {
    name: string;
    currency: string;
}

interface BookCreateFormProps {
    /**
     * Perform the creation. Receives the trimmed name and the selected
     * currency; throw an `Error` to surface a message through `onError`.
     */
    onSubmit: (values: BookCreateValues) => Promise<void>;
    /** Report a validation/submission failure (or null to clear it). */
    onError: (message: string | null) => void;
    /** Placeholder for the name input; callers vary it by entity type. */
    namePlaceholder?: string;
    /** id for the name input, so callers can keep unique ids on one page. */
    nameInputId?: string;
    /** Render the currency selector (default true). */
    showCurrency?: boolean;
    submitLabel?: string;
    /** Stretch the submit button across the form (the wizard's step layout). */
    submitFullWidth?: boolean;
    onCancel?: () => void;
    /** Extra fields above the name input (entity type, activity, ...). */
    beforeNameFields?: ReactNode;
    /** Extra fields between the name input and the currency selector. */
    afterNameFields?: ReactNode;
    /** Anything below the currency selector: previews, error banners, ... */
    afterCurrencyFields?: ReactNode;
}

/**
 * Presentational book-creation form: name, optional currency, validation and
 * submit state. It owns no endpoint of its own — the caller supplies the
 * submit handler — so the two creation routes stay distinct while the form,
 * its validation, and its busy state exist once.
 */
export default function BookCreateForm({
    onSubmit,
    onError,
    namePlaceholder = 'e.g. My Finances',
    nameInputId = 'new-book-name',
    showCurrency = true,
    submitLabel = 'Create Book',
    submitFullWidth = false,
    onCancel,
    beforeNameFields,
    afterNameFields,
    afterCurrencyFields,
}: BookCreateFormProps) {
    const [name, setName] = useState('');
    const [currency, setCurrency] = useState('USD');
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async () => {
        const problem = validateBookName(name);
        if (problem) {
            onError(problem);
            return;
        }
        setSubmitting(true);
        onError(null);
        try {
            await onSubmit({ name: name.trim(), currency });
        } catch (err) {
            onError(err instanceof Error ? err.message : 'Failed to create book');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="space-y-5">
            {beforeNameFields}

            <div>
                <label htmlFor={nameInputId} className="block text-sm font-medium text-foreground mb-1.5">
                    Book Name <span className="text-negative">*</span>
                </label>
                <input
                    id={nameInputId}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-muted focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder={namePlaceholder}
                />
            </div>

            {afterNameFields}

            {showCurrency && (
                <div>
                    <label htmlFor={`${nameInputId}-currency`} className="block text-sm font-medium text-foreground mb-1.5">
                        Currency
                    </label>
                    <CurrencySelect id={`${nameInputId}-currency`} value={currency} onChange={setCurrency} />
                </div>
            )}

            {afterCurrencyFields}

            <div className={submitFullWidth ? '' : 'flex items-center justify-end gap-3'}>
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={submitting}
                        className="px-4 py-2 text-sm font-medium text-foreground-secondary bg-surface-hover rounded-lg hover:bg-surface-hover/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Cancel
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={submitting || name.trim() === ''}
                    className={
                        submitFullWidth
                            ? 'w-full py-3 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2'
                            : 'px-5 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2'
                    }
                >
                    {submitting ? (
                        <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            Creating...
                        </>
                    ) : (
                        submitLabel
                    )}
                </button>
            </div>
        </div>
    );
}
