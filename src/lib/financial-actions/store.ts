import { createHash } from 'node:crypto';
import prisma from '@/lib/prisma';
import { loadOpportunityActions, loadSourceActions } from './sources';
import { FINANCIAL_ACTIONS_SCHEMA_SQL } from './schema';
import type {
  FinancialAction,
  FinancialActionCandidate,
  FinancialActionList,
  FinancialActionState,
} from './types';

type ActionRow = {
  id: string;
  stable_key: string;
  book_guid: string;
  lane: FinancialAction['lane'];
  origin: FinancialAction['origin'];
  source_id: string;
  severity: FinancialAction['severity'];
  title: string;
  summary: string;
  due_date: Date | null;
  impact: FinancialAction['impact'];
  confidence: number;
  score: FinancialAction['score'];
  assignee: string | null;
  operations: FinancialAction['operations'];
  trace: FinancialAction['trace'];
  metadata: Record<string, unknown> | null;
  state: FinancialActionState;
  snoozed_until: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  state_changed_at: Date;
  resolved_at: Date | null;
};

let ensurePromise: Promise<void> | null = null;

export function ensureFinancialActionsTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_financial_actions_schema'));
        ${FINANCIAL_ACTIONS_SCHEMA_SQL}
      END $$;
    `).then(() => undefined);
  }
  return ensurePromise;
}

const ACTION_REFRESH_TTL_MS = 5 * 60 * 1_000;
const ACTION_FORCE_REFRESH_FLOOR_MS = 30 * 1_000;
export const MAX_ACTION_TRACE_EXPORT = 1_000;

export class FinancialActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinancialActionValidationError';
  }
}

export function financialActionId(
  userId: number,
  bookGuid: string,
  stableKey: string,
): string {
  return `act_${createHash('sha256')
    .update(`${userId}:${bookGuid}:${stableKey}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function rowToAction(row: ActionRow): FinancialAction {
  return {
    id: row.id,
    stableKey: row.stable_key,
    bookGuid: row.book_guid,
    lane: row.lane,
    origin: row.origin,
    sourceId: row.source_id,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    dueDate: row.due_date?.toISOString().slice(0, 10) ?? null,
    impact: row.impact,
    confidence: row.confidence,
    score: row.score,
    assignee: row.assignee,
    operations: row.operations,
    trace: row.trace,
    metadata: row.metadata ?? {},
    state: row.state,
    snoozedUntil: row.snoozed_until?.toISOString() ?? null,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    stateChangedAt: row.state_changed_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

async function upsertCandidate(
  client: Pick<typeof prisma, '$executeRaw'>,
  userId: number,
  bookGuid: string,
  candidate: FinancialActionCandidate,
): Promise<void> {
  const id = financialActionId(userId, bookGuid, candidate.stableKey);
  await client.$executeRaw`
    INSERT INTO gnucash_web_financial_actions (
      id, stable_key, user_id, book_guid, lane, origin, source_id, severity,
      title, summary, due_date, impact, confidence, score, assignee,
      operations, trace, metadata
    )
    VALUES (
      ${id},
      ${candidate.stableKey},
      ${userId},
      ${bookGuid},
      ${candidate.lane},
      ${candidate.origin},
      ${candidate.sourceId},
      ${candidate.severity},
      ${candidate.title},
      ${candidate.summary},
      ${candidate.dueDate ? new Date(`${candidate.dueDate}T00:00:00Z`) : null},
      ${candidate.impact ? JSON.stringify(candidate.impact) : null}::jsonb,
      ${candidate.confidence},
      ${candidate.score ? JSON.stringify(candidate.score) : null}::jsonb,
      ${candidate.assignee ?? null},
      ${JSON.stringify(candidate.operations)}::jsonb,
      ${JSON.stringify(candidate.trace)}::jsonb,
      ${JSON.stringify(candidate.metadata ?? {})}::jsonb
    )
    ON CONFLICT (user_id, book_guid, stable_key)
    DO UPDATE SET
      lane = CASE
        WHEN gnucash_web_financial_actions.state = 'accepted' THEN 'do'
        ELSE EXCLUDED.lane
      END,
      origin = EXCLUDED.origin,
      source_id = EXCLUDED.source_id,
      severity = EXCLUDED.severity,
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      due_date = EXCLUDED.due_date,
      impact = EXCLUDED.impact,
      confidence = EXCLUDED.confidence,
      score = EXCLUDED.score,
      assignee = EXCLUDED.assignee,
      operations = EXCLUDED.operations,
      trace = CASE
        WHEN gnucash_web_financial_actions.state = 'accepted'
          OR (
            gnucash_web_financial_actions.state IN ('resolved', 'dismissed')
            AND gnucash_web_financial_actions.last_seen_at >= NOW() - INTERVAL '7 days'
          )
        THEN gnucash_web_financial_actions.trace
        ELSE EXCLUDED.trace
      END,
      metadata = EXCLUDED.metadata,
      last_seen_at = NOW(),
      state = CASE
        WHEN gnucash_web_financial_actions.state = 'snoozed'
          AND gnucash_web_financial_actions.snoozed_until <= NOW()
        THEN 'open'
        WHEN gnucash_web_financial_actions.state IN ('resolved', 'dismissed', 'expired')
          AND gnucash_web_financial_actions.last_seen_at < NOW() - INTERVAL '7 days'
        THEN 'open'
        ELSE gnucash_web_financial_actions.state
      END,
      state_changed_at = CASE
        WHEN (
          gnucash_web_financial_actions.state = 'snoozed'
          AND gnucash_web_financial_actions.snoozed_until <= NOW()
        ) OR (
          gnucash_web_financial_actions.state IN ('resolved', 'dismissed', 'expired')
          AND gnucash_web_financial_actions.last_seen_at < NOW() - INTERVAL '7 days'
        )
        THEN NOW()
        ELSE gnucash_web_financial_actions.state_changed_at
      END,
      snoozed_until = CASE
        WHEN (
          gnucash_web_financial_actions.state = 'snoozed'
          AND gnucash_web_financial_actions.snoozed_until <= NOW()
        ) OR (
          gnucash_web_financial_actions.state IN ('resolved', 'dismissed', 'expired')
          AND gnucash_web_financial_actions.last_seen_at < NOW() - INTERVAL '7 days'
        )
        THEN NULL
        ELSE gnucash_web_financial_actions.snoozed_until
      END,
      resolved_at = CASE
        WHEN gnucash_web_financial_actions.state IN ('resolved', 'dismissed', 'expired')
          AND gnucash_web_financial_actions.last_seen_at < NOW() - INTERVAL '7 days'
        THEN NULL
        ELSE gnucash_web_financial_actions.resolved_at
      END
  `;
}

async function materializeActions(input: {
  userId: number;
  bookGuid: string;
  bookAccountGuids: string[];
  refresh?: boolean;
}): Promise<void> {
  // Detector reads happen before the transaction so a burst of waiting
  // refreshes cannot consume the connection pool while the lock holder needs
  // separate connections for existing report services.
  const [sourceActions, opportunityActions] = await Promise.all([
    loadSourceActions(input),
    loadOpportunityActions(input),
  ]);
  const byKey = new Map<string, FinancialActionCandidate>();
  for (const action of [...sourceActions, ...opportunityActions]) {
    byKey.set(action.stableKey, action);
  }

  await prisma.$transaction(async client => {
    const lockKey = `financial-actions:${input.userId}:${input.bookGuid}`;
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    // Re-check freshness after taking the lock so concurrent requests cannot
    // run the same detectors or overwrite one another's materialization.
    const refreshRows = await client.$queryRaw<Array<{
      last_successful_refresh: Date | null;
    }>>`
      SELECT last_successful_refresh
      FROM gnucash_web_financial_action_refresh
      WHERE user_id = ${input.userId}
        AND book_guid = ${input.bookGuid}
    `;
    const lastRefreshAt = refreshRows[0]?.last_successful_refresh ?? null;
    const refreshAge = lastRefreshAt ? Date.now() - lastRefreshAt.getTime() : Infinity;
    const shouldRefresh = refreshAge >= ACTION_REFRESH_TTL_MS
      || Boolean(input.refresh && refreshAge >= ACTION_FORCE_REFRESH_FLOOR_MS);
    if (!shouldRefresh) return;

    for (const candidate of byKey.values()) {
      await upsertCandidate(client, input.userId, input.bookGuid, candidate);
    }

    // Do not expire a temporarily unavailable adapter immediately. A generated
    // action must be absent for seven days before it leaves the active inbox.
    await client.$executeRaw`
      UPDATE gnucash_web_financial_actions
      SET state = 'expired',
          state_changed_at = NOW(),
          resolved_at = NOW()
      WHERE user_id = ${input.userId}
        AND book_guid = ${input.bookGuid}
        AND state IN ('open', 'snoozed')
        AND last_seen_at < NOW() - INTERVAL '7 days'
    `;

    // This marker is deliberately last. A detector or write failure rolls back
    // every candidate and leaves the prior successful refresh timestamp intact.
    await client.$executeRaw`
      INSERT INTO gnucash_web_financial_action_refresh (
        user_id, book_guid, last_successful_refresh
      )
      VALUES (${input.userId}, ${input.bookGuid}, NOW())
      ON CONFLICT (user_id, book_guid)
      DO UPDATE SET last_successful_refresh = EXCLUDED.last_successful_refresh
    `;
  }, {
    maxWait: 10_000,
    timeout: 300_000,
  });
}

async function verifiedThroughDate(bookAccountGuids: string[]): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{
    verified_through: Date | null;
    account_count: number;
    missing_count: number;
  }>>`
    WITH relevant_accounts AS (
      SELECT guid
      FROM accounts
      WHERE guid = ANY(${bookAccountGuids}::text[])
        AND account_type IN ('BANK', 'CASH', 'CREDIT')
        AND COALESCE(placeholder, 0) = 0
    ),
    account_coverage AS (
      SELECT
        account.guid,
        MAX(t.post_date) FILTER (
          WHERE s.reconcile_state = 'y'
        ) AS verified_through
      FROM relevant_accounts account
      LEFT JOIN splits s ON s.account_guid = account.guid
      LEFT JOIN transactions t ON t.guid = s.tx_guid
      GROUP BY account.guid
    )
    SELECT
      MIN(verified_through) AS verified_through,
      COUNT(*)::int AS account_count,
      COUNT(*) FILTER (WHERE verified_through IS NULL)::int AS missing_count
    FROM account_coverage
  `;
  const coverage = rows[0];
  if (!coverage || coverage.account_count === 0 || coverage.missing_count > 0) {
    return null;
  }
  return coverage.verified_through?.toISOString().slice(0, 10) ?? null;
}

export async function listFinancialActions(input: {
  userId: number;
  bookGuid: string;
  bookAccountGuids: string[];
  includeCompleted?: boolean;
  refresh?: boolean;
}): Promise<FinancialActionList> {
  await ensureFinancialActionsTable();
  const freshness = await prisma.$queryRaw<Array<{ last_refresh_at: Date | null }>>`
    SELECT last_successful_refresh AS last_refresh_at
    FROM gnucash_web_financial_action_refresh
    WHERE user_id = ${input.userId}
      AND book_guid = ${input.bookGuid}
  `;
  const lastRefreshAt = freshness[0]?.last_refresh_at ?? null;
  const refreshAge = lastRefreshAt ? Date.now() - lastRefreshAt.getTime() : Infinity;
  const stale = refreshAge >= ACTION_REFRESH_TTL_MS;
  const forceRefreshAllowed = input.refresh && refreshAge >= ACTION_FORCE_REFRESH_FLOOR_MS;
  if (stale || forceRefreshAllowed) {
    await materializeActions(input);
  }
  const rows = await prisma.$queryRaw<ActionRow[]>`
    SELECT
      id, stable_key, book_guid, lane, origin, source_id, severity, title,
      summary, due_date, impact, confidence, score, assignee, operations,
      trace, metadata, state, snoozed_until, first_seen_at, last_seen_at,
      state_changed_at, resolved_at
    FROM gnucash_web_financial_actions
    WHERE user_id = ${input.userId}
      AND book_guid = ${input.bookGuid}
      AND (
        ${input.includeCompleted ?? false}
        OR state IN ('open', 'snoozed', 'accepted')
      )
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      COALESCE((score->>'total')::float8, 0) DESC,
      due_date ASC NULLS LAST,
      first_seen_at DESC
  `;
  const weeklyRows = await prisma.$queryRaw<Array<{
    new_count: number;
    resolved_count: number;
    automated_count: number;
    overdue_count: number;
  }>>`
    SELECT
      COUNT(*) FILTER (WHERE first_seen_at >= NOW() - INTERVAL '7 days')::int AS new_count,
      COUNT(*) FILTER (
        WHERE state = 'resolved' AND resolved_at >= NOW() - INTERVAL '7 days'
      )::int AS resolved_count,
      COUNT(*) FILTER (
        WHERE state = 'resolved'
          AND resolved_at >= NOW() - INTERVAL '7 days'
          AND COALESCE((metadata->>'automated')::boolean, FALSE)
      )::int AS automated_count,
      COUNT(*) FILTER (
        WHERE state IN ('open', 'snoozed', 'accepted')
          AND due_date < CURRENT_DATE
      )::int AS overdue_count
    FROM gnucash_web_financial_actions
    WHERE user_id = ${input.userId}
      AND book_guid = ${input.bookGuid}
  `;
  const weekly = weeklyRows[0];
  return {
    actions: rows.map(rowToAction),
    summary: {
      new: weekly?.new_count ?? 0,
      resolved: weekly?.resolved_count ?? 0,
      automated: weekly?.automated_count ?? 0,
      overdue: weekly?.overdue_count ?? 0,
    },
    verifiedThrough: await verifiedThroughDate(input.bookAccountGuids),
    generatedAt: new Date().toISOString(),
  };
}

export async function listActionTraceSnapshots(input: {
  userId: number;
  bookGuid: string;
}): Promise<{
  traces: Array<{
  actionId: string;
  state: FinancialActionState;
  stateChangedAt: string;
  trace: FinancialAction['trace'];
  }>;
  truncated: boolean;
}> {
  await ensureFinancialActionsTable();
  const rows = await prisma.$queryRaw<Array<{
    id: string;
    state: FinancialActionState;
    state_changed_at: Date;
    trace: FinancialAction['trace'];
  }>>`
    SELECT id, state, state_changed_at, trace
    FROM gnucash_web_financial_actions
    WHERE user_id = ${input.userId}
      AND book_guid = ${input.bookGuid}
    ORDER BY state_changed_at DESC
    LIMIT ${MAX_ACTION_TRACE_EXPORT + 1}
  `;
  return {
    traces: rows.slice(0, MAX_ACTION_TRACE_EXPORT).map(row => ({
      actionId: row.id,
      state: row.state,
      stateChangedAt: row.state_changed_at.toISOString(),
      trace: row.trace,
    })),
    truncated: rows.length > MAX_ACTION_TRACE_EXPORT,
  };
}

const ACTION_STATES = new Set<FinancialActionState>([
  'open',
  'snoozed',
  'accepted',
  'resolved',
  'dismissed',
  'expired',
]);

export async function updateFinancialActions(input: {
  userId: number;
  bookGuid: string;
  ids: string[];
  state: FinancialActionState;
  snoozedUntil?: string | null;
}): Promise<number> {
  await ensureFinancialActionsTable();
  if (!ACTION_STATES.has(input.state)) {
    throw new FinancialActionValidationError('Invalid action state');
  }
  const uniqueIds = [...new Set(input.ids)].filter(id => /^act_[0-9a-f]{32}$/.test(id));
  if (uniqueIds.length === 0 || uniqueIds.length > 200) {
    throw new FinancialActionValidationError('Select between 1 and 200 valid actions');
  }
  let snoozedUntil: Date | null = null;
  if (input.state === 'snoozed') {
    snoozedUntil = input.snoozedUntil ? new Date(input.snoozedUntil) : null;
    if (!snoozedUntil || !Number.isFinite(snoozedUntil.getTime()) || snoozedUntil <= new Date()) {
      throw new FinancialActionValidationError('A future snooze date is required');
    }
  }
  return prisma.$executeRaw`
    UPDATE gnucash_web_financial_actions
    SET
      state = ${input.state},
      lane = CASE WHEN ${input.state} = 'accepted' THEN 'do' ELSE lane END,
      snoozed_until = ${snoozedUntil},
      state_changed_at = NOW(),
      resolved_at = CASE
        WHEN ${input.state} IN ('resolved', 'dismissed', 'expired') THEN NOW()
        ELSE NULL
      END
    WHERE user_id = ${input.userId}
      AND book_guid = ${input.bookGuid}
      AND id = ANY(${uniqueIds}::text[])
  `;
}
