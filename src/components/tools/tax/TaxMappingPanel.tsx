'use client';

import { useMemo, useState } from 'react';
import {
  TAX_CATEGORY_GROUPS,
  TAX_CATEGORY_LABELS,
  type TaxCategory,
} from '@/lib/tax/types';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileCard } from '@/components/ui/MobileCard';

export interface MappingAccount {
  guid: string;
  name: string;
  fullname: string;
  accountType: string;
  hidden: boolean;
  placeholder: boolean;
  retirementAccountType: string | null;
}

export interface MappingSuggestion {
  accountGuid: string;
  category: TaxCategory;
  reason: string;
}

interface TaxMappingPanelProps {
  accounts: MappingAccount[];
  mappings: Record<string, TaxCategory>;
  suggestions: MappingSuggestion[];
  saving: boolean;
  onSave: (changes: Array<{ accountGuid: string; taxCategory: TaxCategory | null }>) => Promise<void>;
}

function CategorySelect({
  value,
  onChange,
  className = '',
}: {
  value: TaxCategory | '';
  onChange: (v: TaxCategory | '') => void;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as TaxCategory | '')}
      className={`bg-background-tertiary border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary ${className}`}
    >
      <option value="">— Unmapped —</option>
      {TAX_CATEGORY_GROUPS.map(group => (
        <optgroup key={group.label} label={group.label}>
          {group.categories.map(c => (
            <option key={c} value={c}>
              {TAX_CATEGORY_LABELS[c]}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function TaxMappingPanel({
  accounts,
  mappings,
  suggestions,
  saving,
  onSave,
}: TaxMappingPanelProps) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [showOnlyMapped, setShowOnlyMapped] = useState(false);
  /** Pending local edits not yet saved */
  const [pending, setPending] = useState<Record<string, TaxCategory | null>>({});

  const suggestionByGuid = useMemo(
    () => new Map(suggestions.map(s => [s.accountGuid, s])),
    [suggestions],
  );

  const effectiveCategory = (guid: string): TaxCategory | '' => {
    if (guid in pending) return pending[guid] ?? '';
    return mappings[guid] ?? '';
  };

  const visibleAccounts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return accounts.filter(a => {
      if (a.placeholder) return false;
      if (term && !a.fullname.toLowerCase().includes(term)) return false;
      if (showOnlyMapped && !effectiveCategory(a.guid) && !suggestionByGuid.has(a.guid)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, search, showOnlyMapped, pending, mappings, suggestionByGuid]);

  const pendingCount = Object.keys(pending).length;
  const unacceptedSuggestions = suggestions.filter(
    s => !(s.accountGuid in pending) && !mappings[s.accountGuid],
  );

  const setCategory = (guid: string, category: TaxCategory | '') => {
    setPending(prev => {
      const next = { ...prev };
      const original = mappings[guid] ?? '';
      const value = category === '' ? null : category;
      if ((value ?? '') === original) {
        delete next[guid];
      } else {
        next[guid] = value;
      }
      return next;
    });
  };

  const acceptSuggestion = (s: MappingSuggestion) => setCategory(s.accountGuid, s.category);

  const acceptAllSuggestions = () => {
    setPending(prev => {
      const next = { ...prev };
      for (const s of unacceptedSuggestions) {
        next[s.accountGuid] = s.category;
      }
      return next;
    });
  };

  const handleSave = async () => {
    const changes = Object.entries(pending).map(([accountGuid, taxCategory]) => ({
      accountGuid,
      taxCategory,
    }));
    if (changes.length === 0) return;
    await onSave(changes);
    setPending({});
  };

  return (
    <div className="space-y-3">
      {/* Suggestions banner */}
      {unacceptedSuggestions.length > 0 && (
        <div className="flex items-center justify-between gap-3 bg-secondary-light border border-border rounded-md px-3 py-2">
          <p className="text-xs text-foreground-secondary">
            <span className="text-secondary font-medium">{unacceptedSuggestions.length} suggested mappings</span>{' '}
            based on account names, types, and retirement flags.
          </p>
          <button
            onClick={acceptAllSuggestions}
            className="shrink-0 text-xs font-medium text-secondary hover:text-secondary-hover border border-border rounded-md px-2.5 py-1 transition-colors"
          >
            Accept all
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search accounts..."
          className="flex-1 min-w-[200px] bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-primary"
        />
        <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={showOnlyMapped}
            onChange={e => setShowOnlyMapped(e.target.checked)}
            className="accent-[var(--primary)]"
          />
          Mapped &amp; suggested only
        </label>
        <button
          onClick={handleSave}
          disabled={pendingCount === 0 || saving}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary-hover transition-colors"
        >
          {saving ? 'Saving…' : pendingCount > 0 ? `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}` : 'Saved'}
        </button>
      </div>

      {/* Account list */}
      <div className="border border-border rounded-md overflow-hidden max-h-[480px] overflow-y-auto">
        {isMobile ? (
          <div>
            {visibleAccounts.map(a => {
              const current = effectiveCategory(a.guid);
              const suggestion = suggestionByGuid.get(a.guid);
              const showSuggestion = suggestion && !current;
              const dirty = a.guid in pending;
              return (
                <MobileCard
                  key={a.guid}
                  fields={[
                    {
                      label: 'Account',
                      value: (
                        <span className="font-medium">
                          {a.name}
                          {dirty && (
                            <span className="ml-1.5 align-middle text-[10px] uppercase font-normal text-warning border border-warning/40 rounded px-1 py-px">
                              edited
                            </span>
                          )}
                        </span>
                      ),
                    },
                    {
                      label: 'Type',
                      value: <span className="font-mono text-xs text-foreground-muted">{a.accountType}</span>,
                    },
                    {
                      label: 'Path',
                      value: (
                        <span className="block text-[11px] text-foreground-muted truncate max-w-[220px]" title={a.fullname}>
                          {a.fullname}
                        </span>
                      ),
                    },
                  ]}
                >
                  <div className="mt-2 space-y-2">
                    <CategorySelect
                      value={current}
                      onChange={v => setCategory(a.guid, v)}
                      className={`w-full ${dirty ? 'border-primary' : ''}`}
                    />
                    {showSuggestion && (
                      <button
                        onClick={() => acceptSuggestion(suggestion)}
                        title={suggestion.reason}
                        className="w-full text-left text-[11px] text-secondary hover:text-secondary-hover border border-border rounded px-2 py-1 transition-colors"
                      >
                        Suggest: {TAX_CATEGORY_LABELS[suggestion.category]}
                      </button>
                    )}
                  </div>
                </MobileCard>
              );
            })}
            {visibleAccounts.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-foreground-muted">
                No accounts match.
              </div>
            )}
          </div>
        ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background-tertiary">
            <tr className="text-left text-xs text-foreground-muted">
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium w-24">Type</th>
              <th className="px-3 py-2 font-medium w-64">Tax Category</th>
              <th className="px-3 py-2 font-medium w-32"></th>
            </tr>
          </thead>
          <tbody>
            {visibleAccounts.map(a => {
              const current = effectiveCategory(a.guid);
              const suggestion = suggestionByGuid.get(a.guid);
              const showSuggestion = suggestion && !current;
              const dirty = a.guid in pending;
              return (
                <tr key={a.guid} className="border-t border-border hover:bg-surface-hover">
                  <td className="px-3 py-1.5">
                    <div className="text-foreground text-xs">{a.name}</div>
                    <div className="text-[11px] text-foreground-muted truncate max-w-md">{a.fullname}</div>
                  </td>
                  <td className="px-3 py-1.5 text-[11px] text-foreground-muted font-mono">{a.accountType}</td>
                  <td className="px-3 py-1.5">
                    <CategorySelect
                      value={current}
                      onChange={v => setCategory(a.guid, v)}
                      className={dirty ? 'border-primary' : ''}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    {showSuggestion && (
                      <button
                        onClick={() => acceptSuggestion(suggestion)}
                        title={suggestion.reason}
                        className="text-[11px] text-secondary hover:text-secondary-hover border border-border rounded px-2 py-0.5 transition-colors"
                      >
                        Suggest: {TAX_CATEGORY_LABELS[suggestion.category]}
                      </button>
                    )}
                    {dirty && (
                      <span className="ml-1 text-[10px] uppercase text-warning">edited</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {visibleAccounts.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-foreground-muted">
                  No accounts match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>
      <p className="text-[11px] text-foreground-muted">
        Mapping a parent account automatically covers its children unless a child has its own mapping.
        Map an account to <span className="text-foreground-secondary">Excluded</span> to suppress it explicitly.
      </p>
    </div>
  );
}
