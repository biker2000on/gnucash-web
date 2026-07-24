import { randomUUID } from 'crypto';
import { query } from '@/lib/db';
import { getAccountGuidsForBook } from '@/lib/book-scope';

export interface ReconciliationAccountCoverage {
  accountGuid: string;
  name: string;
  type: string;
  totalSplits: number;
  reconciledSplits: number;
  clearedSplits: number;
  outstandingSplits: number;
  coveragePercent: number;
  lastActivityDate: string | null;
  verifiedThrough: string | null;
  staleDays: number | null;
  status: 'current' | 'stale' | 'never';
}

export interface ReconciliationCoverage {
  generatedAt: string;
  verifiedThrough: string | null;
  coveragePercent: number;
  accountCount: number;
  currentAccounts: number;
  staleAccounts: number;
  neverReconciledAccounts: number;
  sessions: {
    completed: number;
    abandoned: number;
    active: number;
    averageMinutes: number | null;
    averageInteractions: number | null;
  };
  accounts: ReconciliationAccountCoverage[];
}

interface CoverageRow {
  account_guid: string;
  name: string;
  account_type: string;
  total_splits: string;
  reconciled_splits: string;
  cleared_splits: string;
  outstanding_splits: string;
  last_activity_date: Date | null;
  verified_through: Date | null;
}

const DAY_MS = 86_400_000;

export function classifyCoverage(
  row: CoverageRow,
  now = new Date(),
  staleAfterDays = 45,
): ReconciliationAccountCoverage {
  const total = Number(row.total_splits);
  const reconciled = Number(row.reconciled_splits);
  const verifiedThrough = row.verified_through?.toISOString().slice(0, 10) ?? null;
  const staleDays = row.verified_through
    ? Math.max(0, Math.floor((now.getTime() - row.verified_through.getTime()) / DAY_MS))
    : null;
  return {
    accountGuid: row.account_guid,
    name: row.name,
    type: row.account_type,
    totalSplits: total,
    reconciledSplits: reconciled,
    clearedSplits: Number(row.cleared_splits),
    outstandingSplits: Number(row.outstanding_splits),
    coveragePercent: total === 0 ? 100 : Math.round((reconciled / total) * 1000) / 10,
    lastActivityDate: row.last_activity_date?.toISOString().slice(0, 10) ?? null,
    verifiedThrough,
    staleDays,
    status: !verifiedThrough ? 'never' : staleDays! > staleAfterDays ? 'stale' : 'current',
  };
}

export async function getReconciliationCoverage(
  bookGuid: string,
  staleAfterDays = 45,
): Promise<ReconciliationCoverage> {
  const accountGuids = await getAccountGuidsForBook(bookGuid);
  if (accountGuids.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      verifiedThrough: null,
      coveragePercent: 100,
      accountCount: 0,
      currentAccounts: 0,
      staleAccounts: 0,
      neverReconciledAccounts: 0,
      sessions: { completed: 0, abandoned: 0, active: 0, averageMinutes: null, averageInteractions: null },
      accounts: [],
    };
  }

  const [coverageResult, sessionsResult] = await Promise.all([
    query(
      `SELECT a.guid AS account_guid, a.name, a.account_type,
              COUNT(s.guid)::text AS total_splits,
              COUNT(s.guid) FILTER (WHERE s.reconcile_state = 'y')::text AS reconciled_splits,
              COUNT(s.guid) FILTER (WHERE s.reconcile_state = 'c')::text AS cleared_splits,
              COUNT(s.guid) FILTER (WHERE s.reconcile_state = 'n')::text AS outstanding_splits,
              MAX(t.post_date) AS last_activity_date,
              MAX(COALESCE(s.reconcile_date, t.post_date))
                FILTER (WHERE s.reconcile_state = 'y') AS verified_through
         FROM accounts a
         LEFT JOIN splits s ON s.account_guid = a.guid
         LEFT JOIN transactions t ON t.guid = s.tx_guid
        WHERE a.guid = ANY($1::varchar[])
          AND a.account_type IN ('BANK','CASH','CREDIT')
          AND COALESCE(a.hidden, 0) = 0
          AND COALESCE(a.placeholder, 0) = 0
        GROUP BY a.guid, a.name, a.account_type
        HAVING COUNT(s.guid) > 0
        ORDER BY a.account_type, a.name`,
      [accountGuids],
    ),
    query(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
          COUNT(*) FILTER (
            WHERE status = 'abandoned'
               OR (status = 'started' AND started_at < NOW() - INTERVAL '24 hours')
          )::text AS abandoned,
          COUNT(*) FILTER (
            WHERE status = 'started' AND started_at >= NOW() - INTERVAL '24 hours'
          )::text AS active,
          AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60)
            FILTER (WHERE status = 'completed')::text AS average_minutes,
          AVG(interaction_count) FILTER (WHERE status = 'completed')::text AS average_interactions
         FROM gnucash_web_reconciliation_sessions
        WHERE book_guid = $1`,
      [bookGuid],
    ),
  ]);

  const now = new Date();
  const accounts = (coverageResult.rows as CoverageRow[]).map(row => classifyCoverage(row, now, staleAfterDays));
  const total = accounts.reduce((sum, account) => sum + account.totalSplits, 0);
  const reconciled = accounts.reduce((sum, account) => sum + account.reconciledSplits, 0);
  const verifiedDates = accounts
    .map(account => account.verifiedThrough)
    .filter((value): value is string => Boolean(value))
    .sort();
  const sessions = sessionsResult.rows[0] as {
    completed: string;
    abandoned: string;
    active: string;
    average_minutes: string | null;
    average_interactions: string | null;
  } | undefined;

  return {
    generatedAt: now.toISOString(),
    verifiedThrough: accounts.length > 0 && verifiedDates.length === accounts.length ? verifiedDates[0] : null,
    coveragePercent: total === 0 ? 100 : Math.round((reconciled / total) * 1000) / 10,
    accountCount: accounts.length,
    currentAccounts: accounts.filter(account => account.status === 'current').length,
    staleAccounts: accounts.filter(account => account.status === 'stale').length,
    neverReconciledAccounts: accounts.filter(account => account.status === 'never').length,
    sessions: {
      completed: Number(sessions?.completed ?? 0),
      abandoned: Number(sessions?.abandoned ?? 0),
      active: Number(sessions?.active ?? 0),
      averageMinutes: sessions?.average_minutes === null || sessions?.average_minutes === undefined
        ? null : Math.round(Number(sessions.average_minutes) * 10) / 10,
      averageInteractions: sessions?.average_interactions === null || sessions?.average_interactions === undefined
        ? null : Math.round(Number(sessions.average_interactions) * 10) / 10,
    },
    accounts,
  };
}

export async function startReconciliationSession(input: {
  bookGuid: string;
  accountGuid: string;
  userId: number;
  statementDate: string;
}): Promise<string> {
  const accountGuids = await getAccountGuidsForBook(input.bookGuid);
  if (!accountGuids.includes(input.accountGuid)) throw new Error('Account is outside the active book');
  const id = randomUUID();
  await query(
    `INSERT INTO gnucash_web_reconciliation_sessions
       (id, book_guid, account_guid, user_id, statement_date)
     VALUES ($1,$2,$3,$4,$5::date)`,
    [id, input.bookGuid, input.accountGuid, input.userId, input.statementDate],
  );
  return id;
}

export async function updateReconciliationSession(input: {
  id: string;
  bookGuid: string;
  userId: number;
  interactionDelta?: number;
  status?: 'completed' | 'abandoned';
  endingDifference?: number;
}): Promise<boolean> {
  const result = await query(
    `UPDATE gnucash_web_reconciliation_sessions
        SET interaction_count = interaction_count + $1,
            status = COALESCE($2, status),
            completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE completed_at END,
            ending_difference = COALESCE($3, ending_difference)
      WHERE id = $4 AND book_guid = $5 AND user_id = $6
      RETURNING id`,
    [
      Math.max(0, input.interactionDelta ?? 0),
      input.status ?? null,
      input.endingDifference ?? null,
      input.id,
      input.bookGuid,
      input.userId,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
