import { query } from '@/lib/db';
import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import {
  createScheduledTransaction,
  deleteScheduledTransaction,
  getScheduledTransaction,
  scheduledToInput,
  updateScheduledTransaction,
  validateScheduledTransactionInput,
  type CreateScheduledTxInput,
} from '@/lib/services/scheduled-tx-create';
import {
  approveReimbursement,
  getReimbursement,
  rejectReimbursement,
  undoReimbursementDecision,
} from '@/lib/business/reimbursements';
import { logAudit } from '@/lib/services/audit.service';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { listFinancialActions } from '@/lib/financial-actions/store';

export type DomainCommandType =
  | 'scheduled.create'
  | 'scheduled.update'
  | 'reimbursement.approve'
  | 'reimbursement.reject'
  | 'close.prepare';

export interface DomainCommandDiff {
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

export interface DomainCommandPreview {
  title: string;
  summary: string;
  balanced: boolean;
  balanceDelta: number;
  diff: DomainCommandDiff[];
  facts: string[];
  assumptions: string[];
  warnings: string[];
  evidence: Array<{ label: string; href?: string; kind: string; id: string }>;
  reversible: boolean;
}

export interface DomainCommandRecord {
  id: string;
  bookGuid: string;
  userId: number | null;
  commandType: DomainCommandType;
  status: 'pending' | 'executing' | 'executed' | 'undoing' | 'undone' | 'failed' | 'expired';
  input: Record<string, unknown>;
  preview: DomainCommandPreview;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  undoneAt: string | null;
}

interface CommandRow {
  id: string;
  book_guid: string;
  user_id: number | null;
  command_type: DomainCommandType;
  status: DomainCommandRecord['status'];
  input: Record<string, unknown>;
  preview: DomainCommandPreview;
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  executed_at: Date | string | null;
  undone_at: Date | string | null;
  undo_payload?: Record<string, unknown> | null;
}

export class DomainCommandError extends Error {
  constructor(message: string, readonly code: 'validation' | 'not_found' | 'state' = 'validation') {
    super(message);
  }
}

function timestamp(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: CommandRow): DomainCommandRecord {
  return {
    id: row.id,
    bookGuid: row.book_guid,
    userId: row.user_id,
    commandType: row.command_type,
    status: row.status,
    input: row.input,
    preview: row.preview,
    result: row.result,
    errorMessage: row.error_message,
    createdAt: timestamp(row.created_at)!,
    expiresAt: timestamp(row.expires_at)!,
    executedAt: timestamp(row.executed_at),
    undoneAt: timestamp(row.undone_at),
  };
}

function assertSchedule(value: unknown): CreateScheduledTxInput {
  if (!value || typeof value !== 'object') throw new DomainCommandError('Schedule input is required');
  return value as CreateScheduledTxInput;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function scheduleDiff(
  before: CreateScheduledTxInput | null,
  after: CreateScheduledTxInput,
): DomainCommandDiff[] {
  const fields: Array<keyof CreateScheduledTxInput> = [
    'name', 'startDate', 'endDate', 'autoCreate', 'autoNotify',
  ];
  const diff: DomainCommandDiff[] = fields.flatMap(field => {
    const oldValue = before?.[field] ?? null;
    const newValue = after[field];
    return JSON.stringify(oldValue) === JSON.stringify(newValue)
      ? []
      : [{ field, before: oldValue as string | boolean | null, after: newValue as string | boolean | null }];
  });
  if (!before || JSON.stringify(before.recurrence) !== JSON.stringify(after.recurrence)) {
    diff.push({
      field: 'recurrence',
      before: before ? `${before.recurrence.mult} ${before.recurrence.periodType}` : null,
      after: `${after.recurrence.mult} ${after.recurrence.periodType}`,
    });
  }
  if (!before || JSON.stringify(before.splits) !== JSON.stringify(after.splits)) {
    diff.push({
      field: 'splits',
      before: before ? before.splits.length : 0,
      after: after.splits.length,
    });
  }
  return diff;
}

async function accountEvidence(schedule: CreateScheduledTxInput) {
  const guids = [...new Set(schedule.splits.map(split => split.accountGuid))];
  const rows = await prisma.accounts.findMany({
    where: { guid: { in: guids } },
    select: { guid: true, name: true },
  });
  return rows.map(row => ({
    label: row.name,
    href: `/accounts/${row.guid}`,
    kind: 'account',
    id: row.guid,
  }));
}

async function buildPreview(
  bookGuid: string,
  type: DomainCommandType,
  rawInput: Record<string, unknown>,
): Promise<{ input: Record<string, unknown>; preview: DomainCommandPreview }> {
  if (type === 'scheduled.create') {
    const schedule = assertSchedule(rawInput.schedule ?? rawInput);
    const error = await validateScheduledTransactionInput(schedule, bookGuid);
    if (error) throw new DomainCommandError(error);
    const balanceDelta = schedule.splits.reduce((sum, split) => sum + split.amount, 0);
    return {
      input: { schedule, entityGuid: generateGuid() },
      preview: {
        title: `Create schedule: ${schedule.name}`,
        summary: `Create a ${schedule.recurrence.periodType} GnuCash scheduled transaction with ${schedule.splits.length} balanced splits.`,
        balanced: Math.abs(balanceDelta) <= 0.005,
        balanceDelta,
        diff: scheduleDiff(null, schedule),
        facts: [`Starts ${schedule.startDate}`, `${schedule.splits.length} account splits`],
        assumptions: ['Amounts remain fixed until the schedule is edited.'],
        warnings: [],
        evidence: await accountEvidence(schedule),
        reversible: true,
      },
    };
  }

  if (type === 'scheduled.update') {
    const guid = typeof rawInput.guid === 'string' ? rawInput.guid : '';
    const schedule = assertSchedule(rawInput.schedule);
    const error = await validateScheduledTransactionInput(schedule, bookGuid);
    if (error) throw new DomainCommandError(error);
    const current = await getScheduledTransaction(guid);
    if (!current || !current.recurrence) throw new DomainCommandError('Scheduled transaction not found', 'not_found');
    const scopedAccounts = new Set(await getAccountGuidsForBook(bookGuid));
    if (current.splits.length === 0 || current.splits.some(split => !scopedAccounts.has(split.accountGuid))) {
      throw new DomainCommandError('Scheduled transaction not found', 'not_found');
    }
    const before = scheduledToInput(current);
    const balanceDelta = schedule.splits.reduce((sum, split) => sum + split.amount, 0);
    return {
      input: { guid, schedule, before },
      preview: {
        title: `Update schedule: ${current.name}`,
        summary: `Replace the editable schedule definition while preserving occurrence history and the schedule ID.`,
        balanced: Math.abs(balanceDelta) <= 0.005,
        balanceDelta,
        diff: scheduleDiff(before, schedule),
        facts: [`Existing schedule ${guid}`, `Next definition starts ${schedule.startDate}`],
        assumptions: ['Past generated transactions are not changed.'],
        warnings: current.lastOccur ? [`This schedule last ran on ${current.lastOccur}.`] : [],
        evidence: [
          { label: current.name, href: '/scheduled-transactions', kind: 'scheduled_transaction', id: guid },
          ...await accountEvidence(schedule),
        ],
        reversible: true,
      },
    };
  }

  if (type === 'reimbursement.approve' || type === 'reimbursement.reject') {
    const id = Number(rawInput.id);
    if (!Number.isInteger(id)) throw new DomainCommandError('A reimbursement request ID is required');
    const request = await getReimbursement(id, bookGuid);
    if (!request) throw new DomainCommandError('Reimbursement request not found', 'not_found');
    if (request.status !== 'submitted') throw new DomainCommandError('Only submitted requests can be reviewed', 'state');
    const rejecting = type === 'reimbursement.reject';
    const reason = typeof rawInput.reason === 'string' ? rawInput.reason.trim() : '';
    if (rejecting && !reason) throw new DomainCommandError('A rejection reason is required');
    return {
      input: { id, ...(rejecting ? { reason } : {}) },
      preview: {
        title: `${rejecting ? 'Reject' : 'Approve'} reimbursement #${id}`,
        summary: rejecting
          ? `Return ${request.employeeName}'s ${request.amount.toFixed(2)} request with a reason.`
          : `Create a draft expense voucher for ${request.employeeName}; posting remains a separate approval.`,
        balanced: true,
        balanceDelta: 0,
        diff: [{
          field: 'status',
          before: request.status,
          after: rejecting ? 'rejected' : 'approved',
        }],
        facts: [
          `${request.amount.toFixed(2)} on ${request.expenseDate}`,
          `Expense account: ${request.expenseAccountName}`,
        ],
        assumptions: rejecting ? [] : ['The approver will review and post the generated draft voucher.'],
        warnings: [],
        evidence: [
          ...(request.receiptId ? [{
            label: request.receiptFilename || `Receipt #${request.receiptId}`,
            href: `/receipts?receipt=${request.receiptId}`,
            kind: 'receipt',
            id: String(request.receiptId),
          }] : []),
          { label: request.expenseAccountName, href: `/accounts/${request.expenseAccountGuid}`, kind: 'account', id: request.expenseAccountGuid },
        ],
        reversible: true,
      },
    };
  }

  if (type === 'close.prepare') {
    if (
      rawInput.period !== undefined
      && (typeof rawInput.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawInput.period))
    ) {
      throw new DomainCommandError('Close period must be YYYY-MM');
    }
    const period = typeof rawInput.period === 'string'
      ? rawInput.period
      : new Date().toISOString().slice(0, 7);
    const rows = await query(
      `SELECT
         COUNT(*) FILTER (WHERE state IN ('open','accepted','snoozed'))::int AS open_count,
         COUNT(*) FILTER (WHERE severity = 'critical' AND state IN ('open','accepted','snoozed'))::int AS critical_count
       FROM gnucash_web_financial_actions
       WHERE book_guid = $1`,
      [bookGuid],
    );
    const counts = rows.rows[0] as { open_count: number; critical_count: number };
    return {
      input: { period },
      preview: {
        title: `Prepare close for ${period}`,
        summary: 'Refresh the close workspace and record an auditable preparation run without closing or locking a period.',
        balanced: true,
        balanceDelta: 0,
        diff: [],
        facts: [
          `${counts?.open_count ?? 0} open Action Center items`,
          `${counts?.critical_count ?? 0} critical items`,
        ],
        assumptions: ['A human still approves reconciliation and the final period lock.'],
        warnings: (counts?.critical_count ?? 0) > 0 ? ['Critical actions should be resolved before locking the period.'] : [],
        evidence: [
          { label: 'Financial Action Center', href: '/actions', kind: 'report', id: `actions:${period}` },
          { label: 'Continuous Close', href: '/reports/reconciliation', kind: 'report', id: `close:${period}` },
        ],
        reversible: false,
      },
    };
  }

  throw new DomainCommandError(`Unsupported command type: ${type}`);
}

export async function createDomainCommand(input: {
  bookGuid: string;
  userId: number;
  commandType: DomainCommandType;
  commandInput: Record<string, unknown>;
}): Promise<DomainCommandRecord> {
  const built = await buildPreview(input.bookGuid, input.commandType, input.commandInput);
  if (!built.preview.balanced) throw new DomainCommandError('Command preview is not balanced');
  const id = `cmd_${generateGuid()}`;
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const result = await query(
    `INSERT INTO gnucash_web_domain_commands
      (id, book_guid, user_id, command_type, input, preview, expires_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
     RETURNING *`,
    [
      id,
      input.bookGuid,
      input.userId,
      input.commandType,
      JSON.stringify(built.input),
      JSON.stringify(built.preview),
      expiresAt,
    ],
  );
  return mapRow(result.rows[0] as CommandRow);
}

export async function listDomainCommands(input: {
  bookGuid: string;
  userId: number;
  limit?: number;
}): Promise<DomainCommandRecord[]> {
  const result = await query(
    `SELECT * FROM gnucash_web_domain_commands
     WHERE book_guid = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [input.bookGuid, input.userId, Math.min(Math.max(input.limit ?? 30, 1), 100)],
  );
  return (result.rows as CommandRow[]).map(mapRow);
}

async function getCommandWithUndo(
  id: string,
  bookGuid: string,
  userId: number,
): Promise<CommandRow | null> {
  const result = await query(
    `SELECT * FROM gnucash_web_domain_commands
     WHERE id = $1 AND book_guid = $2 AND user_id = $3`,
    [id, bookGuid, userId],
  );
  return result.rows[0] as CommandRow | undefined ?? null;
}

export async function executeDomainCommand(input: {
  id: string;
  bookGuid: string;
  userId: number;
}): Promise<DomainCommandRecord> {
  const claimed = await query(
    `UPDATE gnucash_web_domain_commands
     SET status = 'executing', error_message = NULL
     WHERE id = $1 AND book_guid = $2 AND user_id = $3
       AND status = 'pending' AND expires_at > NOW()
     RETURNING *`,
    [input.id, input.bookGuid, input.userId],
  );
  const row = claimed.rows[0] as CommandRow | undefined;
  if (!row) {
    const existing = await getCommandWithUndo(input.id, input.bookGuid, input.userId);
    if (!existing) throw new DomainCommandError('Command preview not found', 'not_found');
    if (existing.status === 'executed') return mapRow(existing);
    if (existing.status === 'pending' && new Date(existing.expires_at) <= new Date()) {
      await query(`UPDATE gnucash_web_domain_commands SET status = 'expired' WHERE id = $1`, [input.id]);
      throw new DomainCommandError('Command preview expired; create a new preview', 'state');
    }
    throw new DomainCommandError(`Command cannot execute from status ${existing.status}`, 'state');
  }

  try {
    let result: Record<string, unknown>;
    let undoPayload: Record<string, unknown> | null = null;
    const commandInput = row.input;
    if (row.command_type === 'scheduled.create') {
      const schedule = assertSchedule(commandInput.schedule);
      const entityGuid = String(commandInput.entityGuid);
      const created = await createScheduledTransaction(schedule, { guid: entityGuid, bookGuid: input.bookGuid });
      if (!created.success) throw new Error(created.error);
      result = { guid: created.guid, href: '/scheduled-transactions' };
      undoPayload = { kind: 'scheduled.delete', guid: created.guid };
    } else if (row.command_type === 'scheduled.update') {
      const guid = String(commandInput.guid);
      const current = await getScheduledTransaction(guid);
      if (!current || canonicalJson(scheduledToInput(current)) !== canonicalJson(commandInput.before)) {
        throw new Error('The schedule changed after this preview; create a new preview before approving');
      }
      const updated = await updateScheduledTransaction(guid, assertSchedule(commandInput.schedule), { bookGuid: input.bookGuid });
      if (!updated.success) throw new Error(updated.error);
      result = { guid, href: '/scheduled-transactions' };
      undoPayload = { kind: 'scheduled.restore', guid, schedule: commandInput.before };
    } else if (row.command_type === 'reimbursement.approve') {
      const request = await approveReimbursement({
        id: Number(commandInput.id),
        bookGuid: input.bookGuid,
        approvedBy: input.userId,
      });
      result = { requestId: request.id, voucherGuid: request.voucherGuid, href: '/business/reimbursements' };
      undoPayload = { kind: 'reimbursement.decision', id: request.id };
      await logAudit('UPDATE', 'REIMBURSEMENT', String(request.id), { status: 'submitted' }, request);
    } else if (row.command_type === 'reimbursement.reject') {
      const request = await rejectReimbursement({
        id: Number(commandInput.id),
        bookGuid: input.bookGuid,
        approvedBy: input.userId,
        reason: String(commandInput.reason),
      });
      result = { requestId: request.id, href: '/business/reimbursements' };
      undoPayload = { kind: 'reimbursement.decision', id: request.id };
      await logAudit('UPDATE', 'REIMBURSEMENT', String(request.id), { status: 'submitted' }, request);
    } else {
      const actionList = await listFinancialActions({
        userId: input.userId,
        bookGuid: input.bookGuid,
        bookAccountGuids: await getAccountGuidsForBook(input.bookGuid),
        includeCompleted: false,
        refresh: true,
      });
      result = {
        prepared: true,
        period: commandInput.period,
        openActions: actionList.actions.length,
        criticalActions: actionList.actions.filter(action => action.severity === 'critical').length,
        href: '/actions',
      };
      await logAudit('CREATE', 'DOMAIN_COMMAND', row.id, null, result);
    }
    const saved = await query(
      `UPDATE gnucash_web_domain_commands
       SET status = 'executed', result = $1::jsonb, undo_payload = $2::jsonb,
           executed_at = NOW()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(result), JSON.stringify(undoPayload), row.id],
    );
    return mapRow(saved.rows[0] as CommandRow);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution failed';
    await query(
      `UPDATE gnucash_web_domain_commands
       SET status = 'failed', error_message = $1 WHERE id = $2`,
      [message, row.id],
    );
    throw new DomainCommandError(message, 'state');
  }
}

export async function undoDomainCommand(input: {
  id: string;
  bookGuid: string;
  userId: number;
}): Promise<DomainCommandRecord> {
  const claimed = await query(
    `UPDATE gnucash_web_domain_commands
        SET status = 'undoing'
      WHERE id = $1 AND book_guid = $2 AND user_id = $3
        AND status = 'executed' AND undo_payload IS NOT NULL
      RETURNING *`,
    [input.id, input.bookGuid, input.userId],
  );
  const row = claimed.rows[0] as CommandRow | undefined;
  if (!row) {
    const existing = await getCommandWithUndo(input.id, input.bookGuid, input.userId);
    if (!existing) throw new DomainCommandError('Command not found', 'not_found');
    throw new DomainCommandError('This command is not undoable', 'state');
  }
  try {
    const payload = row.undo_payload!;
    if (payload.kind === 'scheduled.delete') {
      await deleteScheduledTransaction(String(payload.guid));
    } else if (payload.kind === 'scheduled.restore') {
      const current = await getScheduledTransaction(String(payload.guid));
      if (!current || canonicalJson(scheduledToInput(current)) !== canonicalJson(row.input.schedule)) {
        throw new DomainCommandError('The schedule changed after execution and cannot be safely undone', 'state');
      }
      const restored = await updateScheduledTransaction(String(payload.guid), assertSchedule(payload.schedule), { bookGuid: input.bookGuid });
      if (!restored.success) throw new DomainCommandError(restored.error, 'state');
    } else if (payload.kind === 'reimbursement.decision') {
      await undoReimbursementDecision(Number(payload.id), input.bookGuid);
    } else {
      throw new DomainCommandError('This command has no supported undo operation', 'state');
    }
  } catch (error) {
    await query(
      `UPDATE gnucash_web_domain_commands SET status = 'executed' WHERE id = $1 AND status = 'undoing'`,
      [row.id],
    );
    throw error;
  }
  const saved = await query(
    `UPDATE gnucash_web_domain_commands
     SET status = 'undone', undone_at = NOW()
     WHERE id = $1 AND status = 'undoing' RETURNING *`,
    [row.id],
  );
  await logAudit('UPDATE', 'DOMAIN_COMMAND', row.id, row.result ?? {}, { undone: true });
  return mapRow(saved.rows[0] as CommandRow);
}
