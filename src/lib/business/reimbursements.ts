import { query, withDatabaseAdvisoryLock } from '@/lib/db';
import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { createVoucher, deleteVoucher, getVoucher } from '@/lib/business/vouchers';
import { OWNER_TYPE_EMPLOYEE } from '@/lib/business/invoice-engine';
import { logAudit } from '@/lib/services/audit.service';

export type ReimbursementStatus = 'submitted' | 'approved' | 'posted' | 'rejected';

export interface ReimbursementRequest {
  id: number;
  bookGuid: string;
  receiptId: number | null;
  receiptFilename: string | null;
  employeeGuid: string;
  employeeName: string;
  submittedBy: number | null;
  approvedBy: number | null;
  status: ReimbursementStatus;
  amount: number;
  expenseAccountGuid: string;
  expenseAccountName: string;
  description: string;
  notes: string;
  expenseDate: string;
  dueDate: string | null;
  voucherGuid: string | null;
  rejectionReason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  postedAt: string | null;
}

interface ReimbursementRow {
  id: number;
  book_guid: string;
  receipt_id: number | null;
  receipt_filename: string | null;
  employee_guid: string;
  employee_name: string | null;
  employee_username: string;
  submitted_by: number | null;
  approved_by: number | null;
  status: ReimbursementStatus;
  amount: string | number;
  expense_account_guid: string;
  expense_account_name: string;
  description: string | null;
  notes: string | null;
  expense_date: Date | string;
  due_date: Date | string | null;
  voucher_guid: string | null;
  rejection_reason: string | null;
  submitted_at: Date | string;
  reviewed_at: Date | string | null;
  posted_at: Date | string | null;
}

function dateOnly(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dateTime(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function mapRow(row: ReimbursementRow): ReimbursementRequest {
  return {
    id: row.id,
    bookGuid: row.book_guid,
    receiptId: row.receipt_id,
    receiptFilename: row.receipt_filename,
    employeeGuid: row.employee_guid,
    employeeName: row.employee_name || row.employee_username,
    submittedBy: row.submitted_by,
    approvedBy: row.approved_by,
    status: row.status,
    amount: Number(row.amount),
    expenseAccountGuid: row.expense_account_guid,
    expenseAccountName: row.expense_account_name,
    description: row.description ?? '',
    notes: row.notes ?? '',
    expenseDate: dateOnly(row.expense_date)!,
    dueDate: dateOnly(row.due_date),
    voucherGuid: row.voucher_guid,
    rejectionReason: row.rejection_reason,
    submittedAt: dateTime(row.submitted_at)!,
    reviewedAt: dateTime(row.reviewed_at),
    postedAt: dateTime(row.posted_at),
  };
}

const SELECT_REIMBURSEMENTS = `
  SELECT r.*,
         rec.filename AS receipt_filename,
         COALESCE(e.addr_name, e.username) AS employee_name,
         e.username AS employee_username,
         a.name AS expense_account_name
  FROM gnucash_web_reimbursement_requests r
  JOIN employees e ON e.guid = r.employee_guid
  JOIN accounts a ON a.guid = r.expense_account_guid
  LEFT JOIN gnucash_web_receipts rec ON rec.id = r.receipt_id
`;

export class ReimbursementValidationError extends Error {}
export class ReimbursementStateError extends Error {}

export async function employeeForUsername(username: string): Promise<string | null> {
  const row = await prisma.employees.findFirst({
    where: { username: { equals: username, mode: 'insensitive' } },
    select: { guid: true },
  });
  return row?.guid ?? null;
}

export async function listReimbursements(input: {
  bookGuid: string;
  status?: ReimbursementStatus;
  employeeGuid?: string;
}): Promise<ReimbursementRequest[]> {
  const values: unknown[] = [input.bookGuid];
  const conditions = ['r.book_guid = $1'];
  if (input.status) {
    values.push(input.status);
    conditions.push(`r.status = $${values.length}`);
  }
  if (input.employeeGuid) {
    values.push(input.employeeGuid);
    conditions.push(`r.employee_guid = $${values.length}`);
  }
  const result = await query(
    `${SELECT_REIMBURSEMENTS}
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE r.status WHEN 'submitted' THEN 0 WHEN 'approved' THEN 1 WHEN 'posted' THEN 2 ELSE 3 END,
       r.submitted_at DESC`,
    values,
  );
  return (result.rows as ReimbursementRow[]).map(mapRow);
}

export async function getReimbursement(
  id: number,
  bookGuid: string,
): Promise<ReimbursementRequest | null> {
  const result = await query(
    `${SELECT_REIMBURSEMENTS} WHERE r.id = $1 AND r.book_guid = $2`,
    [id, bookGuid],
  );
  return result.rows[0] ? mapRow(result.rows[0] as ReimbursementRow) : null;
}

export async function submitReimbursement(input: {
  bookGuid: string;
  submittedBy: number;
  receiptCreatedBy?: number;
  employeeGuid: string;
  receiptId?: number | null;
  amount: number;
  expenseAccountGuid: string;
  description?: string;
  notes?: string;
  expenseDate: string;
  dueDate?: string | null;
}): Promise<ReimbursementRequest> {
  if (!(input.amount > 0) || !Number.isFinite(input.amount)) {
    throw new ReimbursementValidationError('Amount must be greater than zero');
  }
  if (!validDateOnly(input.expenseDate)) {
    throw new ReimbursementValidationError('Expense date must be YYYY-MM-DD');
  }
  if (input.dueDate && !validDateOnly(input.dueDate)) {
    throw new ReimbursementValidationError('Due date must be YYYY-MM-DD');
  }
  const [employee, accountGuids] = await Promise.all([
    prisma.employees.findUnique({ where: { guid: input.employeeGuid }, select: { guid: true, active: true } }),
    getAccountGuidsForBook(input.bookGuid),
  ]);
  if (!employee || employee.active !== 1) {
    throw new ReimbursementValidationError('Select an active employee');
  }
  if (!accountGuids.includes(input.expenseAccountGuid)) {
    throw new ReimbursementValidationError('Expense account is not in the active book');
  }
  if (input.receiptId != null) {
    const receiptValues: unknown[] = [input.receiptId, input.bookGuid];
    const createdByClause = input.receiptCreatedBy == null
      ? ''
      : ` AND created_by = $${receiptValues.push(input.receiptCreatedBy)}`;
    const receipt = await query(
      `SELECT id FROM gnucash_web_receipts
       WHERE id = $1 AND book_guid = $2${createdByClause}`,
      receiptValues,
    );
    if (!receipt.rows[0]) throw new ReimbursementValidationError('Receipt not found');
  }

  let result;
  try {
    result = await query(
      `INSERT INTO gnucash_web_reimbursement_requests
        (book_guid, receipt_id, employee_guid, submitted_by, amount,
         expense_account_guid, description, notes, expense_date, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        input.bookGuid,
        input.receiptId ?? null,
        input.employeeGuid,
        input.submittedBy,
        Math.round(input.amount * 100) / 100,
        input.expenseAccountGuid,
        input.description?.trim() || null,
        input.notes?.trim() || null,
        input.expenseDate,
        input.dueDate || null,
      ],
    );
  } catch (error) {
    if (error instanceof Error && /idx_reimbursements_open_receipt|duplicate key/i.test(error.message)) {
      throw new ReimbursementValidationError('This receipt already has an active reimbursement request');
    }
    throw error;
  }
  const created = (await getReimbursement(result.rows[0].id, input.bookGuid))!;
  await logAudit(
    'CREATE',
    'REIMBURSEMENT',
    String(created.id),
    null,
    created,
    { bookGuid: input.bookGuid, userId: input.submittedBy },
  );
  return created;
}

export async function approveReimbursement(input: {
  id: number;
  bookGuid: string;
  approvedBy: number;
}): Promise<ReimbursementRequest> {
  return withDatabaseAdvisoryLock(
    `reimbursement-approval:${input.bookGuid}:${input.id}`,
    async () => {
      const request = await getReimbursement(input.id, input.bookGuid);
      if (!request) throw new ReimbursementValidationError('Reimbursement request not found');
      if (request.status !== 'submitted') {
        throw new ReimbursementStateError('Only submitted requests can be approved');
      }

      const billingId = `REIMB-${request.id}`;
      const orphan = await prisma.invoices.findFirst({
        where: {
          owner_type: OWNER_TYPE_EMPLOYEE,
          owner_guid: request.employeeGuid,
          billing_id: billingId,
          post_txn: null,
        },
        select: { guid: true },
      });
      const voucher = orphan
        ? await getVoucher(orphan.guid)
        : await createVoucher({
            employeeGuid: request.employeeGuid,
            id: billingId,
            dateOpened: request.expenseDate,
            notes: [
              request.notes,
              request.receiptId ? `Receipt #${request.receiptId}` : '',
              `Reimbursement request #${request.id}`,
            ].filter(Boolean).join(' · '),
            billingId,
            entries: [{
              description: request.description || request.receiptFilename || 'Employee expense',
              accountGuid: request.expenseAccountGuid,
              quantity: 1,
              price: request.amount,
            }],
            bookGuid: input.bookGuid,
          });
      const updated = await query(
        `UPDATE gnucash_web_reimbursement_requests
         SET status = 'approved', approved_by = $1, voucher_guid = $2,
             reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND book_guid = $4 AND status = 'submitted'`,
        [input.approvedBy, voucher.guid, input.id, input.bookGuid],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new ReimbursementStateError('This request changed before approval was recorded');
      }
      return (await getReimbursement(input.id, input.bookGuid))!;
    },
  );
}

export async function rejectReimbursement(input: {
  id: number;
  bookGuid: string;
  approvedBy: number;
  reason: string;
}): Promise<ReimbursementRequest> {
  return withDatabaseAdvisoryLock(
    `reimbursement-approval:${input.bookGuid}:${input.id}`,
    async () => {
      const request = await getReimbursement(input.id, input.bookGuid);
      if (!request) throw new ReimbursementValidationError('Reimbursement request not found');
      if (request.status !== 'submitted') {
        throw new ReimbursementStateError('Only submitted requests can be rejected');
      }
      if (!input.reason.trim()) throw new ReimbursementValidationError('A rejection reason is required');
      const updated = await query(
        `UPDATE gnucash_web_reimbursement_requests
         SET status = 'rejected', approved_by = $1, rejection_reason = $2,
             reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND book_guid = $4 AND status = 'submitted'`,
        [input.approvedBy, input.reason.trim(), input.id, input.bookGuid],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new ReimbursementStateError('This request changed before the rejection was recorded');
      }
      return (await getReimbursement(input.id, input.bookGuid))!;
    },
  );
}

export async function undoReimbursementDecision(
  id: number,
  bookGuid: string,
): Promise<ReimbursementRequest> {
  return withDatabaseAdvisoryLock(
    `reimbursement-approval:${bookGuid}:${id}`,
    async () => {
      const request = await getReimbursement(id, bookGuid);
      if (!request) throw new ReimbursementValidationError('Reimbursement request not found');
      if (request.status === 'approved' && request.voucherGuid) {
        await deleteVoucher(request.voucherGuid);
      } else if (request.status !== 'rejected') {
        throw new ReimbursementStateError('Only an unposted approval or rejection can be undone');
      }
      await query(
        `UPDATE gnucash_web_reimbursement_requests
         SET status = 'submitted', approved_by = NULL, voucher_guid = NULL,
             rejection_reason = NULL, reviewed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND book_guid = $2`,
        [id, bookGuid],
      );
      return (await getReimbursement(id, bookGuid))!;
    },
  );
}

export async function markReimbursementVoucherPosted(
  voucherGuid: string,
  bookGuid: string,
): Promise<void> {
  await query(
    `UPDATE gnucash_web_reimbursement_requests
     SET status = 'posted', posted_at = NOW(), updated_at = NOW()
     WHERE voucher_guid = $1 AND book_guid = $2 AND status = 'approved'`,
    [voucherGuid, bookGuid],
  );
}
