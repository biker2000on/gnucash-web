'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';

interface SimpleFinAccount {
  id: string;
  name: string;
  institution: string | null;
  currency: string;
  balance: string;
  availableBalance: string | null;
  gnucashAccountGuid: string | null;
  lastSyncAt: string | null;
  isMapped: boolean;
  hasHoldings: boolean;
  isInvestment: boolean;
}

interface SyncResult {
  success: boolean;
  accountsProcessed: number;
  transactionsImported: number;
  transactionsSkipped: number;
  errors: { account: string; error: string }[];
}

export default function ConnectionsPage() {
  const { success, error: showError } = useToast();

  const [simplefinConnected, setSimplefinConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  // SimpleFin connection state
  const [sfAccounts, setSfAccounts] = useState<SimpleFinAccount[]>([]);
  const [sfSetupToken, setSfSetupToken] = useState('');
  const [sfConnecting, setSfConnecting] = useState(false);
  const [sfSyncing, setSfSyncing] = useState(false);
  const [sfDisconnectOpen, setSfDisconnectOpen] = useState(false);
  const [sfDisconnecting, setSfDisconnecting] = useState(false);
  const [sfSyncResult, setSfSyncResult] = useState<SyncResult | null>(null);
  const [sfLastSyncAt, setSfLastSyncAt] = useState<string | null>(null);
  const [sfAccountsTotal, setSfAccountsTotal] = useState(0);
  const [sfAccountsMapped, setSfAccountsMapped] = useState(0);

  const fetchSimplefinStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/simplefin/status');
      if (res.ok) {
        const data = await res.json();
        setSimplefinConnected(data.connected);
        setSfLastSyncAt(data.lastSyncAt ?? null);
        setSfAccountsTotal(data.accountsTotal ?? 0);
        setSfAccountsMapped(data.accountsMapped ?? 0);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSimplefinAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/simplefin/accounts');
      if (res.ok) {
        const data = await res.json();
        const accounts = (data.accounts || []).map((a: SimpleFinAccount) => ({
          ...a,
          isInvestment: a.isInvestment || (a.hasHoldings && !a.isMapped),
        }));
        setSfAccounts(accounts);
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchSimplefinStatus();
  }, [fetchSimplefinStatus]);

  useEffect(() => {
    if (simplefinConnected) {
      fetchSimplefinAccounts();
    }
  }, [simplefinConnected, fetchSimplefinAccounts]);

  const handleSfConnect = async () => {
    if (!sfSetupToken.trim()) {
      showError('Please enter a setup token');
      return;
    }
    setSfConnecting(true);
    try {
      const res = await fetch('/api/simplefin/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupToken: sfSetupToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Failed to connect');
        return;
      }
      success('SimpleFin connected successfully');
      setSfSetupToken('');
      await fetchSimplefinStatus();
    } catch {
      showError('Failed to connect to SimpleFin');
    } finally {
      setSfConnecting(false);
    }
  };

  const handleSfMapAccount = async (sfAccountId: string, gnucashGuid: string, sfAccount: SimpleFinAccount) => {
    try {
      const res = await fetch('/api/simplefin/accounts/map', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [{
            simpleFinAccountId: sfAccountId,
            simpleFinAccountName: sfAccount.name,
            simpleFinInstitution: sfAccount.institution,
            gnucashAccountGuid: gnucashGuid || null,
            isInvestment: sfAccount.isInvestment,
          }],
        }),
      });
      if (res.ok) {
        success('Account mapping updated');
        setSfAccounts(prev => prev.map(a =>
          a.id === sfAccountId
            ? { ...a, gnucashAccountGuid: gnucashGuid || null, isMapped: !!gnucashGuid }
            : a
        ));
      } else {
        showError('Failed to update mapping');
      }
    } catch {
      showError('Failed to update mapping');
    }
  };

  const handleSfToggleInvestment = async (sfAccountId: string, isInvestment: boolean, sfAccount: SimpleFinAccount) => {
    try {
      const res = await fetch('/api/simplefin/accounts/map', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: [{
            simpleFinAccountId: sfAccountId,
            simpleFinAccountName: sfAccount.name,
            simpleFinInstitution: sfAccount.institution,
            gnucashAccountGuid: sfAccount.gnucashAccountGuid,
            isInvestment,
          }],
        }),
      });
      if (res.ok) {
        setSfAccounts(prev => prev.map(a =>
          a.id === sfAccountId ? { ...a, isInvestment } : a
        ));
      } else {
        showError('Failed to update investment setting');
      }
    } catch {
      showError('Failed to update investment setting');
    }
  };

  const handleSfSync = async () => {
    setSfSyncing(true);
    setSfSyncResult(null);
    try {
      const res = await fetch('/api/simplefin/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Sync failed');
        return;
      }
      if (data.direct) {
        setSfSyncResult(data);
        success(`Imported ${data.transactionsImported} transactions, skipped ${data.transactionsSkipped} duplicates`);
      } else {
        success('Sync job queued');
      }
      await fetchSimplefinStatus();
    } catch {
      showError('Failed to sync');
    } finally {
      setSfSyncing(false);
    }
  };

  const handleSfDisconnect = async () => {
    setSfDisconnecting(true);
    try {
      const res = await fetch('/api/simplefin/disconnect', { method: 'DELETE' });
      if (res.ok) {
        success('SimpleFin disconnected');
        setSimplefinConnected(false);
        setSfAccounts([]);
        setSfSyncResult(null);
      } else {
        showError('Failed to disconnect');
      }
    } catch {
      showError('Failed to disconnect');
    } finally {
      setSfDisconnecting(false);
      setSfDisconnectOpen(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
          <span className="text-foreground-secondary">Loading connections...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Connections</h1>

      {/* Bank Connections (SimpleFin) */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-2">Bank Connections</h2>
        <p className="text-sm text-foreground-muted mb-4">
          Connect your bank accounts via <a href="https://beta-bridge.simplefin.org" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300">SimpleFin Bridge</a> to automatically import transactions.
        </p>

        {!simplefinConnected ? (
          <div className="space-y-4">
            <div className="text-sm text-foreground-secondary space-y-2">
              <ol className="list-decimal list-inside space-y-1 text-foreground-muted">
                <li>Visit <a href="https://beta-bridge.simplefin.org" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300">SimpleFin Bridge</a> and create an account ($1.50/month)</li>
                <li>Connect your banks through their secure portal</li>
                <li>Generate a setup token</li>
                <li>Paste the token below</li>
              </ol>
            </div>

            <div className="flex gap-3">
              <input
                type="text"
                value={sfSetupToken}
                onChange={(e) => setSfSetupToken(e.target.value)}
                placeholder="Paste your SimpleFin setup token..."
                className="flex-1 bg-input-bg border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-cyan-500/50"
              />
              <button
                onClick={handleSfConnect}
                disabled={sfConnecting || !sfSetupToken.trim()}
                className="px-6 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-lg transition-colors font-medium flex items-center gap-2"
              >
                {sfConnecting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Status */}
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  <span className="text-sm font-medium text-foreground">Connected</span>
                </div>
                <p className="text-xs text-foreground-muted">
                  {sfLastSyncAt
                    ? `Last sync: ${new Date(sfLastSyncAt).toLocaleString()}`
                    : 'Never synced'}
                  {' | '}
                  {sfAccountsMapped}/{sfAccountsTotal} accounts mapped
                </p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href="https://beta-bridge.simplefin.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 text-xs border border-border rounded-lg text-foreground-muted hover:text-foreground transition-colors"
                >
                  Manage on SimpleFin
                </a>
                <button
                  onClick={handleSfSync}
                  disabled={sfSyncing}
                  className="px-4 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-lg transition-colors font-medium flex items-center gap-2"
                >
                  {sfSyncing ? (
                    <>
                      <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Syncing...
                    </>
                  ) : (
                    'Sync Now'
                  )}
                </button>
                <button
                  onClick={() => setSfDisconnectOpen(true)}
                  className="px-3 py-1.5 text-xs border border-red-500/30 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            </div>

            {/* Sync Results */}
            {sfSyncResult && (
              <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
                <p className="text-sm text-emerald-400 font-medium">
                  Imported {sfSyncResult.transactionsImported} transactions, skipped {sfSyncResult.transactionsSkipped} duplicates
                  ({sfSyncResult.accountsProcessed} accounts processed)
                </p>
                {sfSyncResult.errors.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs text-amber-400 cursor-pointer">
                      {sfSyncResult.errors.length} error(s)
                    </summary>
                    <ul className="mt-1 text-xs text-foreground-muted space-y-1">
                      {sfSyncResult.errors.map((err, i) => (
                        <li key={i}>{err.account}: {err.error}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {/* Account Mapping */}
            {sfAccounts.length > 0 && (
              <div className="border border-border/50 rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-background-tertiary/50 border-b border-border/50">
                  <h3 className="text-sm font-medium text-foreground-secondary">Account Mapping</h3>
                </div>
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.2em] text-foreground-muted font-bold">
                      <th className="px-4 py-2">Bank Account</th>
                      <th className="px-4 py-2">GnuCash Account</th>
                      <th className="px-4 py-2 w-20">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {sfAccounts.map(account => (
                      <tr key={account.id} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-2">
                          <div className="text-sm text-foreground">{account.name}</div>
                          <div className="text-xs text-foreground-muted">
                            {account.institution && <span>{account.institution} | </span>}
                            {account.currency} | {account.balance}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <AccountSelector
                            value={account.gnucashAccountGuid || ''}
                            onChange={(guid) => handleSfMapAccount(account.id, guid, account)}
                            placeholder="Select account..."
                          />
                          {account.isMapped && (
                            <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={account.isInvestment}
                                onChange={(e) => handleSfToggleInvestment(account.id, e.target.checked, account)}
                                className="w-3 h-3 text-cyan-500 bg-background-tertiary border-border-hover rounded focus:ring-cyan-500/50"
                              />
                              <span className="text-[10px] text-foreground-muted">
                                Investment (routes to child accounts by symbol)
                              </span>
                            </label>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {account.isMapped ? (
                            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              Mapped
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              Unmapped
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sfAccounts.length === 0 && (
              <p className="text-sm text-foreground-muted text-center py-4">
                No bank accounts found. Make sure you have connected banks on{' '}
                <a href="https://beta-bridge.simplefin.org" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300">
                  SimpleFin Bridge
                </a>.
              </p>
            )}

            <ConfirmationDialog
              isOpen={sfDisconnectOpen}
              onConfirm={handleSfDisconnect}
              onCancel={() => setSfDisconnectOpen(false)}
              title="Disconnect SimpleFin"
              message="This will remove your SimpleFin connection and all account mappings. Previously imported transactions will not be affected."
              confirmLabel="Disconnect"
              confirmVariant="danger"
              isLoading={sfDisconnecting}
            />
          </div>
        )}
      </div>
    </div>
  );
}
