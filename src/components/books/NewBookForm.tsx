'use client';

import { useState } from 'react';
import { ErrorLiveRegion } from '@/components/a11y/LiveRegion';
import BookCreateForm from '@/components/books/BookCreateForm';
import {
  BUSINESS_ACTIVITY_OPTIONS,
  ENTITY_TYPE_OPTIONS,
  FARM_CAPABLE_ENTITY_TYPES,
  getEntityAccountTemplate,
  type TemplateAccountDef,
} from '@/lib/book-templates';
import type { BusinessActivity, EntityType } from '@/lib/services/entity.service';
import { extractErrorMessage } from '@/lib/api-error';

interface NewBookFormProps {
  onSuccess: (bookGuid: string) => void;
  onCancel?: () => void;
  /** Show the currency selector (default true). */
  showCurrency?: boolean;
  /** Show the optional description field (default false). */
  showDescription?: boolean;
  submitLabel?: string;
  /** Preselected entity type (e.g. deep link from the farm analyzer). */
  defaultEntityType?: EntityType;
  /** Preselected business activity (e.g. 'farm' from the farm analyzer). */
  defaultBusinessActivity?: BusinessActivity;
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
 * Book creation seeded with a recommended account hierarchy: pick an
 * organization type first, then name the book, via POST /api/books/default.
 *
 * The name field, its validation and the submit state live in the shared
 * `BookCreateForm`; this component contributes the entity pickers, the
 * optional description, and the account preview around it.
 */
export default function NewBookForm({
  onSuccess,
  onCancel,
  showCurrency = true,
  showDescription = false,
  submitLabel = 'Create Book',
  defaultEntityType = 'household',
  defaultBusinessActivity = 'general',
}: NewBookFormProps) {
  const [entityType, setEntityType] = useState<EntityType>(defaultEntityType);
  const [businessActivity, setBusinessActivity] = useState<BusinessActivity>(
    defaultBusinessActivity
  );
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const showActivityPicker = FARM_CAPABLE_ENTITY_TYPES.has(entityType);
  const effectiveActivity = showActivityPicker ? businessActivity : 'general';
  const template = getEntityAccountTemplate(entityType, effectiveActivity);

  const handleCreate = async ({ name, currency }: { name: string; currency: string }) => {
    let res: Response;
    try {
      res = await fetch('/api/books/default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: showDescription && description.trim() ? description.trim() : undefined,
          currency: showCurrency ? currency : undefined,
          entityType,
          entityName: entityType !== 'household' ? name : undefined,
          businessActivity: effectiveActivity,
        }),
      });
    } catch {
      throw new Error('Failed to create book. Please try again.');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(extractErrorMessage(data, 'Failed to create book'));
    }
    const data = await res.json();
    onSuccess(data.bookGuid);
  };

  const entityFields = (
    <>
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

      {showActivityPicker && (
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            Business Activity
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {BUSINESS_ACTIVITY_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  businessActivity === option.value
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border hover:bg-surface-hover/50'
                }`}
              >
                <input
                  type="radio"
                  name="business-activity"
                  checked={businessActivity === option.value}
                  onChange={() => setBusinessActivity(option.value)}
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
      )}
    </>
  );

  const descriptionField = showDescription ? (
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
  ) : null;

  const previewAndError = (
    <>
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

      <ErrorLiveRegion message={error} />
      {error && (
        <div className="px-3 py-2 bg-negative/10 border border-negative/30 rounded-lg text-sm text-negative">
          {error}
        </div>
      )}
    </>
  );

  return (
    <BookCreateForm
      onSubmit={handleCreate}
      onError={(message) => setError(message ?? '')}
      namePlaceholder={entityType === 'household' ? 'e.g. My Finances' : 'e.g. Acme LLC'}
      showCurrency={showCurrency}
      submitLabel={submitLabel}
      onCancel={onCancel}
      beforeNameFields={entityFields}
      afterNameFields={descriptionField}
      afterCurrencyFields={previewAndError}
    />
  );
}
