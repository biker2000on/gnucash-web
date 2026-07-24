'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { CommandPreviewCard } from '@/components/domain-commands/CommandPreviewCard';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { formatCurrency } from '@/lib/format';
import type { ReimbursementRequest, ReimbursementStatus } from '@/lib/business/reimbursements';
import type { DomainCommandRecord } from '@/lib/domain-commands';
import type { EmployeeDTO } from '@/lib/business/employees.service';

interface ReceiptOption {
  id: number;
  filename: string;
  extractedData: Record<string, unknown> | null;
  createdAt: string;
}

const STATUS_META: Record<ReimbursementStatus, { label: string; className: string }> = {
  submitted: { label: 'Needs approval', className: 'bg-warning/10 text-warning' },
  approved: { label: 'Voucher draft', className: 'bg-primary-light text-primary' },
  posted: { label: 'Posted', className: 'bg-positive/10 text-positive' },
  rejected: { label: 'Rejected', className: 'bg-negative/10 text-negative' },
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function ReimbursementsPage() {
  const { success, error } = useToast();
  const { user, isReadonly } = useCurrentUser();
  const [requests, setRequests] = useState<ReimbursementRequest[]>([]);
  const [employees, setEmployees] = useState<EmployeeDTO[]>([]);
  const [receipts, setReceipts] = useState<ReceiptOption[]>([]);
  const [selfService, setSelfService] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [status, setStatus] = useState<'all' | ReimbursementStatus>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<number, DomainCommandRecord>>({});
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [employeeGuid, setEmployeeGuid] = useState('');
  const [receiptId, setReceiptId] = useState('');
  const [amount, setAmount] = useState('');
  const [expenseAccountGuid, setExpenseAccountGuid] = useState('');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = status === 'all' ? '' : `?status=${status}`;
      const [requestsRes, optionsRes] = await Promise.all([
        fetch(`/api/business/reimbursements${params}`),
        fetch('/api/business/reimbursements/options'),
      ]);
      const requestData = await requestsRes.json().catch(() => null);
      const optionData = await optionsRes.json().catch(() => null);
      if (!requestsRes.ok) throw new Error(requestData?.error || 'Failed to load reimbursements');
      if (!optionsRes.ok) throw new Error(optionData?.error || 'Failed to load reimbursement options');
      setRequests(requestData.requests ?? []);
      setEmployees(optionData.employees ?? []);
      setReceipts(optionData.receipts ?? []);
      setSelfService(Boolean(optionData.selfService));
      setEmployeeGuid(current => current || optionData.employees?.[0]?.guid || '');
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to load reimbursements');
    } finally {
      setLoading(false);
    }
  }, [error, status]);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => ({
    submitted: requests.filter(item => item.status === 'submitted').length,
    approved: requests.filter(item => item.status === 'approved').length,
    outstanding: requests
      .filter(item => item.status === 'submitted' || item.status === 'approved' || item.status === 'posted')
      .reduce((sum, item) => sum + item.amount, 0),
  }), [requests]);

  const resetForm = () => {
    setReceiptId('');
    setAmount('');
    setExpenseAccountGuid('');
    setDescription('');
    setNotes('');
    setExpenseDate(todayIso());
    setDueDate('');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusyId('submit');
    try {
      const res = await fetch('/api/business/reimbursements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeGuid,
          receiptId: receiptId ? Number(receiptId) : null,
          amount: Number(amount),
          expenseAccountGuid,
          description,
          notes,
          expenseDate,
          dueDate: dueDate || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to submit reimbursement');
      success('Reimbursement submitted for approval');
      setShowForm(false);
      resetForm();
      await load();
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to submit reimbursement');
    } finally {
      setBusyId(null);
    }
  };

  const previewDecision = async (requestId: number, decision: 'approve' | 'reject') => {
    setBusyId(`preview-${requestId}`);
    try {
      const res = await fetch('/api/domain-commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandType: `reimbursement.${decision}`,
          input: { id: requestId, ...(decision === 'reject' ? { reason: rejectReason } : {}) },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to preview decision');
      setPreviews(current => ({ ...current, [requestId]: data.command }));
      setRejectingId(null);
      setRejectReason('');
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to preview decision');
    } finally {
      setBusyId(null);
    }
  };

  const mutateCommand = async (requestId: number, operation: 'execute' | 'undo') => {
    const command = previews[requestId];
    if (!command) return;
    setBusyId(command.id);
    try {
      const res = await fetch(`/api/domain-commands/${command.id}/${operation}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Failed to ${operation} command`);
      setPreviews(current => ({ ...current, [requestId]: data.command }));
      success(operation === 'execute' ? 'Decision recorded' : 'Decision undone');
      await load();
    } catch (err) {
      error(err instanceof Error ? err.message : `Failed to ${operation} command`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employee Reimbursements"
        subtitle="Receipt-backed submission, explicit approval, draft voucher creation, and posting status in one queue."
        actions={(
          <button
            type="button"
            onClick={() => setShowForm(value => !value)}
            disabled={isReadonly}
            title={isReadonly ? READONLY_TOOLTIP : undefined}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {showForm ? 'Close form' : '+ Submit expense'}
          </button>
        )}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['Needs approval', summary.submitted],
          ['Voucher drafts', summary.approved],
          ['Workflow value', formatCurrency(summary.outstanding)],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border border-border bg-surface p-4">
            <p className="text-xs uppercase tracking-widest text-foreground-muted">{label}</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </div>

      {showForm && (
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-primary/30 bg-surface p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-foreground">Submit reimbursable expense</h2>
              <p className="text-xs text-foreground-muted">
                {selfService ? `Submitting as ${user?.username ?? 'employee'}.` : 'Choose the employee who incurred the expense.'}
              </p>
            </div>
            <Link href="/receipts" className="text-xs text-primary">Upload receipt</Link>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs text-foreground-secondary">Employee</label>
              <select
                value={employeeGuid}
                onChange={event => setEmployeeGuid(event.target.value)}
                disabled={selfService}
                className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 text-sm text-foreground disabled:opacity-70"
              >
                {employees.map(employee => (
                  <option key={employee.guid} value={employee.guid}>{employee.name || employee.username}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-foreground-secondary">Receipt</label>
              <select
                value={receiptId}
                onChange={event => {
                  setReceiptId(event.target.value);
                  const receipt = receipts.find(item => item.id === Number(event.target.value));
                  const extractedAmount = receipt?.extractedData?.amount;
                  if (typeof extractedAmount === 'number') setAmount(String(extractedAmount));
                }}
                className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 text-sm text-foreground"
              >
                <option value="">No receipt attached</option>
                {receipts.map(receipt => <option key={receipt.id} value={receipt.id}>{receipt.filename}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-foreground-secondary">Amount</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={event => setAmount(event.target.value)}
                className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 font-mono text-sm text-foreground"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-foreground-secondary">Expense date</label>
              <input
                type="date"
                value={expenseDate}
                onChange={event => setExpenseDate(event.target.value)}
                className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 font-mono text-sm text-foreground"
                required
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-foreground-secondary">Expense account</label>
            <AccountSelector
              value={expenseAccountGuid}
              onChange={guid => setExpenseAccountGuid(guid)}
              accountTypes={['EXPENSE', 'ASSET']}
              placeholder="Select expense account…"
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-foreground-secondary">Description</label>
              <input value={description} onChange={event => setDescription(event.target.value)} className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 text-sm text-foreground" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-foreground-secondary">Payment due date</label>
              <input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 font-mono text-sm text-foreground" />
            </div>
          </div>
          <textarea value={notes} onChange={event => setNotes(event.target.value)} placeholder="Notes for the approver" className="w-full rounded-lg border border-border bg-input-bg px-3 py-2 text-sm text-foreground" />
          <div className="flex justify-end">
            <button type="submit" disabled={busyId === 'submit' || !expenseAccountGuid || !employeeGuid} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {busyId === 'submit' ? 'Submitting…' : 'Submit for approval'}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
        {(['all', 'submitted', 'approved', 'posted', 'rejected'] as const).map(value => (
          <button
            key={value}
            type="button"
            onClick={() => setStatus(value)}
            className={`rounded-md px-3 py-1.5 text-xs capitalize ${status === value ? 'bg-primary-light text-primary' : 'text-foreground-secondary'}`}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {loading && <div className="h-40 animate-pulse rounded-xl border border-border bg-surface" />}
        {!loading && requests.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-foreground-muted">
            No reimbursement requests in this view.
          </div>
        )}
        {requests.map(item => (
          <div key={item.id} className="space-y-3">
            <article className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-foreground-muted">#{item.id}</span>
                    <span className={`rounded-md px-2 py-0.5 text-xs ${STATUS_META[item.status].className}`}>
                      {STATUS_META[item.status].label}
                    </span>
                  </div>
                  <h3 className="mt-1 font-semibold text-foreground">{item.description || item.receiptFilename || 'Employee expense'}</h3>
                  <p className="mt-1 text-sm text-foreground-secondary">
                    {item.employeeName} · {item.expenseAccountName} · <span className="font-mono">{item.expenseDate}</span>
                  </p>
                  {item.rejectionReason && <p className="mt-2 text-xs text-negative">{item.rejectionReason}</p>}
                </div>
                <div className="text-right">
                  <p className="font-mono text-lg font-semibold text-foreground">{formatCurrency(item.amount)}</p>
                  {item.dueDate && <p className="text-xs text-foreground-muted">Due {item.dueDate}</p>}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <div className="flex gap-3">
                  {item.receiptId && <Link href={`/receipts?receipt=${item.receiptId}`} className="text-xs text-primary">Receipt</Link>}
                  {item.voucherGuid && <Link href="/business/vouchers" className="text-xs text-primary">Voucher</Link>}
                </div>
                {item.status === 'submitted' && !selfService && !isReadonly && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void previewDecision(item.id, 'approve')} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">
                      Preview approval
                    </button>
                    <button type="button" onClick={() => setRejectingId(item.id)} className="rounded-md border border-negative/30 px-3 py-1.5 text-xs text-negative">
                      Reject…
                    </button>
                  </div>
                )}
              </div>
              {rejectingId === item.id && (
                <div className="mt-3 flex gap-2 border-t border-border pt-3">
                  <input value={rejectReason} onChange={event => setRejectReason(event.target.value)} placeholder="Reason returned to employee" className="min-w-0 flex-1 rounded-lg border border-border bg-input-bg px-3 py-2 text-sm text-foreground" />
                  <button type="button" onClick={() => void previewDecision(item.id, 'reject')} disabled={!rejectReason.trim()} className="rounded-lg bg-negative px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Preview rejection</button>
                </div>
              )}
            </article>
            {previews[item.id] && (
              <CommandPreviewCard
                command={previews[item.id]}
                busy={busyId === previews[item.id].id}
                onExecute={() => void mutateCommand(item.id, 'execute')}
                onUndo={() => void mutateCommand(item.id, 'undo')}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
