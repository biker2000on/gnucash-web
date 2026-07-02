'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/contexts/ToastContext';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { formatAccountPath } from '@/lib/account-utils';

interface DepreciationScheduleInfo {
  id: number;
  method: string;
  frequency: string;
  isAppreciation: boolean;
  enabled: boolean;
  purchasePrice: number;
  salvageValue: number;
  usefulLifeYears: number;
}

interface FixedAsset {
  guid: string;
  name: string;
  accountPath: string;
  currentBalance: number;
  lastTransactionDate: string | null;
  depreciationSchedule: DepreciationScheduleInfo | null;
}

interface FlatAccount {
  guid: string;
  name: string;
  fullname?: string;
  account_type: string;
}

type SelectionMode = 'parent' | 'manual';

const FIXED_ASSET_SELECTION_KEY = 'fixed_assets.selection';

interface FixedAssetSelection {
  mode: SelectionMode;
  parentGuid: string;
  selectedGuids: string[];
}

function describeSchedule(schedule: DepreciationScheduleInfo): string {
  const kind = schedule.isAppreciation ? 'Appreciation' : 'Depreciation';
  const details = [schedule.method, schedule.frequency]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .map((part) => part.replace(/_/g, ' '));
  const suffix = schedule.enabled ? '' : ' (disabled)';
  return details.length > 0
    ? `${kind} schedule: ${details.join(', ')}${suffix}`
    : `${kind} schedule configured${suffix}`;
}

export default function AssetsPage() {
  const { error: showError } = useToast();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<FlatAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('parent');
  const [parentGuid, setParentGuid] = useState('');
  const [selectedGuids, setSelectedGuids] = useState<string[]>([]);
  const [manualSearch, setManualSearch] = useState('');
  const [assetSearch, setAssetSearch] = useState('');
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectionLoaded, setSelectionLoaded] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);

  useEffect(() => {
    async function fetchSelection() {
      try {
        const res = await fetch(`/api/user/preferences?key=${FIXED_ASSET_SELECTION_KEY}`);
        const data = await res.json();
        const selection = data.preferences?.[FIXED_ASSET_SELECTION_KEY] as Partial<FixedAssetSelection> | undefined;

        if (selection?.mode === 'parent' || selection?.mode === 'manual') {
          setSelectionMode(selection.mode);
        }
        if (typeof selection?.parentGuid === 'string') {
          setParentGuid(selection.parentGuid);
        }
        if (Array.isArray(selection?.selectedGuids)) {
          setSelectedGuids(selection.selectedGuids.filter((guid) => typeof guid === 'string'));
        }
      } catch {
        showError('Failed to load fixed asset selection');
      } finally {
        setSelectionLoaded(true);
      }
    }

    fetchSelection();
  }, [showError]);

  useEffect(() => {
    if (!selectionLoaded) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSavingSelection(true);
      try {
        const selection: FixedAssetSelection = {
          mode: selectionMode,
          parentGuid,
          selectedGuids,
        };
        const res = await fetch('/api/user/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            preferences: {
              [FIXED_ASSET_SELECTION_KEY]: selection,
            },
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Failed to save selection');
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          showError('Failed to save fixed asset selection');
        }
      } finally {
        setSavingSelection(false);
      }
    }, 400);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [parentGuid, selectedGuids, selectionLoaded, selectionMode, showError]);

  useEffect(() => {
    async function fetchAccounts() {
      setAccountsLoading(true);
      try {
        const res = await fetch('/api/accounts?flat=true');
        const data = await res.json();
        if (res.ok) {
          setAccounts(Array.isArray(data) ? data : data.accounts || []);
        } else {
          showError(data.error || 'Failed to load accounts');
        }
      } catch {
        showError('Failed to load accounts');
      } finally {
        setAccountsLoading(false);
      }
    }

    fetchAccounts();
  }, [showError]);

  const fetchAssets = useCallback(async () => {
    const params = new URLSearchParams();
    if (!selectionLoaded) return;

    if (selectionMode === 'parent' && parentGuid) {
      params.set('parentGuid', parentGuid);
    } else if (selectionMode === 'manual' && selectedGuids.length > 0) {
      params.set('accountGuids', selectedGuids.join(','));
    } else {
      setAssets([]);
      setFetchError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/assets/fixed?${params.toString()}`);
      const data = await res.json();
      if (res.ok) {
        setAssets(data.assets || []);
      } else {
        const message = data.error || 'Failed to load fixed assets';
        setFetchError(message);
        showError(message);
      }
    } catch {
      setFetchError('Failed to load fixed assets');
      showError('Failed to load fixed assets');
    } finally {
      setLoading(false);
    }
  }, [parentGuid, selectedGuids, selectionLoaded, selectionMode, showError]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  const assetAccounts = accounts.filter((account) => account.account_type === 'ASSET');
  const filteredAssetAccounts = assetAccounts.filter((account) => {
    const query = manualSearch.trim().toLowerCase();
    if (!query) return true;
    const label = formatAccountPath(account.fullname, account.name).toLowerCase();
    return label.includes(query);
  });

  const selectedAccountSet = new Set(selectedGuids);

  const toggleSelectedAccount = (guid: string) => {
    setSelectedGuids((prev) => (
      prev.includes(guid)
        ? prev.filter((item) => item !== guid)
        : [...prev, guid]
    ));
  };

  const hasSelection = selectionMode === 'parent' ? !!parentGuid : selectedGuids.length > 0;

  const filteredAssets = assets.filter((asset) => {
    const query = assetSearch.trim().toLowerCase();
    if (!query) return true;
    return asset.name.toLowerCase().includes(query) || asset.accountPath.toLowerCase().includes(query);
  });

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-background-tertiary rounded animate-pulse w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-48 bg-background-tertiary rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Fixed Assets</h1>
          <p className="text-foreground-muted mt-1">
            Track and manage fixed asset depreciation and appreciation
          </p>
        </div>
      </header>

      <section className="bg-surface rounded-lg border border-border p-5 space-y-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-foreground">Fixed Asset Source</h2>
            {savingSelection && (
              <span className="text-xs text-foreground-muted">Saving...</span>
            )}
          </div>
          <p className="text-sm text-foreground-muted mt-1">
            Choose the accounts that represent fixed assets. The list starts empty so cash, bank, and other asset accounts are not included accidentally.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className={`block rounded-lg border p-4 cursor-pointer transition-colors ${
            selectionMode === 'parent' ? 'border-primary/50 bg-primary/10' : 'border-border hover:border-border-hover'
          }`}>
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="assetSelectionMode"
                checked={selectionMode === 'parent'}
                onChange={() => setSelectionMode('parent')}
                className="mt-1 w-4 h-4 text-primary bg-background-tertiary border-border-hover focus:ring-primary/50"
              />
              <div>
                <div className="text-sm font-medium text-foreground">Parent fixed asset account</div>
                <p className="text-xs text-foreground-muted mt-1">Include non-placeholder asset accounts under one parent.</p>
              </div>
            </div>
          </label>

          <label className={`block rounded-lg border p-4 cursor-pointer transition-colors ${
            selectionMode === 'manual' ? 'border-primary/50 bg-primary/10' : 'border-border hover:border-border-hover'
          }`}>
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="assetSelectionMode"
                checked={selectionMode === 'manual'}
                onChange={() => setSelectionMode('manual')}
                className="mt-1 w-4 h-4 text-primary bg-background-tertiary border-border-hover focus:ring-primary/50"
              />
              <div>
                <div className="text-sm font-medium text-foreground">Manual account selection</div>
                <p className="text-xs text-foreground-muted mt-1">Add only the specific fixed asset accounts you want analyzed.</p>
              </div>
            </div>
          </label>
        </div>

        {selectionMode === 'parent' ? (
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Parent Account</label>
            <AccountSelector
              value={parentGuid}
              onChange={(guid) => setParentGuid(guid)}
              placeholder="Select a fixed asset parent account..."
              accountTypes={['ASSET']}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
              <label className="block text-sm text-foreground-secondary">
                Fixed Asset Accounts ({selectedGuids.length} selected)
              </label>
              {selectedGuids.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedGuids([])}
                  className="text-sm text-foreground-muted hover:text-foreground transition-colors"
                >
                  Clear selection
                </button>
              )}
            </div>
            <input
              type="text"
              value={manualSearch}
              onChange={(event) => setManualSearch(event.target.value)}
              placeholder="Search asset accounts..."
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
            />
            <div className="max-h-80 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {accountsLoading ? (
                <div className="p-4 text-sm text-foreground-muted">Loading accounts...</div>
              ) : filteredAssetAccounts.length === 0 ? (
                <div className="p-4 text-sm text-foreground-muted">No asset accounts match your search.</div>
              ) : (
                filteredAssetAccounts.map((account) => (
                  <label
                    key={account.guid}
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-surface-hover transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAccountSet.has(account.guid)}
                      onChange={() => toggleSelectedAccount(account.guid)}
                      className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
                    />
                    <span className="text-sm text-foreground-secondary">
                      {formatAccountPath(account.fullname, account.name)}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
      </section>

      {/* Error State */}
      {!loading && fetchError && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-error">{fetchError}</p>
          <button
            type="button"
            onClick={() => fetchAssets()}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-error/40 text-error hover:bg-error/10 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty State */}
      {!loading && !hasSelection && (
        <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
          <svg className="w-12 h-12 mx-auto text-foreground-muted mb-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01" />
          </svg>
          <p className="text-foreground-secondary text-lg mb-2">Choose fixed asset accounts</p>
          <p className="text-foreground-muted">
            Select a parent fixed asset account or manually choose individual asset accounts to begin.
          </p>
        </div>
      )}

      {!loading && !fetchError && hasSelection && assets.length === 0 && (
        <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
          <svg className="w-12 h-12 mx-auto text-foreground-muted mb-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01" />
          </svg>
          <p className="text-foreground-secondary text-lg mb-2">No fixed assets in selection</p>
          <p className="text-foreground-muted">
            The selected source did not include any non-placeholder ASSET accounts.
          </p>
          <p className="text-foreground-muted text-sm mt-2">
            Check that the accounts are of type ASSET and are not marked as placeholders in GnuCash.
          </p>
        </div>
      )}

      {/* Asset Cards */}
      {assets.length > 0 && (
        <div className="space-y-4">
          <input
            type="text"
            value={assetSearch}
            onChange={(event) => setAssetSearch(event.target.value)}
            placeholder="Filter assets by name or account path..."
            aria-label="Filter assets by name or account path"
            className="w-full sm:max-w-sm bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
          />
          {filteredAssets.length === 0 ? (
            <div className="bg-background-secondary rounded-lg p-6 border border-border text-center">
              <p className="text-foreground-muted text-sm">
                No assets match &ldquo;{assetSearch.trim()}&rdquo;.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredAssets.map((asset) => (
                <Link
                  key={asset.guid}
                  href={`/assets/${asset.guid}`}
                  className="block bg-background-secondary rounded-lg border border-border p-5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 transition-all duration-200 group"
                >
                  {/* Name & Path */}
                  <div className="mb-3">
                    <h3 className="text-lg font-semibold text-foreground group-hover:text-primary transition-colors">
                      {asset.name}
                    </h3>
                    <p className="text-sm text-foreground-muted truncate">
                      {asset.accountPath}
                    </p>
                  </div>

                  {/* Balance */}
                  <div className="mb-3">
                    <p className="text-2xl font-bold text-foreground">
                      {formatCurrency(asset.currentBalance)}
                    </p>
                    <p className="text-xs text-foreground-muted">Current Value</p>
                  </div>

                  {/* Footer Info */}
                  <div className="flex items-center justify-between text-sm">
                    <div>
                      {asset.lastTransactionDate ? (
                        <span className="text-foreground-secondary">
                          Last activity: {asset.lastTransactionDate}
                        </span>
                      ) : (
                        <span className="text-foreground-muted">No transactions</span>
                      )}
                    </div>
                    <div>
                      {asset.depreciationSchedule ? (
                        <span
                          title={describeSchedule(asset.depreciationSchedule)}
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            asset.depreciationSchedule.enabled
                              ? asset.depreciationSchedule.isAppreciation
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : 'bg-amber-500/20 text-amber-400'
                              : 'bg-gray-500/20 text-gray-400'
                          }`}
                        >
                          {asset.depreciationSchedule.isAppreciation ? 'Appreciating' : 'Depreciating'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/20 text-gray-400">
                          No schedule
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
