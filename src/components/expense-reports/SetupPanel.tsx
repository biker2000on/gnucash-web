'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { INPUT, LABEL, SELECT } from '@/components/ui/form';
import { api, loadAccounts, type AccountOption, type LinkOverview, type Settings } from './api';

/**
 * Link setup: which household account holds reimbursable charges, the
 * owner's employee record in the business, and how reports settle. Fields
 * for the book the user cannot edit are shown read-only.
 */
export function SetupPanel({
  link,
  canEditActive,
  onSaved,
}: {
  link: LinkOverview;
  canEditActive: boolean;
  onSaved: (settings: Settings) => void;
}) {
  const { success, error: showError } = useToast();
  const s = link.settings;
  const canHousehold = link.side === 'household' ? canEditActive : link.canEditOtherSide;
  const canBusiness = link.side === 'business' ? canEditActive : link.canEditOtherSide;

  const [householdAccounts, setHouseholdAccounts] = useState<AccountOption[]>([]);
  const [businessAccounts, setBusinessAccounts] = useState<AccountOption[]>([]);
  const [employees, setEmployees] = useState<Array<{ guid: string; name: string }>>([]);
  const [draft, setDraft] = useState(s);
  const [ownerName, setOwnerName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(link.settings), [link.settings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [h, b, e] = await Promise.all([
          loadAccounts(link.householdBookGuid, ['RECEIVABLE', 'ASSET', 'BANK', 'CASH', 'EQUITY']).catch(() => []),
          loadAccounts(link.businessBookGuid, ['EQUITY', 'BANK', 'CASH', 'CREDIT']).catch(() => []),
          api<{ employees: Array<{ guid: string; name: string }> }>(
            `/api/expense-reports/accounts?book=${link.businessBookGuid}&employees=1`,
          ).then((r) => r.employees).catch(() => []),
        ]);
        if (!cancelled) {
          setHouseholdAccounts(h);
          setBusinessAccounts(b);
          setEmployees(e);
        }
      } catch {
        /* pickers stay empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [link.householdBookGuid, link.businessBookGuid]);

  const accountsOf = (list: AccountOption[], types: string[]) => list.filter((a) => types.includes(a.type));
  const configured = Boolean(s.reimbursableAccountGuid && (s.employeeGuid || s.settlementMode === 'contribution'));
  const corporate = /S-corp|C-corp/.test(link.businessStatus) || /S-corp|C-corp/.test(link.nextStatusChange?.description ?? '');

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api<Settings>('/api/expense-reports/settings', {
        method: 'PUT',
        json: {
          businessBookGuid: link.businessBookGuid,
          householdBookGuid: link.householdBookGuid,
          ...(canHousehold
            ? {
                reimbursableAccountGuid: draft.reimbursableAccountGuid,
                reportSince: draft.reportSince,
                householdInvestmentAccountGuid: draft.householdInvestmentAccountGuid,
                householdDepositAccountGuid: draft.householdDepositAccountGuid,
              }
            : {}),
          ...(canBusiness
            ? {
                employeeGuid: draft.employeeGuid,
                settlementMode: draft.settlementMode,
                contributionAccountGuid: draft.contributionAccountGuid,
                paymentAccountGuid: draft.paymentAccountGuid,
                submissionDeadlineDays: draft.submissionDeadlineDays,
              }
            : {}),
        },
      });
      success('Expense report setup saved');
      onSaved(saved);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const createOwner = async () => {
    setBusy(true);
    try {
      const saved = await api<Settings>('/api/expense-reports/settings', {
        json: { businessBookGuid: link.businessBookGuid, householdBookGuid: link.householdBookGuid, ownerName },
      });
      success(`Created ${ownerName} as an employee of ${link.businessName}`);
      setOwnerName('');
      onSaved(saved);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to create the employee');
    } finally {
      setBusy(false);
    }
  };

  const select = (
    label: string,
    value: string | null,
    options: AccountOption[] | Array<{ guid: string; name: string }>,
    onChange: (v: string | null) => void,
    enabled: boolean,
  ) => (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <select
        className={SELECT}
        value={value ?? ''}
        disabled={!enabled}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Not set</option>
        {options.map((o) => (
          <option key={o.guid} value={o.guid}>
            {'path' in o ? o.path : o.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <CollapsibleConfigSection
      title={`Setup · ${link.businessName} ⇄ ${link.householdName}`}
      summary={configured ? `${s.settlementMode === 'contribution' ? 'Capital contribution' : 'Reimburse'} · deadline ${s.submissionDeadlineDays} days` : 'Not configured'}
      configured={configured}
      storageKey={`expenseReports.setup.${link.businessBookGuid}.${link.householdBookGuid}`}
    >
      <div className="space-y-4">
        <p className="text-sm text-foreground-muted">
          {link.businessName} is {link.businessStatus}
          {link.nextStatusChange
            ? `; from ${link.nextStatusChange.effectiveFrom} it will be ${link.nextStatusChange.description}.`
            : '.'}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {select(
            `Reimbursable account (${link.householdName})`,
            draft.reimbursableAccountGuid,
            accountsOf(householdAccounts, ['RECEIVABLE', 'ASSET']),
            (v) => setDraft({ ...draft, reimbursableAccountGuid: v }),
            canHousehold,
          )}
          <label className="block">
            <span className={LABEL}>Report charges dated on or after</span>
            <input
              type="date"
              className={INPUT}
              value={draft.reportSince ?? ''}
              disabled={!canHousehold}
              onChange={(e) => setDraft({ ...draft, reportSince: e.target.value || null })}
            />
            <span className="mt-1 block text-xs text-foreground-muted">
              Leave empty to include every charge. Set it when the account holds older charges that were already
              reimbursed by hand.
            </span>
          </label>
          {select(
            `Owner employee (${link.businessName})`,
            draft.employeeGuid,
            employees,
            (v) => setDraft({ ...draft, employeeGuid: v }),
            canBusiness,
          )}
          <label className="block">
            <span className={LABEL}>Settlement</span>
            <select
              className={SELECT}
              value={draft.settlementMode}
              disabled={!canBusiness}
              onChange={(e) => setDraft({ ...draft, settlementMode: e.target.value as Settings['settlementMode'] })}
            >
              <option value="reimburse">Reimburse the owner (voucher → A/P → payment)</option>
              <option value="contribution">Treat as capital contribution (no cash moves)</option>
            </select>
          </label>
          <label className="block">
            <span className={LABEL}>Submission deadline (days after the expense)</span>
            <input
              type="number"
              min={1}
              max={365}
              className={INPUT}
              value={draft.submissionDeadlineDays}
              disabled={!canBusiness}
              onChange={(e) => setDraft({ ...draft, submissionDeadlineDays: Number(e.target.value) || 60 })}
            />
          </label>
          {draft.settlementMode === 'contribution' && (
            <>
              {select(
                `Owner contributions (${link.businessName})`,
                draft.contributionAccountGuid,
                accountsOf(businessAccounts, ['EQUITY']),
                (v) => setDraft({ ...draft, contributionAccountGuid: v }),
                canBusiness,
              )}
              {select(
                `Owner investment in the business (${link.householdName})`,
                draft.householdInvestmentAccountGuid,
                accountsOf(householdAccounts, ['EQUITY', 'ASSET']),
                (v) => setDraft({ ...draft, householdInvestmentAccountGuid: v }),
                canHousehold,
              )}
            </>
          )}
          {select(
            `Reimbursements arrive in (${link.householdName})`,
            draft.householdDepositAccountGuid,
            accountsOf(householdAccounts, ['BANK', 'CASH']),
            (v) => setDraft({ ...draft, householdDepositAccountGuid: v }),
            canHousehold,
          )}
          {select(
            `Pay reimbursements from (${link.businessName})`,
            draft.paymentAccountGuid,
            accountsOf(businessAccounts, ['BANK', 'CASH', 'CREDIT']),
            (v) => setDraft({ ...draft, paymentAccountGuid: v }),
            canBusiness,
          )}
        </div>

        {draft.settlementMode === 'contribution' && corporate && (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
            {link.businessName} is (or will be) taxed as a corporation. An owner-employee&apos;s
            personally paid expenses are deductible only when the business reimburses them under an
            accountable plan, so lines dated while it is a corporation cannot be settled as a capital
            contribution — that would forfeit the deduction. Use reimbursement for those reports.
          </p>
        )}

        {canBusiness && !draft.employeeGuid && (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
            <label className="block flex-1">
              <span className={LABEL}>Create the owner as an employee of {link.businessName}</span>
              <input
                className={INPUT}
                placeholder="Owner's name"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !ownerName.trim()}
              onClick={createOwner}
              className="rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-hover disabled:opacity-50"
            >
              Create employee
            </button>
          </div>
        )}

        {(canHousehold || canBusiness) && (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save setup'}
            </button>
          </div>
        )}
      </div>
    </CollapsibleConfigSection>
  );
}
