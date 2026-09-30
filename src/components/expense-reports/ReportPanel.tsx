'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { Modal } from '@/components/ui/Modal';
import { INPUT, LABEL, SELECT, TNUM } from '@/components/ui/form';
import { REPORT_STATUS_LABELS, formatCents } from '@/lib/expense-reports/model';
import {
  loadAccounts,
  reportAction,
  STATUS_CLASS,
  type AccountOption,
  type ApprovalPreview,
  type DepositMatch,
  type LinkOverview,
  type ReportView,
} from './api';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const { primary, className = '', ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      className={`${
        primary
          ? 'bg-primary text-primary-foreground hover:bg-primary-hover font-medium'
          : 'border border-border text-foreground hover:bg-surface-hover'
      } rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${className}`}
    />
  );
}

/** One report: categorize / approve / pay (business) or withdraw / settle (household). */
export function ReportPanel({
  report,
  link,
  canEdit,
  onChanged,
}: {
  report: ReportView;
  link: LinkOverview | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { success, error: showError } = useToast();
  const isBusiness = report.side === 'business';
  const editable = isBusiness && canEdit && report.status === 'submitted';
  const recategorizable = isBusiness && canEdit && report.status === 'posted';

  const [expenseAccounts, setExpenseAccounts] = useState<AccountOption[]>([]);
  const [paymentAccounts, setPaymentAccounts] = useState<AccountOption[]>([]);
  const [depositAccounts, setDepositAccounts] = useState<AccountOption[]>([]);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [remember, setRemember] = useState<Set<number>>(new Set());
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [bulkAccount, setBulkAccount] = useState('');
  const [approval, setApproval] = useState<ApprovalPreview | null>(null);
  const [split, setSplit] = useState<{ lineId: number; parts: Array<{ amount: string; accountGuid: string }> } | null>(null);
  const [pay, setPay] = useState<{ accountGuid: string; date: string } | null>(null);
  const [settle, setSettle] = useState<{ accountGuid: string; date: string; matches: DepositMatch[] | null; matchTxGuid: string } | null>(null);
  const [reject, setReject] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(Object.fromEntries(report.lines.map((l) => [l.id, l.expenseAccountGuid ?? ''])));
    setChecked(new Set());
    setRemember(new Set());
  }, [report]);

  useEffect(() => {
    if (!isBusiness) return;
    loadAccounts(report.businessBookGuid, ['EXPENSE', 'ASSET']).then(setExpenseAccounts).catch(() => undefined);
    loadAccounts(report.businessBookGuid, ['BANK', 'CASH', 'CREDIT']).then(setPaymentAccounts).catch(() => undefined);
  }, [isBusiness, report.businessBookGuid]);

  const canSettle = report.status === 'paid' && (isBusiness ? link?.canEditOtherSide : canEdit);
  useEffect(() => {
    if (!canSettle) return;
    loadAccounts(report.householdBookGuid, ['BANK', 'CASH']).then(setDepositAccounts).catch(() => undefined);
  }, [canSettle, report.householdBookGuid]);

  // Re-preview whenever what approval depends on changes (categories, lines).
  const approvalKey = report.lines.map((l) => `${l.id}:${l.expenseAccountGuid ?? ''}:${l.amountCents}`).join('|');
  const refreshApproval = useCallback(async () => {
    if (!isBusiness || report.status !== 'submitted') {
      setApproval(null);
      return;
    }
    try {
      const data = await reportAction<{ approval: ApprovalPreview }>(report.id, { action: 'approve', dryRun: true });
      setApproval(data.approval);
    } catch {
      setApproval(null);
    }
    // approvalKey is a dependency on purpose: it changes when lines are recategorized or split.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusiness, report.id, report.status, approvalKey]);

  useEffect(() => {
    refreshApproval();
  }, [refreshApproval]);

  const accountName = useMemo(() => new Map(expenseAccounts.map((a) => [a.guid, a.path])), [expenseAccounts]);
  const dirty = report.lines.some((l) => (draft[l.id] ?? '') !== (l.expenseAccountGuid ?? '')) || remember.size > 0;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      success(done);
      onChanged();
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const saveCategories = () =>
    run(async () => {
      const updates = report.lines
        .filter((l) => (draft[l.id] ?? '') !== (l.expenseAccountGuid ?? ''))
        .map((l) => ({ lineId: l.id, expenseAccountGuid: draft[l.id] || null }));
      if (recategorizable) {
        await reportAction(report.id, {
          action: 'recategorize',
          updates: updates.filter((u) => u.expenseAccountGuid),
        });
      } else {
        await reportAction(report.id, { action: 'categorize', updates, rememberLineIds: [...remember] });
      }
    }, recategorizable ? 'Voucher reposted with the new categories' : 'Categories saved');

  const approve = () =>
    run(() => reportAction(report.id, { action: 'approve', postDate: todayIso() }), `${report.label} approved`);

  const doSplit = () => {
    if (!split) return;
    run(async () => {
      await reportAction(report.id, {
        action: 'split',
        lineId: split.lineId,
        parts: split.parts.map((p) => ({ cents: Math.round(Number(p.amount) * 100), expenseAccountGuid: p.accountGuid || null })),
      });
      setSplit(null);
    }, 'Line split');
  };

  const findMatches = async () => {
    if (!settle) return;
    try {
      const data = await reportAction<{ matches: DepositMatch[] }>(report.id, {
        action: 'settle',
        depositAccountGuid: settle.accountGuid,
        date: settle.date,
        dryRun: true,
      });
      setSettle({ ...settle, matches: data.matches, matchTxGuid: data.matches[0]?.txGuid ?? '' });
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not look for deposits');
    }
  };

  const statusBadge = (
    <span className={`rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${STATUS_CLASS[report.status]}`}>
      {REPORT_STATUS_LABELS[report.status]}
    </span>
  );

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">{report.label}{report.title ? ` · ${report.title}` : ''}</h3>
            {statusBadge}
            {report.settlementMode === 'contribution' && (
              <span className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-foreground-secondary">Capital contribution</span>
            )}
          </div>
          <p className="text-xs text-foreground-muted">
            {isBusiness ? `From ${report.householdName}` : `To ${report.businessName}`} · submitted {report.submittedAt.slice(0, 10)}
            {report.paidAt && ` · paid ${report.paidAt.slice(0, 10)}`}
            {report.rejectionReason && ` · rejected: ${report.rejectionReason}`}
          </p>
        </div>
        <span className="font-mono text-lg text-foreground" style={TNUM}>{formatCents(report.totalCents)}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-foreground-secondary">
            <tr>
              {editable && <th className="w-6 px-1 py-1" />}
              <th className="px-2 py-1 text-left">Date</th>
              <th className="px-2 py-1 text-left">Line</th>
              <th className="px-2 py-1 text-right">Amount</th>
              <th className="px-2 py-1 text-left">{isBusiness ? 'Expense account' : 'Categorized as'}</th>
              {editable && <th className="px-2 py-1" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {report.lines.map((l) => (
              <tr key={l.id}>
                {editable && (
                  <td className="px-1 py-1">
                    <input
                      type="checkbox"
                      aria-label={`Select line ${l.description}`}
                      checked={checked.has(l.id)}
                      onChange={() => {
                        const next = new Set(checked);
                        if (next.has(l.id)) next.delete(l.id);
                        else next.add(l.id);
                        setChecked(next);
                      }}
                    />
                  </td>
                )}
                <td className="px-2 py-1 font-mono text-xs text-foreground-secondary" style={TNUM}>{l.expenseDate}</td>
                <td className="px-2 py-1">
                  <div className="text-foreground">{l.description}</div>
                  <div className="text-xs text-foreground-muted">
                    {l.businessPurpose ?? ''}
                    {l.documentIds.length > 0 && `${l.businessPurpose ? ' · ' : ''}${l.documentIds.length} receipt${l.documentIds.length === 1 ? '' : 's'}`}
                    {l.accountablePlan && ' · accountable plan'}
                    {l.late && <span className="text-warning"> · past deadline</span>}
                  </div>
                </td>
                <td className="px-2 py-1 text-right font-mono" style={TNUM}>{formatCents(l.amountCents)}</td>
                <td className="px-2 py-1">
                  {editable || recategorizable ? (
                    <div className="space-y-0.5">
                      <select
                        aria-label={`Expense account for ${l.description}`}
                        className={SELECT}
                        value={draft[l.id] ?? ''}
                        onChange={(e) => setDraft({ ...draft, [l.id]: e.target.value })}
                      >
                        <option value="">{recategorizable ? 'Keep current' : 'Uncategorized'}</option>
                        {expenseAccounts.map((a) => (
                          <option key={a.guid} value={a.guid}>{a.path}</option>
                        ))}
                      </select>
                      <div className="flex items-center gap-2 text-[11px] text-foreground-muted">
                        <span>{l.categorizedByLabel}</span>
                        {editable && draft[l.id] && (
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={remember.has(l.id)}
                              onChange={() => {
                                const next = new Set(remember);
                                if (next.has(l.id)) next.delete(l.id);
                                else next.add(l.id);
                                setRemember(next);
                              }}
                            />
                            Remember for this payee
                          </label>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-foreground-secondary">{l.expenseAccountName ?? 'Uncategorized'}</span>
                  )}
                </td>
                {editable && (
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      className="text-xs text-foreground-secondary hover:text-foreground"
                      onClick={() =>
                        setSplit({
                          lineId: l.id,
                          parts: [
                            { amount: (Math.floor(l.amountCents / 2) / 100).toFixed(2), accountGuid: draft[l.id] ?? '' },
                            { amount: (Math.ceil(l.amountCents / 2) / 100).toFixed(2), accountGuid: '' },
                          ],
                        })
                      }
                    >
                      Split…
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editable && checked.size > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block flex-1">
            <span className={LABEL}>Assign {checked.size} selected line{checked.size === 1 ? '' : 's'} to</span>
            <select className={SELECT} value={bulkAccount} onChange={(e) => setBulkAccount(e.target.value)}>
              <option value="">Choose…</option>
              {expenseAccounts.map((a) => (
                <option key={a.guid} value={a.guid}>{a.path}</option>
              ))}
            </select>
          </label>
          <Button
            disabled={!bulkAccount}
            onClick={() => {
              setDraft({ ...draft, ...Object.fromEntries([...checked].map((id) => [id, bulkAccount])) });
              setChecked(new Set());
            }}
          >
            Apply
          </Button>
        </div>
      )}

      {isBusiness && approval && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">
            Approval preview · {approval.mode === 'contribution' ? 'debit expenses, credit owner contributions' : 'debit expenses, credit A/P (due to owner)'}
          </div>
          <table className="w-full text-sm">
            <tbody>
              {approval.byAccount.map((a) => (
                <tr key={a.accountGuid}>
                  <td className="py-0.5 text-foreground">{accountName.get(a.accountGuid) ?? a.accountGuid}</td>
                  <td className="py-0.5 text-xs text-foreground-muted">{a.lines} line{a.lines === 1 ? '' : 's'}</td>
                  <td className="py-0.5 text-right font-mono" style={TNUM}>{formatCents(a.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {approval.blockers.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-error">
              {approval.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {(editable || recategorizable) && dirty && (
          <Button primary disabled={busy} onClick={saveCategories}>
            {recategorizable ? 'Repost with new categories' : 'Save categories'}
          </Button>
        )}
        {editable && !dirty && (
          <>
            <Button disabled={busy} onClick={() => setReject('')}>Reject…</Button>
            <Button primary disabled={busy || !approval || approval.blockers.length > 0} onClick={approve}>
              Approve {formatCents(report.totalCents)}
            </Button>
          </>
        )}
        {isBusiness && canEdit && report.status === 'posted' && !dirty && (
          <Button primary disabled={busy} onClick={() => setPay({ accountGuid: link?.settings.paymentAccountGuid ?? '', date: todayIso() })}>
            Pay the owner…
          </Button>
        )}
        {!isBusiness && canEdit && report.status === 'submitted' && (
          <Button disabled={busy} onClick={() => run(() => reportAction(report.id, { action: 'withdraw' }), `${report.label} withdrawn`)}>
            Withdraw
          </Button>
        )}
        {canSettle && (
          <Button
            primary
            disabled={busy}
            onClick={() =>
              setSettle({ accountGuid: link?.settings.householdDepositAccountGuid ?? '', date: report.paidAt?.slice(0, 10) ?? todayIso(), matches: null, matchTxGuid: '' })
            }
          >
            Record the reimbursement in {report.householdName}…
          </Button>
        )}
      </div>

      <Modal isOpen={split !== null} onClose={() => setSplit(null)} title="Split a line across accounts" size="lg">
        {split && (
          <div className="space-y-3 p-4">
            {split.parts.map((p, i) => (
              <div key={i} className="flex gap-2">
                <input
                  aria-label={`Part ${i + 1} amount`}
                  className={`${INPUT} w-28 font-mono`}
                  value={p.amount}
                  onChange={(e) => {
                    const parts = [...split.parts];
                    parts[i] = { ...p, amount: e.target.value };
                    setSplit({ ...split, parts });
                  }}
                />
                <select
                  aria-label={`Part ${i + 1} account`}
                  className={SELECT}
                  value={p.accountGuid}
                  onChange={(e) => {
                    const parts = [...split.parts];
                    parts[i] = { ...p, accountGuid: e.target.value };
                    setSplit({ ...split, parts });
                  }}
                >
                  <option value="">Uncategorized</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.guid} value={a.guid}>{a.path}</option>
                  ))}
                </select>
              </div>
            ))}
            <div className="flex justify-between">
              <Button onClick={() => setSplit({ ...split, parts: [...split.parts, { amount: '0.00', accountGuid: '' }] })}>Add part</Button>
              <Button primary disabled={busy} onClick={doSplit}>Split line</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={pay !== null} onClose={() => setPay(null)} title={`Pay ${report.label}`} size="md">
        {pay && (
          <div className="space-y-3 p-4">
            <label className="block">
              <span className={LABEL}>Pay from</span>
              <select className={SELECT} value={pay.accountGuid} onChange={(e) => setPay({ ...pay, accountGuid: e.target.value })}>
                <option value="">Choose…</option>
                {paymentAccounts.map((a) => (
                  <option key={a.guid} value={a.guid}>{a.path}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={LABEL}>Date</span>
              <input type="date" className={INPUT} value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} />
            </label>
            <div className="flex justify-end">
              <Button
                primary
                disabled={busy || !pay.accountGuid}
                onClick={() =>
                  run(async () => {
                    await reportAction(report.id, { action: 'pay', paymentAccountGuid: pay.accountGuid, date: pay.date });
                    setPay(null);
                  }, `${report.label} paid`)
                }
              >
                Pay {formatCents(report.totalCents)}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={settle !== null} onClose={() => setSettle(null)} title={`Record ${report.label} in ${report.householdName}`} size="lg">
        {settle && (
          <div className="space-y-3 p-4">
            <p className="text-sm text-foreground-muted">
              The reimbursement lands in a {report.householdName} account and clears the reimbursable receivable. If your
              bank feed already imported the deposit, match it instead of recording a second one.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>Deposited to</span>
                <select className={SELECT} value={settle.accountGuid} onChange={(e) => setSettle({ ...settle, accountGuid: e.target.value, matches: null })}>
                  <option value="">Choose…</option>
                  {depositAccounts.map((a) => (
                    <option key={a.guid} value={a.guid}>{a.path}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={LABEL}>Date</span>
                <input type="date" className={INPUT} value={settle.date} onChange={(e) => setSettle({ ...settle, date: e.target.value, matches: null })} />
              </label>
            </div>
            {settle.matches === null ? (
              <div className="flex justify-end">
                <Button disabled={!settle.accountGuid} onClick={findMatches}>Look for the deposit</Button>
              </div>
            ) : (
              <div className="space-y-2">
                {settle.matches.map((m) => (
                  <label key={m.txGuid} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
                    <input type="radio" name="deposit-match" checked={settle.matchTxGuid === m.txGuid} onChange={() => setSettle({ ...settle, matchTxGuid: m.txGuid })} />
                    <span className="font-mono text-xs" style={TNUM}>{m.date}</span>
                    <span className="flex-1">{m.description}</span>
                    <span className="text-xs text-foreground-muted">recode {m.counterAccountName} → receivable</span>
                  </label>
                ))}
                <label className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
                  <input type="radio" name="deposit-match" checked={settle.matchTxGuid === ''} onChange={() => setSettle({ ...settle, matchTxGuid: '' })} />
                  Record a new deposit transaction
                </label>
                <div className="flex justify-end">
                  <Button
                    primary
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await reportAction(report.id, {
                          action: 'settle',
                          depositAccountGuid: settle.accountGuid,
                          date: settle.date,
                          matchTxGuid: settle.matchTxGuid || null,
                        });
                        setSettle(null);
                      }, `${report.label} settled`)
                    }
                  >
                    {settle.matchTxGuid ? 'Match deposit' : 'Record deposit'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal isOpen={reject !== null} onClose={() => setReject(null)} title={`Reject ${report.label}`} size="md">
        {reject !== null && (
          <div className="space-y-3 p-4">
            <label className="block">
              <span className={LABEL}>Reason (shown to the owner)</span>
              <input className={INPUT} value={reject} onChange={(e) => setReject(e.target.value)} />
            </label>
            <div className="flex justify-end">
              <Button
                disabled={busy || !reject.trim()}
                onClick={() =>
                  run(async () => {
                    await reportAction(report.id, { action: 'reject', reason: reject });
                    setReject(null);
                  }, `${report.label} rejected`)
                }
              >
                Reject report
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
