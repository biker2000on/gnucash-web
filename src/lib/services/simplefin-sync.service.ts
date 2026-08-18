/**
 * SimpleFin Transaction Sync Engine
 *
 * Syncs transactions from SimpleFin into GnuCash.
 * Handles deduplication, category guessing, and transaction creation.
 */

import prisma, { generateGuid } from '@/lib/prisma';
import { tryWithDatabaseAdvisoryLock } from '@/lib/db';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { acquireNamedXactLock, commodityLockKey } from '@/lib/book-lock';
import { acquireSoleAccountNameLock } from '@/lib/account-lock-order';
import { decryptAccessUrl, fetchAccountsChunked, SimpleFinTransaction, SimpleFinAccessRevokedError, SimpleFinHolding } from './simplefin.service';
import { toNumDenom } from '@/lib/validation';
import { buildSymbolSet, parseSymbol } from './simplefin-symbol-parser';
import { applyRules } from './categorization.service';
import { createNotification, ensureNotificationsTable } from '@/lib/notifications';
import { simpleFinErrorFingerprint } from '@/lib/simplefin-error-fingerprint';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import { scanForAnomalies } from '@/lib/anomaly-detection';
import { scanBudgetAlerts } from '@/lib/budget-envelope';
import { scanInventoryReorder } from '@/lib/services/inventory.service';
import { runDueRecurringInvoices } from '@/lib/business/recurring-invoices';
import { getCachedLockDate, findLockedDate } from '@/lib/services/period-lock.service';

const DEFAULT_SIMPLEFIN_MATCH_WINDOW_DAYS = 3;

export function getSimpleFinMatchWindowDays(): number {
  const raw = process.env.SIMPLEFIN_MATCH_WINDOW_DAYS;
  if (!raw) return DEFAULT_SIMPLEFIN_MATCH_WINDOW_DAYS;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SIMPLEFIN_MATCH_WINDOW_DAYS;
}

/**
 * Normalize a SimpleFIN `posted` Unix timestamp to a date-only value.
 * SimpleFIN sends the actual posting time in the bank's local zone (Eastern
 * for US banks). Storing the raw timestamp and displaying in UTC can roll
 * late-PM Eastern transactions forward a day. Extract the calendar date in
 * Eastern time and return midnight UTC of that date.
 */
function normalizePostDate(postedUnixSeconds: number): Date {
  const raw = new Date(postedUnixSeconds * 1000);
  // Format the date in America/New_York → "MM/DD/YYYY"
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.SIMPLEFIN_TZ || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(raw);
  const year = parts.find(p => p.type === 'year')!.value;
  const month = parts.find(p => p.type === 'month')!.value;
  const day = parts.find(p => p.type === 'day')!.value;
  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

export interface SyncResult {
  status: 'success' | 'failed' | 'revoked';
  fatal: boolean;
  revoked: boolean;
  /**
   * True when this run exited early because another sync for the same
   * connection was already in progress (advisory-lock guard). Nothing was
   * imported and connection status was left untouched.
   */
  alreadyRunning?: boolean;
  accountsProcessed: number;
  transactionsImported: number;
  transactionsSkipped: number;
  investmentTransactionsImported: number;
  transactionsMatched: {
    manualReconciliation: number;
    transferDedup: number;
  };
  errors: { account: string; error: string }[];
  warnings: { account: string; warning: string }[];
}

type SimpleFinSyncStatus = SyncResult['status'] | 'running' | 'queued';

export interface SyncProgressUpdate {
  message: string;
  current?: number;
  total?: number;
  /** 0-100. */
  percent?: number;
}

interface SyncSimpleFinOptions {
  notifyOnSuccess?: boolean;
  source?: 'manual' | 'scheduled' | 'refresh' | 'unknown';
  /**
   * Incremental progress callback (best-effort — errors are swallowed so
   * progress reporting can never break the sync itself).
   */
  onProgress?: (p: SyncProgressUpdate) => void | Promise<void>;
}

export function isNonFatalSimpleFinWarning(message: string): boolean {
  return /requested date range exceeds recommended range/i.test(message);
}

/** Trailing overlap re-fetched on every sync so late-posting transactions land. */
const SYNC_OVERLAP_DAYS = 7;
/** Bootstrap window for accounts that have never synced. */
const SYNC_BOOTSTRAP_DAYS = 90;
/**
 * Hard floor on how far back a FAILED transaction may hold an account's sync
 * cursor.
 *
 * Holding the cursor at the oldest failure (so a failed row is re-fetched
 * rather than silently lost) is only safe if it is bounded. A permanently
 * failing row — malformed payload, a constraint the data can never satisfy —
 * would otherwise pin its account's cursor forever, and because
 * `computeSyncStart` takes the MIN across accounts, that one row widens the
 * fetch window for EVERY account on the connection, growing without limit at
 * the worker's 2-hourly cadence.
 *
 * 30 days, because:
 *  - 30 + SYNC_OVERLAP_DAYS = 37 days, still inside SimpleFin's 45-day
 *    recommended range, so a stuck account can never push the connection-wide
 *    request past what the bridge recommends (that warning is deliberately
 *    downgraded, so nothing else would surface the growth).
 *  - It is far longer than any transient cause of an import failure (deploy,
 *    DB restart, lock contention, rate limit). Anything still failing after a
 *    solid month is permanent and needs a human, not another 360 retries.
 * Rows that age out are named in the failure notification (see
 * `describeFailedImports`) rather than disappearing silently.
 */
export const MAX_RETRY_LOOKBACK_DAYS = 30;

/**
 * Start of the SimpleFin fetch window. Pure — exported for tests.
 *
 * - Any account never synced → 90 days back (bootstrap).
 * - Otherwise → the OLDEST per-account last-sync minus a 7-day overlap
 *   (dedup by SimpleFin transaction id makes the overlap safe, and stale
 *   accounts naturally widen the window).
 *
 * Previously every sync fetched ≥90 days, tripping SimpleFin's
 * "exceeds recommended range of 45 days" warning on each run — untenable at
 * the new 2-hourly cadence, and fragile if the bridge starts capping.
 */
export function computeSyncStart(
  lastSyncs: Array<Date | null>,
  now: Date,
): Date {
  const bootstrap = new Date(now.getTime() - SYNC_BOOTSTRAP_DAYS * 24 * 60 * 60 * 1000);
  if (lastSyncs.length === 0 || lastSyncs.some(d => !d)) return bootstrap;
  let earliest = lastSyncs[0] as Date;
  for (const d of lastSyncs) {
    if (d && d < earliest) earliest = d;
  }
  return new Date(earliest.getTime() - SYNC_OVERLAP_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Keep a mapping cursor at the oldest failed posting date, if any — clamped so
 * it can never sit further back than MAX_RETRY_LOOKBACK_DAYS.
 *
 * A failure inside the lookback still pins the cursor exactly as before, so the
 * next run necessarily re-fetches it (that is the data-loss fix). Beyond the
 * lookback the cursor floors at `now - MAX_RETRY_LOOKBACK_DAYS`, which bounds
 * the fetch window at 37 days instead of letting one permanently broken row
 * grow it forever.
 */
export function computeSafeSyncCursor(now: Date, failedPostDates: Date[]): Date {
  if (failedPostDates.length === 0) return now;
  const oldestFailure = failedPostDates.reduce((earliest, date) => date < earliest ? date : earliest);
  const floor = new Date(now.getTime() - MAX_RETRY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return oldestFailure > floor ? oldestFailure : floor;
}

/** One account's un-imported feed rows, summarized for the failure notification. */
export interface FailedImportRange {
  account: string;
  earliest: Date;
  latest: Date;
  count: number;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Human-readable tail appended to a failure notification.
 *
 * There is no dead-letter table for un-importable feed rows, and no natural
 * home for one: `gnucash_web_transaction_meta` is keyed on transaction_guid, so
 * a row that never imported has no transaction to hang meta off. Rather than
 * invent a table, the notification IS the durable record — it names the
 * affected account and the posting-date range that stops being retried once it
 * ages past MAX_RETRY_LOOKBACK_DAYS.
 */
export function describeFailedImports(ranges: FailedImportRange[]): string {
  if (ranges.length === 0) return '';
  const parts = ranges.map(range => {
    const from = isoDate(range.earliest);
    const to = isoDate(range.latest);
    const span = from === to ? from : `${from} to ${to}`;
    return `${range.count} transaction${range.count === 1 ? '' : 's'} for ${range.account} dated ${span}`;
  });
  return `Not imported: ${parts.join('; ')}. These are retried for up to ${MAX_RETRY_LOOKBACK_DAYS} days after their posting date, then skipped — enter them manually if they never import.`;
}

function recordFailedImport(
  ranges: Map<string, FailedImportRange>,
  account: string,
  postDate: Date,
) {
  const existing = ranges.get(account);
  if (!existing) {
    ranges.set(account, { account, earliest: postDate, latest: postDate, count: 1 });
    return;
  }
  existing.count++;
  if (postDate < existing.earliest) existing.earliest = postDate;
  if (postDate > existing.latest) existing.latest = postDate;
}

// Shared with @/lib/notifications, which raises the same connection-level
// failure from the notifications poll and must land on the identical key.
export { simpleFinErrorFingerprint };

export async function updateSimpleFinConnectionSyncStatus(
  connectionId: number,
  status: SimpleFinSyncStatus,
  error?: string | null,
) {
  const now = new Date();

  if (status === 'success') {
    await prisma.$executeRaw`
      UPDATE gnucash_web_simplefin_connections
      SET
        last_sync_at = ${now},
        last_successful_sync_at = ${now},
        last_sync_status = 'success',
        last_sync_error = NULL,
        last_sync_error_at = NULL
      WHERE id = ${connectionId}
    `;
    return;
  }

  await prisma.$executeRaw`
    UPDATE gnucash_web_simplefin_connections
    SET
      last_sync_status = ${status},
      last_sync_error = ${error || null},
      last_sync_error_at = ${error ? now : null}
    WHERE id = ${connectionId}
  `;
}

/**
 * True when an error is the unique violation on the SimpleFin transaction id
 * (uq_txn_meta_simplefin_id, a DB-only partial unique index). Prisma surfaces
 * it as P2002; raw paths surface Postgres 23505 text. Exported for tests.
 */
export function isSimpleFinDuplicateViolation(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: unknown; meta?: unknown };
  const text = `${err instanceof Error ? err.message : String(err)} ${JSON.stringify(anyErr.meta ?? {})}`;
  if (!/simplefin_transaction_id|uq_txn_meta_simplefin_id/i.test(text)) return false;
  return anyErr.code === 'P2002' || /duplicate key value|unique constraint/i.test(text);
}

/**
 * Markers identifying a unique violation on the two natural keys this service
 * creates against.
 *
 * The two keys are enforced very differently, and the difference decides what
 * the code below can rely on:
 *
 *   - commodities(namespace, mnemonic) HAS a DB arbiter,
 *     `uq_commodities_namespace_mnemonic` from db-init — except on a database
 *     whose duplicate commodities made that guard skip, where the advisory lock
 *     below is the only serializer.
 *   - accounts(parent_guid, name) has NO DB arbiter and deliberately never
 *     will: scheduled-transaction template children legitimately share
 *     (parent, ''), so a unique index there breaks scheduled-transaction
 *     creation (src/lib/db-init.ts, ACCOUNTS_SIBLING_NAME_INDEX, which also
 *     drops one an earlier release created). The advisory lock is the whole
 *     serializer for the account paths.
 *
 * The account marker is therefore not dead weight but not load-bearing either:
 * it keeps the adopt-the-winner recovery correct for a database where an
 * operator (or a future release, on a template-aware key) does add a unique
 * index, instead of surfacing a 23505 as a failed sync.
 *
 * Each entry lists both surface forms of the same violation: the index name
 * (Prisma's driver-adapter error carries the Postgres text verbatim) and the
 * conflicting column tuple (what a P2002 `meta.target` reports).
 */
const ACCOUNT_SIBLING_UNIQUE_MARKERS = ['uq_accounts_parent_name', '"parent_guid","name"'];
const COMMODITY_UNIQUE_MARKERS = ['uq_commodities_namespace_mnemonic', '"namespace","mnemonic"'];

/** Pulls the constraint/index name out of Postgres' own violation text. */
const UNIQUE_CONSTRAINT_NAME_RE = /unique (?:constraint|index) "([^"]+)"/gi;
/** Recognizes a unique violation from message text alone (raw/driver paths). */
const UNIQUE_VIOLATION_TEXT_RE = /duplicate key value|unique constraint|unique index/i;

/**
 * The identifying facts of a constraint violation, EXTRACTED rather than
 * pattern-matched: the exact constraint/index names the error names, and the
 * exact column tuples it reports, each normalized to the `"a","b"` form a
 * P2002 `meta.target` renders as.
 *
 * Extraction is what makes exact matching possible. A `text.includes(marker)`
 * test cannot distinguish `uq_accounts_parent_name` from an unrelated
 * `uq_accounts_parent_name_v2` (or from a constraint whose name merely embeds
 * it), so it would adopt a "winner" from a constraint this code knows nothing
 * about — an import into the wrong account, dressed as recovery.
 *
 * The walk is over the whole error graph because the identity can sit at any
 * depth: node-postgres puts it in `constraint`, Prisma in `meta.target`, and
 * the Prisma 7 pg driver adapter in
 * `meta.driverAdapterError.cause.{originalMessage,constraint.fields}`. Bounded
 * and cycle-safe.
 */
function describeUniqueViolation(err: unknown): { identifiers: Set<string>; unique: boolean } {
  const identifiers = new Set<string>();
  let unique = false;
  const seen = new Set<object>();
  const stack: unknown[] = [err];
  let budget = 500;

  /** `['parent_guid','name']` -> `"parent_guid","name"` (the P2002 form). */
  const addColumnTuple = (value: unknown) => {
    if (!Array.isArray(value) || value.length === 0) return;
    if (!value.every(field => typeof field === 'string')) return;
    identifiers.add(value.map(field => JSON.stringify(field)).join(','));
  };

  const visitString = (key: string, value: string) => {
    if (key === 'code' || key === 'originalCode') {
      if (value === 'P2002' || value === '23505') unique = true;
      return;
    }
    if (key === 'kind') {
      if (value === 'UniqueConstraintViolation') unique = true;
      return;
    }
    // A string `constraint`/`target` IS the identity — take it verbatim.
    if (key === 'constraint' || key === 'target') {
      identifiers.add(value);
      return;
    }
    if (!UNIQUE_VIOLATION_TEXT_RE.test(value)) return;
    unique = true;
    for (const match of value.matchAll(UNIQUE_CONSTRAINT_NAME_RE)) identifiers.add(match[1]);
  };

  while (stack.length > 0 && budget-- > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    // INSPECTION MUST NOT THROW. Reading a node is not as inert as it looks:
    // `Object.entries` invokes every enumerable getter, and a getter — or a
    // Proxy's ownKeys/get trap, or a revoked Proxy — is free to throw. This
    // function only ever runs while HANDLING a database error, so an escaping
    // accessor error would replace that error with a meaningless one from the
    // inspector: the caller would report "cannot perform 'ownKeys' on a
    // proxy that has been revoked" and the real 23505 (or whatever it was)
    // would be gone. Failing closed per node instead means the worst case is
    // "we learned nothing from this node", which lands on `unique === false`,
    // which makes `adoptUniqueConflictWinner` rethrow the ORIGINAL error —
    // exactly the behaviour for any error shape we do not recognise.
    // `message` is non-enumerable on Error, so the key walk below misses it.
    // Its own guard: `instanceof` runs a getPrototypeOf trap, and `.message`
    // may be an accessor.
    try {
      if (node instanceof Error) visitString('message', node.message);
    } catch { /* unreadable message — the rest of the node may still be fine */ }

    // Per-KEY rather than one `Object.entries(node)`, so a single throwing
    // getter costs us that property and not the whole node: the constraint
    // name may well be sitting in a sibling property we can still read.
    // `Object.keys` itself can throw (revoked proxy), hence the outer guard.
    let keys: string[];
    try {
      keys = Object.keys(node as Record<string, unknown>);
    } catch {
      continue;
    }
    for (const key of keys) {
      let value: unknown;
      try {
        value = (node as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (typeof value === 'string') {
        visitString(key, value);
        continue;
      }
      if (key === 'target' || key === 'fields') addColumnTuple(value);
      if (value && typeof value === 'object') stack.push(value);
    }
  }

  return { identifiers, unique };
}

/**
 * True when `err` is a Postgres unique violation whose constraint is EXACTLY
 * one of `markers` — either the index name (`uq_accounts_parent_name`) or the
 * conflicting column tuple (`"parent_guid","name"`).
 *
 * Both halves must hold: the error has to actually be a unique violation
 * (Prisma P2002, raw 23505, or Postgres' own wording), and the constraint it
 * names has to be one of ours. Any other constraint rethrows, so the caller
 * records a sync error rather than adopting a row it did not race for.
 *
 * TOTAL BY CONSTRUCTION: this is a predicate asked ABOUT an error, on the
 * error path, so it must never become the error. `describeUniqueViolation`
 * already fails closed per node, and this last guard makes the whole call
 * non-throwing — a `false` here sends `adoptUniqueConflictWinner` down its
 * `throw err` branch, which propagates the ORIGINAL database error rather
 * than whatever the inspection tripped over.
 * Exported for tests.
 */
export function isUniqueViolationOn(err: unknown, markers: readonly string[]): boolean {
  if (!err) return false;
  let identifiers: Set<string>;
  let unique: boolean;
  try {
    ({ identifiers, unique } = describeUniqueViolation(err));
  } catch {
    return false;
  }
  if (!unique) return false;
  return markers.some(marker => identifiers.has(marker));
}

/**
 * Sync all mapped accounts for a given connection.
 *
 * Guarded by a per-connection advisory lock: overlapping runs (manual click
 * during a scheduled run, two workers, etc.) exit early with a clean
 * `alreadyRunning` result instead of importing the same window twice.
 */
export async function syncSimpleFin(
  connectionId: number,
  bookGuid: string,
  options: SyncSimpleFinOptions = {},
): Promise<SyncResult> {
  const outcome = await tryWithDatabaseAdvisoryLock(
    `gnucash-web:simplefin-sync:${connectionId}`,
    () => runSimpleFinSync(connectionId, bookGuid, options),
  );
  if (!outcome.acquired) {
    return {
      status: 'success',
      fatal: false,
      revoked: false,
      alreadyRunning: true,
      accountsProcessed: 0,
      transactionsImported: 0,
      transactionsSkipped: 0,
      investmentTransactionsImported: 0,
      transactionsMatched: {
        manualReconciliation: 0,
        transferDedup: 0,
      },
      errors: [],
      warnings: [{
        account: 'connection',
        warning: 'A sync for this connection is already running; skipped this run.',
      }],
    };
  }
  return outcome.result;
}

export async function runSimpleFinSync(
  connectionId: number,
  bookGuid: string,
  options: SyncSimpleFinOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    status: 'success',
    fatal: false,
    revoked: false,
    accountsProcessed: 0,
    transactionsImported: 0,
    transactionsSkipped: 0,
    investmentTransactionsImported: 0,
    transactionsMatched: {
      manualReconciliation: 0,
      transferDedup: 0,
    },
    errors: [],
    warnings: [],
  };

  // Get connection
  const connection = await prisma.gnucash_web_simplefin_connections.findFirst({
    // The service is invoked by jobs as well as HTTP handlers. Bind the
    // caller-supplied pair to the persisted connection before following its
    // account mappings, rather than trusting connectionId alone.
    where: { id: connectionId, book_guid: bookGuid },
    select: { id: true, user_id: true, access_url_encrypted: true, last_sync_at: true },
  });

  if (!connection) {
    result.status = 'failed';
    result.fatal = true;
    result.errors.push({ account: 'connection', error: 'Connection not found' });
    return result;
  }

  // This is the one reusable definition of membership used throughout the
  // sync. Do not replace it with another parent-walk CTE: book-scope owns
  // that logic (including its bounded traversal and cache invalidation).
  const bookAccountGuids = await getAccountGuidsForBook(bookGuid);
  if (bookAccountGuids.length === 0) {
    result.status = 'failed';
    result.fatal = true;
    result.errors.push({ account: 'connection', error: 'No accounts found for this book' });
    return result;
  }
  const bookAccountGuidSet = new Set(bookAccountGuids);

  await updateSimpleFinConnectionSyncStatus(connectionId, 'running');

  let accessUrl: string;
  try {
    accessUrl = decryptAccessUrl(connection.access_url_encrypted);
  } catch {
    result.status = 'failed';
    result.fatal = true;
    result.errors.push({ account: 'connection', error: 'Failed to decrypt access URL' });
    await updateSimpleFinConnectionSyncStatus(connectionId, 'failed', 'Failed to decrypt access URL');
    return result;
  }

  // Get mapped accounts (gnucash_account_guid is guaranteed non-null by the filter)
  const mappedAccountsRaw = await prisma.gnucash_web_simplefin_account_map.findMany({
    where: {
      connection_id: connectionId,
      gnucash_account_guid: { not: null },
    },
    select: {
      id: true,
      simplefin_account_id: true,
      simplefin_account_name: true,
      gnucash_account_guid: true,
      last_sync_at: true,
      is_investment: true,
    },
  });
  const mappedAccounts = (mappedAccountsRaw as Array<
    Omit<(typeof mappedAccountsRaw)[number], 'gnucash_account_guid'> & { gnucash_account_guid: string }
  >).filter(mappedAccount => {
    if (bookAccountGuidSet.has(mappedAccount.gnucash_account_guid)) return true;
    // A stale/corrupt mapping must not turn into a cross-book split. It is
    // named as a sync error and skipped, never silently redirected.
    result.errors.push({
      account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
      error: 'Mapped GnuCash account not found in this book',
    });
    return false;
  });

  if (mappedAccounts.length === 0) {
    await finalizeSimpleFinSync(connection, bookGuid, connectionId, result, options);
    return result;
  }

  const allMappedAccountGuids = mappedAccounts.map(a => a.gnucash_account_guid);

  const earliestSync = computeSyncStart(
    mappedAccounts.map(a => a.last_sync_at),
    new Date(),
  );

  const endDate = new Date();

  const emitProgress = (p: SyncProgressUpdate) => {
    try {
      void options.onProgress?.(p);
    } catch {
      // Progress reporting must never break the sync.
    }
  };

  emitProgress({ message: 'Fetching transactions from SimpleFin…', percent: 5 });

  // Fetch all accounts with transactions using 60-day chunking
  let accountSet;
  try {
    accountSet = await fetchAccountsChunked(accessUrl, earliestSync, endDate);
  } catch (error) {
    if (error instanceof SimpleFinAccessRevokedError) {
      const message = error.message;
      result.status = 'revoked';
      result.fatal = true;
      result.revoked = true;
      result.errors.push({ account: 'all', error: message });
      await updateSimpleFinConnectionSyncStatus(connectionId, 'revoked', message);
      await createSimpleFinNotification(connection.user_id, bookGuid, connectionId, result, options);
    } else {
      const message = `Failed to fetch from SimpleFin: ${error}`;
      result.status = 'failed';
      result.fatal = true;
      result.errors.push({ account: 'all', error: message });
      await updateSimpleFinConnectionSyncStatus(connectionId, 'failed', message);
      await createSimpleFinNotification(connection.user_id, bookGuid, connectionId, result, options);
    }
    return result;
  }

  for (const error of accountSet.errors) {
    if (isNonFatalSimpleFinWarning(error)) {
      result.warnings.push({ account: 'all', warning: error });
    } else {
      result.errors.push({ account: 'all', error });
    }
  }

  // Build a map of SimpleFin account id -> account data
  const sfAccountMap = new Map(accountSet.accounts.map(a => [a.id, a]));

  // Track the earliest post date of any imported transaction so cached
  // dashboard metrics can be invalidated from that date forward.
  let earliestImportedPostDate: Date | null = null;
  // Per-account summary of rows that could not be imported. Feeds the failure
  // notification so an un-importable row is named (account + posting-date
  // range) instead of quietly ageing out of the retry lookback.
  const failedImports = new Map<string, FailedImportRange>();
  // Auto-created child/cash accounts must reach other processes' caches even
  // when the sync imports zero transactions (fully deduped window).
  const accountsCreated = { count: 0 };

  // Period lock: bank transactions dated on or before the book's lock date
  // are skipped (a closed period must not change under a sync).
  const lockDate = await getCachedLockDate(bookGuid);

  emitProgress({
    message: `Fetched ${accountSet.accounts.length} account(s) from SimpleFin`,
    percent: 10,
  });

  // Process each mapped account
  let accountIndex = 0;
  for (const mappedAccount of mappedAccounts) {
    accountIndex++;
    emitProgress({
      message: `Syncing ${mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id} (${accountIndex}/${mappedAccounts.length}) — ${result.transactionsImported} imported so far`,
      current: accountIndex,
      total: mappedAccounts.length,
      percent: Math.round(10 + (80 * (accountIndex - 1)) / mappedAccounts.length),
    });
    const sfAccount = sfAccountMap.get(mappedAccount.simplefin_account_id);
    if (!sfAccount) {
      continue;
    }

    // Investment accounts with holdings but no transactions should still be processed
    // to ensure child accounts are created from holdings data
    if (!sfAccount.transactions || sfAccount.transactions.length === 0) {
      if (mappedAccount.is_investment && sfAccount.holdings && sfAccount.holdings.length > 0) {
        // Pre-create child accounts from holdings so they appear in the account tree
        const holdingsSymbolSet = buildSymbolSet(sfAccount.holdings);
        for (const [symbol, desc] of holdingsSymbolSet) {
          try {
            await getOrCreateChildAccount(mappedAccount.gnucash_account_guid, symbol, desc, bookGuid, bookAccountGuidSet, accountsCreated);
          } catch (err) {
            result.errors.push({
              account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
              error: `Failed to create child account for ${symbol}: ${err}`,
            });
          }
        }
        try {
          await getOrCreateCashChild(mappedAccount.gnucash_account_guid, bookGuid, bookAccountGuidSet, accountsCreated);
        } catch (err) {
          // Named as a sync error like the symbol children above, rather than
          // thrown: an unhandled throw here abandons every remaining mapped
          // account. Recording it still forces status='failed' in
          // finalizeSimpleFinSync, so a failed resolution can never be
          // reported as a successful sync.
          result.errors.push({
            account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
            error: `Failed to create Cash child account: ${err}`,
          });
        }
        result.accountsProcessed++;
      }
      continue;
    }

    result.accountsProcessed++;
    let earliestFailedPostDate: Date | null = null;

    try {
      // Get existing SimpleFin transaction IDs for this account to dedup
      const existingMeta = await prisma.gnucash_web_transaction_meta.findMany({
        where: {
          OR: [
            { simplefin_transaction_id: { not: null } },
            { simplefin_transaction_id_2: { not: null } },
          ],
        },
        select: {
          simplefin_transaction_id: true,
          simplefin_transaction_id_2: true,
        },
      });
      const existingIds = new Set<string>();
      for (const m of existingMeta) {
        if (m.simplefin_transaction_id) existingIds.add(m.simplefin_transaction_id);
        if (m.simplefin_transaction_id_2) existingIds.add(m.simplefin_transaction_id_2);
      }

      // Get the GnuCash account's commodity/currency for the splits
      const gnucashAccount = await prisma.accounts.findFirst({
        where: {
          guid: { equals: mappedAccount.gnucash_account_guid, in: bookAccountGuids },
        },
        include: { commodity: true },
      });

      if (!gnucashAccount) {
        result.errors.push({
          account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
          error: 'Mapped GnuCash account not found',
        });
        continue;
      }

      if (!gnucashAccount.commodity_guid) {
        result.errors.push({
          account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
          error: 'GnuCash account has no currency assigned',
        });
        continue;
      }

      const currencyGuid = gnucashAccount.commodity_guid;
      const currencyMnemonic = gnucashAccount.commodity?.mnemonic || 'USD';

      // Build holdings symbol set if investment account
      const sfHoldings: SimpleFinHolding[] = sfAccount.holdings || [];
      const symbolSet = mappedAccount.is_investment ? buildSymbolSet(sfHoldings) : new Map<string, string>();

      // Pre-resolve Cash child guid for investment accounts (avoids repeated lookups)
      let cashChildGuid: string | undefined;
      if (mappedAccount.is_investment) {
        cashChildGuid = await getOrCreateCashChild(mappedAccount.gnucash_account_guid, bookGuid, bookAccountGuidSet, accountsCreated);
      }

      for (const sfTxn of sfAccount.transactions) {
        // Dedup by SimpleFin transaction ID
        if (existingIds.has(sfTxn.id)) {
          result.transactionsSkipped++;
          continue;
        }

        // Period lock: never write into a closed period
        if (findLockedDate(lockDate, [normalizePostDate(sfTxn.posted)]) !== null) {
          result.transactionsSkipped++;
          continue;
        }

        // Manual reconciliation: match to existing manually-entered transaction
        const accountScu = gnucashAccount.commodity_scu || 100;
        if (await findAndLinkManualMatch(sfTxn, mappedAccount.gnucash_account_guid, accountScu)) {
          result.transactionsMatched.manualReconciliation++;
          existingIds.add(sfTxn.id);
          continue;
        }

        // Transfer dedup: match to existing import from another SimpleFin-mapped account
        if (allMappedAccountGuids.length > 1 &&
            await findAndLinkTransferDedupMatch(sfTxn, mappedAccount.gnucash_account_guid, allMappedAccountGuids, accountScu)) {
          result.transactionsMatched.transferDedup++;
          existingIds.add(sfTxn.id);
          continue;
        }

        try {
          if (mappedAccount.is_investment) {
            // Investment mode: route to child account by symbol
            const match = parseSymbol(sfTxn.description || '', symbolSet);
            let targetAccountGuid: string;
            let isSymbolMatched: boolean;

            if (match) {
              const holdingDesc = symbolSet.get(match.symbol) || match.symbol;
              targetAccountGuid = await getOrCreateChildAccount(
                mappedAccount.gnucash_account_guid,
                match.symbol,
                holdingDesc,
                bookGuid,
                bookAccountGuidSet,
                accountsCreated,
              );
              isSymbolMatched = true;
            } else {
              // No symbol match -- route to Cash child
              targetAccountGuid = cashChildGuid!;
              isSymbolMatched = false;
            }

            await importInvestmentTransaction(
              sfTxn,
              targetAccountGuid,
              cashChildGuid!,
              isSymbolMatched,
              currencyGuid,
              currencyMnemonic,
              bookGuid,
              bookAccountGuidSet,
              mappedAccount.gnucash_account_guid,
            );
            result.investmentTransactionsImported++;
          } else {
            // Normal mode: route directly to mapped account
            await importTransaction(
              sfTxn,
              mappedAccount.gnucash_account_guid,
              currencyGuid,
              currencyMnemonic,
              bookGuid,
              bookAccountGuidSet,
            );
          }
          result.transactionsImported++;
          existingIds.add(sfTxn.id); // Prevent re-import within same sync

          const importedPostDate = normalizePostDate(sfTxn.posted);
          if (!earliestImportedPostDate || importedPostDate < earliestImportedPostDate) {
            earliestImportedPostDate = importedPostDate;
          }
        } catch (err) {
          if (isSimpleFinDuplicateViolation(err)) {
            // Unique violation on simplefin_transaction_id: a concurrent
            // sync already imported this transaction (the whole insert
            // transaction rolled back, so nothing was half-written). Count
            // it as a skipped duplicate rather than failing the sync.
            result.transactionsSkipped++;
            existingIds.add(sfTxn.id);
            continue;
          }
          const accountLabel = mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id;
          result.errors.push({
            account: accountLabel,
            error: `Failed to import transaction ${sfTxn.id}: ${err}`,
          });
          const failedPostDate = normalizePostDate(sfTxn.posted);
          if (!earliestFailedPostDate || failedPostDate < earliestFailedPostDate) {
            earliestFailedPostDate = failedPostDate;
          }
          recordFailedImport(failedImports, accountLabel, failedPostDate);
        }
      }

      // Update last_sync_at and balance on the account mapping
      const now = new Date();
      // Keep the cursor at the oldest failed transaction so the next overlap
      // necessarily re-fetches it. Advancing to now would permanently lose a
      // failed row older than the normal seven-day overlap.
      const safeSyncCursor = computeSafeSyncCursor(
        now,
        earliestFailedPostDate ? [earliestFailedPostDate] : [],
      );
      if (sfAccount.balance !== undefined) {
        await prisma.gnucash_web_simplefin_account_map.update({
          where: { id: mappedAccount.id },
          data: {
            last_balance: parseFloat(sfAccount.balance),
            last_balance_date: now,
            last_sync_at: safeSyncCursor,
          },
        });
      } else {
        await prisma.gnucash_web_simplefin_account_map.update({
          where: { id: mappedAccount.id },
          data: { last_sync_at: safeSyncCursor },
        });
      }
    } catch (err) {
      result.errors.push({
        account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
        error: `Sync failed: ${err}`,
      });
    }
  }

  // Invalidate dashboard metric caches from the earliest imported transaction
  // date forward. Runs regardless of sync status: even a partially failed sync
  // may have imported transactions. Failures must never fail the sync.
  if (earliestImportedPostDate) {
    try {
      await cacheInvalidateFrom(bookGuid, earliestImportedPostDate);
    } catch (err) {
      console.warn('SimpleFin sync cache invalidation failed:', err);
    }

    // Tell connected browsers the book changed. Sync may auto-create accounts
    // (new bank links), so publish both entities; the sync often runs in the
    // worker process, where this bus is the only path to web-process viewers.
    void publishDataChange(bookGuid, 'transactions', { action: 'bulk' });
    void publishDataChange(bookGuid, 'accounts', { action: 'bulk' });

    emitProgress({ message: 'Running post-sync scans…', percent: 92 });

    // Scan freshly imported spending for anomalies / fraud and push alerts.
    // scanForAnomalies is internally guarded and never throws, but wrap the
    // call anyway so nothing here can fail the sync.
    try {
      await scanForAnomalies(bookGuid, { userId: connection.user_id });
    } catch (err) {
      console.warn('SimpleFin sync anomaly scan failed:', err);
    }

    // Evaluate budget overspend/threshold alerts against the freshly imported
    // spending. scanBudgetAlerts is internally guarded and never throws, but
    // wrap the call anyway so nothing here can fail the sync.
    try {
      await scanBudgetAlerts(bookGuid, { userId: connection.user_id });
    } catch (err) {
      console.warn('SimpleFin sync budget alert scan failed:', err);
    }

    // Check inventory reorder points and push low-stock alerts.
    // scanInventoryReorder is internally guarded and never throws, but wrap
    // the call anyway so nothing here can fail the sync.
    try {
      await scanInventoryReorder(bookGuid, { userId: connection.user_id });
    } catch (err) {
      console.warn('SimpleFin sync inventory reorder scan failed:', err);
    }
  } else if (accountsCreated.count > 0) {
    // No transactions landed, but new accounts exist: without this the
    // event-evicted hierarchy caches would hide them for up to 24h.
    try {
      await cacheInvalidateFrom(bookGuid, new Date(0));
    } catch (err) {
      console.warn('SimpleFin sync cache invalidation failed:', err);
    }
    void publishDataChange(bookGuid, 'accounts', { action: 'bulk' });
  }

  // Generate any due recurring invoices/bills. Runs on every sync (not only
  // when transactions were imported) — recurrence due dates pass regardless
  // of bank activity. The runner claims each occurrence atomically, so
  // overlapping syncs cannot double-generate; wrap the call so nothing here
  // can fail the sync.
  try {
    await runDueRecurringInvoices(bookGuid, { userId: connection.user_id });
  } catch (err) {
    console.warn('SimpleFin sync recurring invoice run failed:', err);
  }

  await finalizeSimpleFinSync(
    connection,
    bookGuid,
    connectionId,
    result,
    options,
    [...failedImports.values()],
  );

  return result;
}

/**
 * Persist the terminal result and surface failures consistently for both the
 * normal import path and early exits after mapping validation.
 */
async function finalizeSimpleFinSync(
  connection: { user_id: number },
  bookGuid: string,
  connectionId: number,
  result: SyncResult,
  options: SyncSimpleFinOptions,
  failedImports: FailedImportRange[] = [],
): Promise<void> {
  if (result.errors.length > 0) {
    result.status = 'failed';
    await updateSimpleFinConnectionSyncStatus(
      connectionId,
      'failed',
      result.errors.map(err => `${err.account}: ${err.error}`).join('\n'),
    );
    await createSimpleFinNotification(
      connection.user_id,
      bookGuid,
      connectionId,
      result,
      options,
      [...failedImports.values()],
    );
  } else {
    await updateSimpleFinConnectionSyncStatus(connectionId, 'success');
    if (options.notifyOnSuccess) {
      await createSimpleFinNotification(connection.user_id, bookGuid, connectionId, result, options);
    }
  }
}

/**
 * Has this exact notification already been raised? Mirrors the dedup
 * convention used by `syncSimpleFinStatusNotification`, compliance reminders
 * and recurring invoices: a stable (source, source_id) plus an existence check
 * — the notifications table has no unique index to upsert against.
 */
async function simpleFinNotificationExists(userId: number, sourceId: string): Promise<boolean> {
  await ensureNotificationsTable();
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id
    FROM gnucash_web_notifications
    WHERE user_id = ${userId}
      AND source = 'simplefin'
      AND source_id = ${sourceId}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function createSimpleFinNotification(
  userId: number,
  bookGuid: string,
  connectionId: number,
  result: SyncResult,
  options: SyncSimpleFinOptions,
  failedImports: FailedImportRange[] = [],
) {
  try {
    const source = options.source || 'unknown';
    const matched = result.transactionsMatched.manualReconciliation + result.transactionsMatched.transferDedup;
    const summary = `Imported ${result.transactionsImported} transaction${result.transactionsImported === 1 ? '' : 's'}, skipped ${result.transactionsSkipped}, matched ${matched}.`;

    if (result.status === 'success') {
      await createNotification({
        userId,
        bookGuid,
        type: 'simplefin_sync',
        severity: 'success',
        title: source === 'manual' ? 'Manual SimpleFin sync finished' : 'SimpleFin sync finished',
        message: summary,
        href: '/settings/connections',
        source: 'simplefin',
        // Success notifications are opt-in (manual sync / notifyOnSuccess), and
        // each successful run is a distinct event the user asked to see — so
        // this one stays unique on purpose.
        sourceId: `simplefin:${source}:success:${Date.now()}`,
      });
      return;
    }

    const errorText = result.errors.map(err => `${err.account}: ${err.error}`).join('\n') || 'SimpleFin sync failed.';
    const failedDetail = describeFailedImports(failedImports);

    // Stable key: connection + status + a fingerprint of the errors. A run that
    // keeps failing the same way every 2 hours now dedupes into ONE
    // notification. `source` (manual/scheduled) is deliberately NOT in the key:
    // a manual retry of an already-reported failure is the same failure.
    const sourceId = `simplefin:${connectionId}:${result.status}:${simpleFinErrorFingerprint(result.errors)}`;
    if (await simpleFinNotificationExists(userId, sourceId)) return;

    await createNotification({
      userId,
      bookGuid,
      type: 'simplefin_sync',
      severity: result.status === 'revoked' ? 'error' : 'warning',
      title: result.status === 'revoked' ? 'SimpleFin connection revoked' : 'SimpleFin sync needs attention',
      message: failedDetail ? `${errorText}\n\n${failedDetail}` : errorText,
      href: '/settings/connections',
      source: 'simplefin',
      sourceId,
    });
  } catch (error) {
    console.warn('Failed to create SimpleFin notification:', error);
  }
}

/**
 * Candidate for manual reconciliation matching.
 */
export interface ReconciliationCandidate {
  transaction_guid: string;
  post_date: Date;
  description: string;
  has_meta: boolean;
}

/**
 * Select the best manual reconciliation match from candidates.
 * Candidates already have correct amount (filtered by DB query).
 * Applies date window filtering and tie-breaking.
 */
export function selectManualReconciliationMatch(
  sfTxn: { posted: number; description: string },
  candidates: ReconciliationCandidate[],
  matchWindowDays: number = getSimpleFinMatchWindowDays(),
): { transaction_guid: string; confidence: 'high' | 'medium'; has_meta: boolean } | null {
  const sfDate = new Date(sfTxn.posted * 1000);
  const sfDesc = (sfTxn.description || '').trim().toLowerCase();

  const scored = candidates
    .map(c => {
      const dayOffset = Math.abs(sfDate.getTime() - c.post_date.getTime()) / (1000 * 60 * 60 * 24);
      if (dayOffset > matchWindowDays) return null;

      const cDesc = (c.description || '').trim().toLowerCase();
      // Use word overlap scoring for better fuzzy matching
      // (e.g., "Chase Card Serv Online Payment" matches "Chase Amazon Prime Card Payment Cara")
      const sfWords = new Set(sfDesc.split(/\s+/).filter(w => w.length > 1));
      const cWords = new Set(cDesc.split(/\s+/).filter(w => w.length > 1));
      let commonWords = 0;
      for (const w of sfWords) {
        if (cWords.has(w)) commonWords++;
      }
      // Also compute prefix match as secondary signal
      let commonPrefix = 0;
      for (let i = 0; i < Math.min(sfDesc.length, cDesc.length); i++) {
        if (sfDesc[i] === cDesc[i]) commonPrefix++;
        else break;
      }
      // Combined score: word overlap (weighted higher) + prefix
      const descScore = commonWords * 100 + commonPrefix;

      return {
        ...c,
        dayOffset,
        descScore,
        confidence: (dayOffset <= 1 ? 'high' : 'medium') as 'high' | 'medium',
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (a.dayOffset !== b.dayOffset) return a.dayOffset - b.dayOffset;
    if (a.descScore !== b.descScore) return b.descScore - a.descScore;
    return 0;
  });

  const best = scored[0];
  return {
    transaction_guid: best.transaction_guid,
    confidence: best.confidence,
    has_meta: best.has_meta,
  };
}

/**
 * Candidate for transfer dedup matching.
 */
export interface TransferDedupCandidate {
  transaction_guid: string;
  post_date: Date;
  split_account_guid: string;
  dest_split_guid: string;
  dest_account_guid: string;
}

/**
 * Select the best transfer dedup match from candidates.
 * Candidates already have opposite amount (filtered by DB query).
 * Returns null if no candidate is within the configured date window.
 */
export function selectTransferDedupMatch(
  sfTxn: { posted: number; amount: string; description: string },
  candidates: TransferDedupCandidate[],
  matchWindowDays: number = getSimpleFinMatchWindowDays(),
): TransferDedupCandidate | null {
  const sfDate = new Date(sfTxn.posted * 1000);

  const scored = candidates
    .map(c => {
      const dayOffset = Math.abs(sfDate.getTime() - c.post_date.getTime()) / (1000 * 60 * 60 * 24);
      if (dayOffset > matchWindowDays) return null;
      return { ...c, dayOffset };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (scored.length === 0) return null;

  scored.sort((a, b) => a.dayOffset - b.dayOffset);

  return scored[0];
}

/**
 * Search for and link a manual reconciliation match.
 * Returns true if a match was found and linked.
 */
async function findAndLinkManualMatch(
  sfTxn: SimpleFinTransaction,
  bankAccountGuid: string,
  accountScu: number = 100,
): Promise<boolean> {
  const amount = parseFloat(sfTxn.amount);
  if (isNaN(amount) || amount === 0) return false;

  const postDate = new Date(sfTxn.posted * 1000);
  const matchWindowDays = getSimpleFinMatchWindowDays();
  // Use the account's commodity_scu for correct precision (e.g., 100 for USD, 1 for JPY, 1000 for KWD)
  const scuPrecision = Math.round(Math.log10(accountScu));
  const { num: absNum, denom } = toNumDenom(Math.abs(amount), scuPrecision);
  const valueNum = amount > 0 ? absNum : -absNum;

  // Find transactions in the same account with exact amount, within the configured date window,
  // not already linked to a SimpleFin ID, not soft-deleted
  const candidates = await prisma.$queryRaw<ReconciliationCandidate[]>`
    SELECT
      t.guid AS transaction_guid,
      t.post_date,
      COALESCE(NULLIF(btrim(m.original_description), ''), t.description) AS description,
      CASE WHEN m.id IS NOT NULL THEN TRUE ELSE FALSE END AS has_meta
    FROM transactions t
    JOIN splits s ON s.tx_guid = t.guid AND s.account_guid = ${bankAccountGuid}
    LEFT JOIN gnucash_web_transaction_meta m ON m.transaction_guid = t.guid
    WHERE s.value_num = ${BigInt(valueNum)}
      AND s.value_denom = ${BigInt(denom)}
      AND t.post_date BETWEEN ${new Date(postDate.getTime() - matchWindowDays * 86400000)}
                          AND ${new Date(postDate.getTime() + matchWindowDays * 86400000)}
      AND (m.simplefin_transaction_id IS NULL)
      AND (m.deleted_at IS NULL OR m.id IS NULL)
    ORDER BY t.post_date ASC, t.enter_date ASC
  `;

  const match = selectManualReconciliationMatch(sfTxn, candidates, matchWindowDays);
  if (!match) return false;

  // Wrap in transaction for atomicity. The provider's raw payee is preserved
  // in original_description via COALESCE — set only when still null, never
  // overwriting an original captured earlier.
  const providerPayee = importedOriginalDescription(sfTxn);
  await prisma.$transaction(async (tx) => {
    if (match.has_meta) {
      await tx.$executeRaw`
        UPDATE gnucash_web_transaction_meta
        SET simplefin_transaction_id = ${sfTxn.id},
            match_type = 'manual_reconciliation',
            match_confidence = ${match.confidence},
            matched_at = NOW(),
            original_description = COALESCE(original_description, ${providerPayee})
        WHERE transaction_guid = ${match.transaction_guid}
      `;
    } else {
      await tx.gnucash_web_transaction_meta.create({
        data: {
          transaction_guid: match.transaction_guid,
          source: 'manual',
          reviewed: true,
          simplefin_transaction_id: sfTxn.id,
          match_type: 'manual_reconciliation',
          match_confidence: match.confidence,
          matched_at: new Date(),
          original_description: providerPayee,
        },
      });
    }
  });

  return true;
}

/**
 * Search for and link a transfer dedup match.
 * Returns true if a match was found and linked.
 */
async function findAndLinkTransferDedupMatch(
  sfTxn: SimpleFinTransaction,
  bankAccountGuid: string,
  allMappedAccountGuids: string[],
  accountScu: number = 100,
): Promise<boolean> {
  const amount = parseFloat(sfTxn.amount);
  if (isNaN(amount) || amount === 0) return false;

  const postDate = new Date(sfTxn.posted * 1000);
  const matchWindowDays = getSimpleFinMatchWindowDays();
  // Use the account's commodity_scu for correct precision
  const scuPrecision = Math.round(Math.log10(accountScu));
  const { num: absNum, denom } = toNumDenom(Math.abs(amount), scuPrecision);
  const oppositeValueNum = amount > 0 ? -absNum : absNum;

  const otherMappedGuids = allMappedAccountGuids.filter(g => g !== bankAccountGuid);
  if (otherMappedGuids.length === 0) return false;

  // Only match 2-split transactions to avoid ambiguity with multi-split transactions
  const candidates = await prisma.$queryRaw<TransferDedupCandidate[]>`
    SELECT DISTINCT ON (t.guid)
      t.guid AS transaction_guid,
      t.post_date,
      s1.account_guid AS split_account_guid,
      s2.guid AS dest_split_guid,
      s2.account_guid AS dest_account_guid
    FROM transactions t
    JOIN splits s1 ON s1.tx_guid = t.guid AND s1.account_guid = ANY(${otherMappedGuids})
    JOIN splits s2 ON s2.tx_guid = t.guid AND s2.guid != s1.guid
    JOIN gnucash_web_transaction_meta m ON m.transaction_guid = t.guid
    WHERE s1.value_num = ${BigInt(oppositeValueNum)}
      AND s1.value_denom = ${BigInt(denom)}
      -- Candidate = a transaction that already carries exactly ONE feed id.
      -- How it got that id doesn't matter: a plain simplefin import OR a
      -- manually-entered transfer the user (or matcher) reconciled against the
      -- other account's feed record. Requiring source='simplefin' here caused
      -- duplicates: a manual transfer between two synced accounts got matched
      -- to one side's feed record via manual_reconciliation, then the other
      -- side's feed record failed this filter and was imported again.
      AND m.simplefin_transaction_id IS NOT NULL
      AND m.simplefin_transaction_id != ${sfTxn.id}
      AND m.simplefin_transaction_id_2 IS NULL
      AND t.post_date BETWEEN ${new Date(postDate.getTime() - matchWindowDays * 86400000)}
                          AND ${new Date(postDate.getTime() + matchWindowDays * 86400000)}
      AND (m.deleted_at IS NULL)
      AND (SELECT COUNT(*) FROM splits WHERE tx_guid = t.guid) = 2
    ORDER BY t.guid, t.post_date ASC
  `;

  const match = selectTransferDedupMatch(sfTxn, candidates, matchWindowDays);
  if (!match) return false;

  // Wrap meta update in a transaction for atomicity
  await prisma.$transaction(async (tx) => {
    await tx.gnucash_web_transaction_meta.update({
      where: { transaction_guid: match.transaction_guid },
      data: {
        simplefin_transaction_id_2: sfTxn.id,
        match_type: 'transfer_dedup',
        match_confidence: 'high',
        matched_at: new Date(),
      },
    });
  });

  return true;
}

/**
 * The raw provider payee/description an import arrived with. Preserved on the
 * meta row (original_description) so a later rename of the transaction can
 * never destroy the payee. Null when the provider sent neither field.
 */
export function importedOriginalDescription(
  sfTxn: Pick<SimpleFinTransaction, 'description' | 'payee'>,
): string | null {
  return sfTxn.description || sfTxn.payee || null;
}

/**
 * Meta row data for a freshly imported SimpleFin transaction. Exported for
 * tests: imports arrive unreviewed, carry their feed id for dedup, and keep
 * the ORIGINAL provider description so renames preserve the payee.
 */
export function buildImportedTransactionMeta(
  sfTxn: Pick<SimpleFinTransaction, 'id' | 'description' | 'payee'>,
  transactionGuid: string,
  confidence: 'high' | 'medium' | 'low',
) {
  return {
    transaction_guid: transactionGuid,
    source: 'simplefin',
    reviewed: false,
    simplefin_transaction_id: sfTxn.id,
    confidence,
    original_description: importedOriginalDescription(sfTxn),
  };
}

/**
 * Import a single SimpleFin transaction into GnuCash.
 */
async function importTransaction(
  sfTxn: SimpleFinTransaction,
  bankAccountGuid: string,
  currencyGuid: string,
  currencyMnemonic: string,
  bookGuid: string,
  bookAccountGuids: ReadonlySet<string>,
): Promise<void> {
  const amount = parseFloat(sfTxn.amount);
  if (isNaN(amount) || amount === 0) return;

  // Guess the destination account: explicit rules first, then history
  const guess = await guessCategory(
    bankAccountGuid,
    sfTxn.description || sfTxn.payee || '',
    currencyMnemonic,
    bookGuid,
    bookAccountGuids,
  );
  const destAccountGuid = guess.accountGuid;

  const postDate = normalizePostDate(sfTxn.posted);
  const description = sfTxn.description || sfTxn.payee || 'SimpleFin Import';
  const memo = sfTxn.pending ? '(Pending) ' + (sfTxn.memo || '') : (sfTxn.memo || '');

  const txGuid = generateGuid();
  const split1Guid = generateGuid();
  const split2Guid = generateGuid();

  // Amount: positive = money in (credit to bank), negative = money out (debit from bank)
  const { num: absNum, denom } = toNumDenom(Math.abs(amount));
  const bankValueNum = amount > 0 ? absNum : -absNum;
  const destValueNum = amount > 0 ? -absNum : absNum;

  await prisma.$transaction(async (tx) => {
    // Create transaction
    await tx.transactions.create({
      data: {
        guid: txGuid,
        currency_guid: currencyGuid,
        num: '',
        post_date: postDate,
        enter_date: new Date(),
        description,
      },
    });

    // Bank account split
    await tx.splits.create({
      data: {
        guid: split1Guid,
        tx_guid: txGuid,
        account_guid: bankAccountGuid,
        memo: memo,
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: BigInt(bankValueNum),
        value_denom: BigInt(denom),
        quantity_num: BigInt(bankValueNum),
        quantity_denom: BigInt(denom),
        lot_guid: null,
      },
    });

    // Destination account split (opposite sign)
    await tx.splits.create({
      data: {
        guid: split2Guid,
        tx_guid: txGuid,
        account_guid: destAccountGuid,
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: BigInt(destValueNum),
        value_denom: BigInt(denom),
        quantity_num: BigInt(destValueNum),
        quantity_denom: BigInt(denom),
        lot_guid: null,
      },
    });

    // Insert transaction meta (reviewed=false for imports; the raw provider
    // description is preserved in original_description)
    await tx.gnucash_web_transaction_meta.create({
      data: buildImportedTransactionMeta(sfTxn, txGuid, guess.confidence),
    });
  });
}

/**
 * Result of a category guess: the destination account plus how confident we
 * are in it. Rule matches are 'high', history-based guesses are 'medium',
 * and Imbalance fallbacks are 'low'. Stored in transaction_meta.confidence.
 */
interface CategoryGuess {
  accountGuid: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Guess the destination account for an imported transaction.
 * Order of precedence:
 * 1. Explicit user-defined categorization rules (settings/rules) — 'high'
 * 2. Most frequent historical counterpart account for similar descriptions — 'medium'
 * 3. Imbalance-{currency} fallback — 'low'
 */
async function guessCategory(
  bankAccountGuid: string,
  description: string,
  currencyMnemonic: string,
  bookGuid: string,
  bookAccountGuids: ReadonlySet<string>,
): Promise<CategoryGuess> {
  if (!description.trim()) {
    return {
      accountGuid: await getOrCreateImbalanceAccount(currencyMnemonic, bookGuid, bookAccountGuids),
      confidence: 'low',
    };
  }

  // 1. Explicit user rules take precedence over any history-based guess.
  // Rule failures must never fail the import; fall through to history.
  try {
    const ruleAccountGuid = await applyRules(bookGuid, description);
    if (ruleAccountGuid && bookAccountGuids.has(ruleAccountGuid)) {
      return { accountGuid: ruleAccountGuid, confidence: 'high' };
    }
    if (ruleAccountGuid) {
      console.warn('Categorization rule resolved an account outside the synced book; falling back to history guess');
    }
  } catch (err) {
    console.warn('Categorization rules lookup failed, falling back to history guess:', err);
  }

  // 2. Find the most frequent counterpart account for similar descriptions.
  // History is keyed on the preserved import-time payee (original_description)
  // with the display description as fallback, so user renames ("pajamas") do
  // not hide the vendor history the incoming feed description matches.
  const matches = await prisma.$queryRaw<{ account_guid: string; cnt: bigint }[]>`
    SELECT s2.account_guid, COUNT(*) as cnt
    FROM transactions t
    JOIN splits s1 ON s1.tx_guid = t.guid AND s1.account_guid = ${bankAccountGuid}
    JOIN splits s2 ON s2.tx_guid = t.guid AND s2.account_guid != ${bankAccountGuid}
    LEFT JOIN gnucash_web_transaction_meta m ON m.transaction_guid = t.guid
    WHERE LOWER(COALESCE(NULLIF(btrim(m.original_description), ''), t.description))
          LIKE LOWER(${`%${description.substring(0, 50)}%`})
      AND s2.account_guid = ANY(${[...bookAccountGuids]})
    GROUP BY s2.account_guid
    ORDER BY cnt DESC
    LIMIT 1
  `;

  if (matches.length > 0 && Number(matches[0].cnt) >= 2) {
    return { accountGuid: matches[0].account_guid, confidence: 'medium' };
  }

  return {
    accountGuid: await getOrCreateImbalanceAccount(currencyMnemonic, bookGuid, bookAccountGuids),
    confidence: 'low',
  };
}

/**
 * Get or create the Imbalance-{currency} account.
 */
export async function getOrCreateImbalanceAccount(
  currencyMnemonic: string,
  bookGuid: string,
  bookAccountGuids: ReadonlySet<string>,
): Promise<string> {
  const imbalanceName = `Imbalance-${currencyMnemonic}`;

  // Get root account for this book
  const book = await prisma.books.findUnique({
    where: { guid: bookGuid },
    select: { root_account_guid: true },
  });

  if (!book) {
    throw new Error(`Book ${bookGuid} not found`);
  }

  // Get the currency commodity guid
  const currency = await prisma.commodities.findFirst({
    where: { mnemonic: currencyMnemonic, namespace: 'CURRENCY' },
  });

  if (!currency) {
    throw new Error(`Currency ${currencyMnemonic} not found`);
  }

  const rootGuid = book.root_account_guid;

  try {
    return await prisma.$transaction(async tx => {
      // The account-name key is sufficient to serialize this one natural key.
      // Deliberately do not take the broader blocking book lock: an XML import
      // can hold it longer than Prisma's interactive-transaction timeout,
      // whereas unrelated book work cannot affect this (parent, name) race.
      // Sole claim: this transaction takes exactly one account name key, so
      // there is no order to keep — and acquireSoleAccountNameLock refuses a
      // second one rather than let that stay true only by accident.
      await acquireSoleAccountNameLock(tx, rootGuid, imbalanceName);

      const existing = await tx.accounts.findFirst({
        // The initial book scope admits pre-existing Imbalance accounts at any
        // depth. The direct-root clause also sees an account a concurrent sync
        // just created after that scope snapshot was read.
        where: {
          name: imbalanceName,
          OR: [
            { guid: { in: [...bookAccountGuids] } },
            { parent_guid: rootGuid },
          ],
        },
        select: { guid: true },
      });
      if (existing) return existing.guid;

      const guid = generateGuid();
      await tx.accounts.create({
        data: {
          guid,
          name: imbalanceName,
          account_type: 'BANK',
          commodity_guid: currency.guid,
          commodity_scu: 100,
          non_std_scu: 0,
          parent_guid: rootGuid,
          code: '',
          description: 'Auto-created for unmatched SimpleFin imports',
          hidden: 0,
          placeholder: 0,
        },
      });
      return guid;
    });
  } catch (err) {
    // If a unique key on (parent_guid, name) does exist on this database (an
    // operator's, or an earlier release's — db-init drops that one), a lost
    // race surfaces as 23505 rather than as a duplicate row: adopt the winner
    // instead of failing the import.
    return adoptUniqueConflictWinner(err, ACCOUNT_SIBLING_UNIQUE_MARKERS, () =>
      // Re-read on the CONSTRAINT's own key, never on the book-scope snapshot:
      // that set is memoised for ~3s and is not invalidated by account
      // creation, so testing a just-created guid against it would fail closed.
      // (parent = this book's root) already implies membership.
      prisma.accounts.findFirst({
        where: { name: imbalanceName, parent_guid: rootGuid },
        select: { guid: true },
      }),
    );
  }
}

/**
 * Recover from a lost create-if-missing race: when `err` is the unique
 * violation named by `markers`, re-read the row the winner inserted and return
 * its guid.
 *
 * The re-read runs OUTSIDE the aborted transaction (a 23505 poisons it, so
 * nothing can be read back inside) and keys on the unique index's own columns,
 * which is why it cannot be defeated by a stale book-scope snapshot.
 *
 * Anything else — a different constraint, or a violation with no surviving row
 * to adopt (a same-named account created by something else, which is NOT a
 * safe substitute) — rethrows, so the caller records a sync error instead of
 * silently importing into the wrong account.
 */
async function adoptUniqueConflictWinner(
  err: unknown,
  markers: readonly string[],
  reread: () => Promise<{ guid: string } | null>,
): Promise<string> {
  if (!isUniqueViolationOn(err, markers)) throw err;
  const winner = await reread();
  if (winner) return winner.guid;
  throw err;
}

/**
 * Find or create a child account under the parent for a given stock symbol.
 * Creates the commodity if it doesn't exist, then creates a STOCK child account.
 *
 * Exported for tests: the create-if-missing race it guards is only observable
 * by calling it concurrently, and a test that re-implemented the guard instead
 * of exercising this function would prove nothing.
 */
export async function getOrCreateChildAccount(
  parentGuid: string,
  symbol: string,
  holdingDescription: string,
  bookGuid: string,
  bookAccountGuids: ReadonlySet<string>,
  created?: { count: number },
): Promise<string> {
  if (!bookAccountGuids.has(parentGuid)) {
    throw new Error(`Parent account ${parentGuid} is not in book ${bookGuid}`);
  }
  const mnemonic = symbol.toUpperCase();

  // Look for existing child with a commodity matching this symbol
  const existing = await findChildAccountBySymbol(prisma, parentGuid, mnemonic);
  if (existing) return existing;

  const commodity = await getOrCreateSymbolCommodity(mnemonic, holdingDescription);

  // The child account is named for the symbol, so the (parent, name) lock is
  // exactly the right key: it serializes concurrent syncs through the
  // check-then-create window, and the adoption path below is the fallback for a
  // database that also has a unique key of its own.
  let outcome: { guid: string; createdNew: boolean };
  try {
    outcome = await prisma.$transaction(async tx => {
      await acquireSoleAccountNameLock(tx, parentGuid, mnemonic);

      const won = await findChildAccountBySymbol(tx, parentGuid, mnemonic);
      if (won) return { guid: won, createdNew: false };

      const childGuid = generateGuid();
      await tx.accounts.create({
        data: {
          guid: childGuid,
          name: mnemonic,
          account_type: 'STOCK',
          commodity_guid: commodity.guid,
          commodity_scu: commodity.fraction,
          non_std_scu: 0,
          parent_guid: parentGuid,
          code: '',
          description: holdingDescription || `Auto-created for ${symbol}`,
          hidden: 0,
          placeholder: 0,
        },
      });
      return { guid: childGuid, createdNew: true };
    });
  } catch (err) {
    // Adopt on the SYMBOL, not on the name: a same-named sibling holding a
    // different commodity is a different security, and routing this symbol's
    // transactions into it would be a silent mis-import. When the re-read
    // finds no symbol match the original error is rethrown and surfaces as a
    // sync error, which is the correct outcome for a genuine name collision.
    const winner = await adoptUniqueConflictWinner(
      err,
      ACCOUNT_SIBLING_UNIQUE_MARKERS,
      async () => {
        const guid = await findChildAccountBySymbol(prisma, parentGuid, mnemonic);
        return guid ? { guid } : null;
      },
    );
    return winner;
  }

  // Counted only after the transaction commits — a rolled-back create must not
  // look like a new account to the cache-invalidation decision.
  if (outcome.createdNew && created) created.count++;
  return outcome.guid;
}

/**
 * Guid of the child account under `parentGuid` whose commodity carries
 * `mnemonic`, or null. Runs on whichever client is passed so the post-lock
 * re-check happens inside the locking transaction.
 */
async function findChildAccountBySymbol(
  client: Pick<typeof prisma, '$queryRaw'>,
  parentGuid: string,
  mnemonic: string,
): Promise<string | null> {
  const rows = await client.$queryRaw<{ guid: string }[]>`
    SELECT a.guid
    FROM accounts a
    JOIN commodities c ON c.guid = a.commodity_guid
    WHERE a.parent_guid = ${parentGuid}
      AND UPPER(c.mnemonic) = ${mnemonic}
  `;
  return rows[0]?.guid ?? null;
}

/**
 * Find or create the commodity for a ticker symbol.
 *
 * Its own create-if-missing race, with its own DB arbiter
 * (`uq_commodities_namespace_mnemonic`): two syncs seeing the same new holding
 * would otherwise insert the symbol twice, and duplicate commodities cannot be
 * merged automatically afterwards — accounts, prices and splits all reference
 * one by guid.
 *
 * The existence check stays deliberately namespace-agnostic (a symbol already
 * tracked as NASDAQ/NYSE must be reused, not shadowed), while the lock and the
 * insert use the UNKNOWN namespace this service creates under.
 */
async function getOrCreateSymbolCommodity(
  mnemonic: string,
  holdingDescription: string,
): Promise<{ guid: string; fraction: number }> {
  const existing = await prisma.commodities.findFirst({ where: { mnemonic } });
  if (existing) return existing;

  try {
    return await prisma.$transaction(async tx => {
      await acquireNamedXactLock(tx, commodityLockKey('UNKNOWN', mnemonic));

      const won = await tx.commodities.findFirst({ where: { mnemonic } });
      if (won) return won;

      return await tx.commodities.create({
        data: {
          guid: generateGuid(),
          namespace: 'UNKNOWN',
          mnemonic,
          fullname: holdingDescription || mnemonic,
          cusip: '',
          fraction: 10000,
          quote_flag: 1,
          quote_source: 'yahoo_json',
          quote_tz: '',
        },
      });
    });
  } catch (err) {
    if (!isUniqueViolationOn(err, COMMODITY_UNIQUE_MARKERS)) throw err;
    const winner = await prisma.commodities.findFirst({ where: { mnemonic } });
    if (!winner) throw err;
    return winner;
  }
}

/** Name of the brokerage sweep child account this service auto-creates. */
const CASH_CHILD_NAME = 'Cash';

/**
 * Find or create a Cash child account under the parent.
 * Uses the parent's commodity (USD) and account type.
 *
 * Exported for tests — see `getOrCreateChildAccount`.
 */
export async function getOrCreateCashChild(
  parentGuid: string,
  bookGuid: string,
  bookAccountGuids: ReadonlySet<string>,
  created?: { count: number },
): Promise<string> {
  if (!bookAccountGuids.has(parentGuid)) {
    throw new Error(`Parent account ${parentGuid} is not in book ${bookGuid}`);
  }
  const existing = await prisma.accounts.findFirst({
    where: { parent_guid: parentGuid, name: CASH_CHILD_NAME },
  });
  if (existing) return existing.guid;

  const parent = await prisma.accounts.findFirst({
    where: { guid: { equals: parentGuid, in: [...bookAccountGuids] } },
  });
  if (!parent) throw new Error(`Parent account ${parentGuid} not found`);

  let outcome: { guid: string; createdNew: boolean };
  try {
    outcome = await prisma.$transaction(async tx => {
      await acquireSoleAccountNameLock(tx, parentGuid, CASH_CHILD_NAME);

      const won = await tx.accounts.findFirst({
        where: { parent_guid: parentGuid, name: CASH_CHILD_NAME },
        select: { guid: true },
      });
      if (won) return { guid: won.guid, createdNew: false };

      const childGuid = generateGuid();
      await tx.accounts.create({
        data: {
          guid: childGuid,
          name: CASH_CHILD_NAME,
          account_type: parent.account_type,
          commodity_guid: parent.commodity_guid!,
          commodity_scu: parent.commodity_scu,
          non_std_scu: 0,
          parent_guid: parentGuid,
          code: '',
          description: 'Cash balance (auto-created for SimpleFin)',
          hidden: 0,
          placeholder: 0,
        },
      });
      return { guid: childGuid, createdNew: true };
    });
  } catch (err) {
    // (parent_guid, name) IS the unique index's key, and the parent was just
    // confirmed to be in this book, so the adopted row is in-book by
    // construction — no book-scope re-check, hence nothing to go stale.
    return adoptUniqueConflictWinner(err, ACCOUNT_SIBLING_UNIQUE_MARKERS, () =>
      prisma.accounts.findFirst({
        where: { parent_guid: parentGuid, name: CASH_CHILD_NAME },
        select: { guid: true },
      }),
    );
  }

  if (outcome.createdNew && created) created.count++;
  return outcome.guid;
}

/**
 * Import a single SimpleFin transaction into GnuCash for an INVESTMENT account.
 *
 * This differs from `importTransaction` in two key ways:
 * 1. The counter-account for symbol-matched transactions is the Cash child
 *    (representing the brokerage sweep/cash account), NOT guessCategory.
 * 2. For unmatched transactions routed to Cash child, guessCategory IS used
 *    as the counter-account (same as normal import behavior).
 *
 * NOTE: Phase 1 limitation - quantity is stored in dollar terms, not shares.
 * SimpleFin does not provide per-transaction share quantities. Both value_num
 * and quantity_num are set to the dollar amount for ALL splits, including
 * STOCK child account splits. This is technically incorrect for STOCK accounts
 * where quantity should represent shares, but it still achieves the primary
 * goal of organizing transactions by security symbol.
 *
 * // TODO Phase 2: compute share quantities from holdings price data.
 * // SimpleFin provides shares and market_value per holding. Combined with
 * // daily price data from yahoo-finance2 price backfill, share quantities
 * // could be derived: shares = dollar_amount / price_per_share_on_date.
 *
 * NOTE: We intentionally do NOT use processMultiCurrencySplits() from
 * src/lib/trading-accounts.ts here. That utility is for multi-CURRENCY
 * transactions (e.g., USD to EUR). GnuCash desktop's default behavior
 * for stock purchases does not create trading account entries. Since
 * Phase 1 stores value == quantity in dollar terms, there is no quantity
 * imbalance that trading accounts would need to resolve.
 */
async function importInvestmentTransaction(
  sfTxn: SimpleFinTransaction,
  targetAccountGuid: string,
  cashChildGuid: string,
  isSymbolMatched: boolean,
  currencyGuid: string,
  currencyMnemonic: string,
  bookGuid: string,
  bookAccountGuids: ReadonlySet<string>,
  bankAccountGuid: string,
): Promise<void> {
  const amount = parseFloat(sfTxn.amount);
  if (isNaN(amount) || amount === 0) return;

  // Determine the counter-account:
  // - Symbol-matched (STOCK child): counter = Cash child (brokerage sweep)
  // - Unmatched (Cash child): counter = guessCategory (same as normal import)
  let counterAccountGuid: string;
  let counterConfidence: 'high' | 'medium' | 'low' = 'medium';
  if (isSymbolMatched) {
    counterAccountGuid = cashChildGuid;
  } else {
    const guess = await guessCategory(
      bankAccountGuid,
      sfTxn.description || sfTxn.payee || '',
      currencyMnemonic,
      bookGuid,
      bookAccountGuids,
    );
    counterAccountGuid = guess.accountGuid;
    counterConfidence = guess.confidence;
  }

  const postDate = normalizePostDate(sfTxn.posted);
  const description = sfTxn.description || sfTxn.payee || 'SimpleFin Import';
  const memo = sfTxn.pending ? '(Pending) ' + (sfTxn.memo || '') : (sfTxn.memo || '');

  const txGuid = generateGuid();
  const split1Guid = generateGuid();
  const split2Guid = generateGuid();

  // NOTE: Phase 1 limitation - dollar amount used for both value and quantity.
  // For STOCK accounts, quantity should be in shares, but SimpleFin lacks
  // per-transaction share data. Both value and quantity are in dollar terms.
  const { num: absNum, denom } = toNumDenom(Math.abs(amount));
  const targetValueNum = amount > 0 ? absNum : -absNum;
  const counterValueNum = amount > 0 ? -absNum : absNum;

  await prisma.$transaction(async (tx) => {
    // Create transaction
    await tx.transactions.create({
      data: {
        guid: txGuid,
        currency_guid: currencyGuid,
        num: '',
        post_date: postDate,
        enter_date: new Date(),
        description,
      },
    });

    // Target account split (STOCK child or Cash child)
    // NOTE: quantity_num == value_num (dollar terms) - see Phase 1 limitation above
    await tx.splits.create({
      data: {
        guid: split1Guid,
        tx_guid: txGuid,
        account_guid: targetAccountGuid,
        memo: memo,
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: BigInt(targetValueNum),
        value_denom: BigInt(denom),
        quantity_num: BigInt(targetValueNum),   // Phase 1: dollar amount, not shares
        quantity_denom: BigInt(denom),           // Phase 1: dollar denom, not share denom
        lot_guid: null,
      },
    });

    // Counter-account split (Cash child for STOCK txns, guessCategory for Cash txns)
    await tx.splits.create({
      data: {
        guid: split2Guid,
        tx_guid: txGuid,
        account_guid: counterAccountGuid,
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: BigInt(counterValueNum),
        value_denom: BigInt(denom),
        quantity_num: BigInt(counterValueNum),
        quantity_denom: BigInt(denom),
        lot_guid: null,
      },
    });

    // Insert transaction meta (reviewed=false for imports; the raw provider
    // description is preserved in original_description)
    await tx.gnucash_web_transaction_meta.create({
      data: buildImportedTransactionMeta(
        sfTxn,
        txGuid,
        isSymbolMatched ? 'medium' : counterConfidence,
      ),
    });
  });
}

/**
 * Sync all active connections (used by the worker process).
 */
export async function syncAllConnections(): Promise<SyncResult[]> {
  const connections = await prisma.gnucash_web_simplefin_connections.findMany({
    where: { sync_enabled: true },
    select: { id: true, book_guid: true },
  });

  const results: SyncResult[] = [];

  for (const conn of connections) {
    try {
      const result = await syncSimpleFin(conn.id, conn.book_guid);
      results.push(result);
    } catch (error) {
      results.push({
        status: 'failed',
        fatal: true,
        revoked: false,
        accountsProcessed: 0,
        transactionsImported: 0,
        transactionsSkipped: 0,
        investmentTransactionsImported: 0,
        transactionsMatched: {
          manualReconciliation: 0,
          transferDedup: 0,
        },
        errors: [{ account: 'connection', error: `Sync failed: ${error}` }],
        warnings: [],
      });
    }
  }

  return results;
}
