'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useBooks } from '@/contexts/BookContext';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import type { BookFeatureKey } from '@/lib/book-features';

interface ModuleState {
  key: BookFeatureKey;
  label: string;
  description: string;
  enabled: boolean;
  default: boolean;
  overridden: boolean;
}

interface BookFeaturesPayload {
  entityType: string;
  features: Record<string, boolean>;
  modules: ModuleState[];
}

/**
 * "Feature modules" settings card — per-book toggles for the coarse business
 * capabilities (invoicing, membership, …). Defaults come from the book's
 * entity type; admins can override each module. Hidden on household books
 * (the Business nav group is hidden there anyway).
 */
export function BookFeaturesSection() {
  const { success, error: showError } = useToast();
  const { books, activeBookGuid } = useBooks();
  const isAdmin = books.find((b) => b.guid === activeBookGuid)?.role === 'admin';

  const [payload, setPayload] = useState<BookFeaturesPayload | null>(null);
  const [saving, setSaving] = useState<BookFeatureKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/book-features')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data?.modules) setPayload(data);
        })
        .catch(() => { /* card stays hidden on failure */ });
    };
    load();
    // The entity type drives the module defaults — re-resolve after it changes.
    window.addEventListener('entity-updated', load);
    return () => {
      cancelled = true;
      window.removeEventListener('entity-updated', load);
    };
  }, []);

  const applyChange = async (key: BookFeatureKey, value: boolean | null) => {
    setSaving(key);
    try {
      const res = await fetch('/api/book-features', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: { [key]: value } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to save feature modules');
      }
      const data: BookFeaturesPayload = await res.json();
      setPayload(data);
      // Sidebar and hubs react without a refresh.
      window.dispatchEvent(new CustomEvent('book-features-updated'));
      const label = data.modules.find((m) => m.key === key)?.label ?? key;
      success(
        value === null
          ? `${label} reset to default`
          : `${label} ${value ? 'enabled' : 'disabled'} for this book`,
      );
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to save feature modules');
    } finally {
      setSaving(null);
    }
  };

  // Household books hide the Business group entirely — no modules to manage.
  if (!payload || payload.entityType === 'household') return null;

  const enabledCount = payload.modules.filter((m) => m.enabled).length;
  const summary = `${enabledCount} of ${payload.modules.length} enabled`;

  return (
    <CollapsibleConfigSection
      title="Feature modules"
      summary={summary}
      configured
      storageKey="settings.bookFeaturesOpen"
    >
      <div className="space-y-4">
        <p className="text-sm text-foreground-muted">
          Which business capabilities this book shows — in the sidebar, hubs, catalog, and
          command palette. Defaults come from the book&apos;s entity type; changing the entity
          type changes the defaults but keeps any modules you&apos;ve customized here.
        </p>

        {!isAdmin && (
          <p className="text-xs text-foreground-muted border border-border rounded-lg px-3 py-2 bg-background-tertiary">
            Only book admins can change feature modules.
          </p>
        )}

        <div className="space-y-2">
          {payload.modules.map((module) => (
            <div
              key={module.key}
              className="flex flex-wrap items-start justify-between gap-3 p-3 bg-background-tertiary rounded-lg"
            >
              <div className="flex-1 min-w-48">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{module.label}</span>
                  {module.overridden ? (
                    <span className="text-[10px] uppercase tracking-wider font-medium text-primary border border-primary/30 rounded-full px-2 py-0.5">
                      Customized
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider text-foreground-muted border border-border rounded-full px-2 py-0.5">
                      Default
                    </span>
                  )}
                </div>
                <p className="text-xs text-foreground-muted mt-0.5">{module.description}</p>
                {module.overridden && isAdmin && (
                  <button
                    onClick={() => applyChange(module.key, null)}
                    disabled={saving !== null}
                    className="mt-1 text-xs text-primary hover:text-primary-hover disabled:opacity-50 transition-colors"
                  >
                    Reset to default ({module.default ? 'on' : 'off'})
                  </button>
                )}
              </div>
              <label
                className={`flex items-center gap-2 shrink-0 pt-0.5 ${
                  isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'
                }`}
              >
                <input
                  type="checkbox"
                  checked={module.enabled}
                  onChange={(e) => applyChange(module.key, e.target.checked)}
                  disabled={!isAdmin || saving !== null}
                  className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
                />
                <span className="text-sm text-foreground-secondary w-7">
                  {module.enabled ? 'On' : 'Off'}
                </span>
              </label>
            </div>
          ))}
        </div>
      </div>
    </CollapsibleConfigSection>
  );
}
