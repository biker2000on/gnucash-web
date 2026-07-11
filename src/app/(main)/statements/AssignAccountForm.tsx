'use client';

/**
 * Account-assignment form for a parsed-but-unassigned statement batch
 * (e.g. an OFX upload whose <ACCTID> had no remembered mapping yet).
 *
 * PUTs /api/statements/[id]/account { accountGuid }. Used inline on the
 * reconcile page and inside a Modal on the batch list.
 */

import { useState, useCallback } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { useToast } from '@/contexts/ToastContext';

// Reconcilable ledger accounts: banks, cash, plain assets, and credit cards.
export const RECONCILE_ACCOUNT_TYPES = ['BANK', 'CASH', 'ASSET', 'CREDIT', 'LIABILITY'];

export function AssignAccountForm({
  batchId,
  onAssigned,
}: {
  batchId: number;
  onAssigned: () => void;
}) {
  const toast = useToast();
  const [accountGuid, setAccountGuid] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAssign = useCallback(async () => {
    if (!accountGuid) {
      setError('Select the ledger account this statement reconciles.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/statements/${batchId}/account`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountGuid }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Assign failed (HTTP ${res.status})`);
      }
      toast.success('Account assigned.');
      onAssigned();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign account');
    } finally {
      setSaving(false);
    }
  }, [accountGuid, batchId, toast, onAssigned]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 min-w-0">
          <AccountSelector
            value={accountGuid}
            onChange={(guid) => {
              setAccountGuid(guid);
              setError(null);
            }}
            placeholder="Select bank / asset / credit account…"
            accountTypes={RECONCILE_ACCOUNT_TYPES}
            hasError={!!error && !accountGuid}
          />
        </div>
        <button
          onClick={handleAssign}
          disabled={!accountGuid || saving}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2 shrink-0"
        >
          {saving && (
            <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
          )}
          {saving ? 'Assigning…' : 'Assign account'}
        </button>
      </div>
      {error && (
        <div className="text-sm rounded-lg px-3 py-2 bg-[color:var(--negative)]/10 text-[color:var(--negative)] border border-[color:var(--negative)]/30">
          {error}
        </div>
      )}
    </div>
  );
}
