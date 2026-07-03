'use client';

import { useState } from 'react';
import { CurrencySelect } from '@/components/CurrencySelect';
import {
  ENTITY_TYPE_OPTIONS,
  ENTITY_ACCOUNT_TEMPLATES,
  type TemplateAccountDef,
} from '@/lib/book-templates';
import type { EntityType } from '@/lib/services/entity.service';

interface NewBookFormProps {
  onSuccess: (bookGuid: string) => void;
  onCancel?: () => void;
  /** Show the currency selector (default true). */
  showCurrency?: boolean;
  /** Show the optional description field (default false). */
  showDescription?: boolean;
  submitLabel?: string;
}

function AccountPreviewNode({ account, depth }: { account: TemplateAccountDef; depth: number }) {
  const hasChildren = !!account.children?.length;
  return (
    <>
      <div
        className="flex items-center gap-2 py-0.5"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <span className={`text-xs ${hasChildren ? 'text-foreground-secondary font-medium' : 'text-foreground'}`}>
          {account.name}
        </span>
        <span className="text-[10px] text-foreground-muted ml-auto pr-1">{account.type}</span>
      </div>
      {account.children?.map((child, i) => (
        <AccountPreviewNode key={`${child.name}-${i}`} account={child} depth={depth + 1} />
      ))}
    </>
  );
}

/**
 * Shared book-creation form: pick an organization type first, name the book,
 * and create it seeded with the recommended account hierarchy via
 * POST /api/books/default.
 */
export default function NewBookForm({
  onSuccess,
  onCancel,
  showCurrency = true,
  showDescription = false,
  submitLabel = 'Create Book',
}: NewBookFormProps) {
  const [entityType, setEntityType] = useState<EntityType>('household');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const template = ENTITY_ACCOUNT_TEMPLATES[entityType];

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Please enter a book name');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/books/default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: showDescription && description.trim() ? description.trim() : undefined,
          currency: showCurrency ? currency : undefined,
          entityType,
          entityName: entityType !== 'household' ? name.trim() : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to create book');
        return;
      }
      const data = await res.json();
      onSuccess(data.bookGuid);
    } catch {
      setError('Failed to create book. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          Organization Type
        </label>
        <div className="space-y-2">
          {ENTITY_TYPE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                entityType === option.value
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border hover:bg-surface-hover/50'
              }`}
            >
              <input
                type="radio"
                name="entity-type"
                checked={entityType === option.value}
                onChange={() => setEntityType(option.value)}
                className="mt-0.5 accent-primary"
              />
              <div>
                <div className="text-sm font-medium text-foreground">{option.label}</div>
                <div className="text-xs text-foreground-muted mt-0.5">{option.description}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="new-book-name" className="block text-sm font-medium text-foreground mb-1.5">
          Book Name <span className="text-negative">*</span>
        </label>
        <input
          id="new-book-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-muted focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder={entityType === 'household' ? 'e.g. My Finances' : 'e.g. Acme LLC'}
        />
      </div>

      {showDescription && (
        <div>
          <label htmlFor="new-book-desc" className="block text-sm font-medium text-foreground mb-1.5">
            Description
          </label>
          <textarea
            id="new-book-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-muted focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            placeholder="Optional description for this book"
          />
        </div>
      )}

      {showCurrency && (
        <div>
          <label htmlFor="new-book-currency" className="block text-sm font-medium text-foreground mb-1.5">
            Currency
          </label>
          <CurrencySelect id="new-book-currency" value={currency} onChange={setCurrency} />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          Accounts to Create
        </label>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-input-bg p-2">
          {template.map((account, i) => (
            <AccountPreviewNode key={`${account.name}-${i}`} account={account} depth={0} />
          ))}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-negative/10 border border-negative/30 rounded-lg text-sm text-negative">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            className="px-4 py-2 text-sm font-medium text-foreground-secondary bg-surface-hover rounded-lg hover:bg-surface-hover/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating || !name.trim()}
          className="px-5 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {creating ? (
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
