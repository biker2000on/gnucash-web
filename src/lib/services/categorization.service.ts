/**
 * Auto-Categorization Rules Engine
 *
 * User-editable rules that map imported transaction descriptions to a target
 * category account. Checked BEFORE the history-based guess in the SimpleFin
 * sync engine. The table is feature-owned and lazily created here (do NOT add
 * it to db-init.ts), following the pattern in src/lib/notifications.ts.
 */

import prisma from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { selectHistoryCounterSplit } from '@/lib/bulk-edit';

export type MatchType = 'contains' | 'exact' | 'regex';

export const MATCH_TYPES: readonly MatchType[] = ['contains', 'exact', 'regex'] as const;

export function isMatchType(value: unknown): value is MatchType {
  return typeof value === 'string' && (MATCH_TYPES as readonly string[]).includes(value);
}

/**
 * Validate the mutable rule fields shared by the create and update API routes.
 * Returns an error message or null when valid. Fields left undefined are skipped.
 */
export function validateRuleFields(fields: {
  pattern?: unknown;
  matchType?: unknown;
  priority?: unknown;
}): string | null {
  if (fields.pattern !== undefined) {
    if (typeof fields.pattern !== 'string' || !fields.pattern.trim()) {
      return 'pattern must be a non-empty string';
    }
  }
  if (fields.matchType !== undefined && !isMatchType(fields.matchType)) {
    return "matchType must be one of: 'contains', 'exact', 'regex'";
  }
  if (fields.matchType === 'regex' && typeof fields.pattern === 'string') {
    try {
      new RegExp(fields.pattern, 'i');
    } catch {
      return 'pattern is not a valid regular expression';
    }
  }
  if (fields.priority !== undefined) {
    if (typeof fields.priority !== 'number' || !Number.isInteger(fields.priority)) {
      return 'priority must be an integer';
    }
  }
  return null;
}

export interface CategorizationRule {
  id: number;
  bookGuid: string;
  pattern: string;
  matchType: MatchType;
  accountGuid: string;
  priority: number;
  enabled: boolean;
  hitCount: number;
  lastHitAt: Date | null;
  createdAt: Date;
  /** Full account path from the account_hierarchy view (list queries only). */
  accountName?: string | null;
}

export interface RuleSuggestion {
  pattern: string;
  accountGuid: string;
  accountName: string | null;
  occurrences: number;
  /** Fraction (0..1) of occurrences that share the suggested account. */
  share: number;
}

interface RuleRow {
  id: number;
  book_guid: string;
  pattern: string;
  match_type: string;
  account_guid: string;
  priority: number;
  enabled: boolean;
  hit_count: number;
  last_hit_at: Date | null;
  created_at: Date;
  account_name?: string | null;
}

function rowToRule(row: RuleRow): CategorizationRule {
  return {
    id: row.id,
    bookGuid: row.book_guid,
    pattern: row.pattern,
    matchType: isMatchType(row.match_type) ? row.match_type : 'contains',
    accountGuid: row.account_guid,
    priority: row.priority,
    enabled: row.enabled,
    hitCount: row.hit_count,
    lastHitAt: row.last_hit_at,
    createdAt: row.created_at,
    ...(row.account_name !== undefined ? { accountName: row.account_name } : {}),
  };
}

let ensurePromise: Promise<void> | null = null;

/** Lazily create the rules table (idempotent, advisory-locked). */
export function ensureTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_categorization_rules_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_categorization_rules (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            pattern TEXT NOT NULL,
            match_type VARCHAR(20) NOT NULL DEFAULT 'contains',
            account_guid VARCHAR(32) NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            hit_count INTEGER NOT NULL DEFAULT 0,
            last_hit_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_categorization_rules_book_enabled
            ON gnucash_web_categorization_rules(book_guid, enabled);
        END $$;
      `);
    })();
    // Allow a retry on failure instead of caching the rejection forever
    ensurePromise.catch(() => { ensurePromise = null; });
  }
  return ensurePromise;
}

/**
 * Pure matcher. Case-insensitive for all match types.
 * - 'contains': substring match
 * - 'exact': full-string match (both sides trimmed)
 * - 'regex': case-insensitive RegExp; an invalid regex never matches
 * Higher priority wins; ties broken by lower id (older rule).
 * Disabled rules never match.
 */
export function matchRule(
  rules: CategorizationRule[],
  description: string,
): CategorizationRule | null {
  const desc = (description || '').trim();
  if (!desc) return null;
  const descLower = desc.toLowerCase();

  const candidates = rules.filter(rule => {
    if (!rule.enabled) return false;
    const pattern = (rule.pattern || '').trim();
    if (!pattern) return false;

    switch (rule.matchType) {
      case 'contains':
        return descLower.includes(pattern.toLowerCase());
      case 'exact':
        return descLower === pattern.toLowerCase();
      case 'regex':
        try {
          return new RegExp(pattern, 'i').test(desc);
        } catch {
          return false; // invalid regex never matches
        }
      default:
        return false;
    }
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id - b.id;
  });

  return candidates[0];
}

/** List all rules for a book (priority desc, id asc), with account fullnames. */
export async function listRules(bookGuid: string): Promise<CategorizationRule[]> {
  await ensureTable();
  const rows = await prisma.$queryRaw<RuleRow[]>`
    SELECT
      r.id, r.book_guid, r.pattern, r.match_type, r.account_guid,
      r.priority, r.enabled, r.hit_count, r.last_hit_at, r.created_at,
      ah.fullname AS account_name
    FROM gnucash_web_categorization_rules r
    LEFT JOIN account_hierarchy ah ON ah.guid = r.account_guid
    WHERE r.book_guid = ${bookGuid}
    ORDER BY r.priority DESC, r.id ASC
  `;
  return rows.map(rowToRule);
}

/** Fetch a single rule by id (book-scoped), with the target account fullname. */
export async function getRule(bookGuid: string, id: number): Promise<CategorizationRule | null> {
  await ensureTable();
  const rows = await prisma.$queryRaw<RuleRow[]>`
    SELECT
      r.id, r.book_guid, r.pattern, r.match_type, r.account_guid,
      r.priority, r.enabled, r.hit_count, r.last_hit_at, r.created_at,
      ah.fullname AS account_name
    FROM gnucash_web_categorization_rules r
    LEFT JOIN account_hierarchy ah ON ah.guid = r.account_guid
    WHERE r.id = ${id} AND r.book_guid = ${bookGuid}
  `;
  return rows.length > 0 ? rowToRule(rows[0]) : null;
}

/** List only enabled rules (no account name join; used on the sync hot path). */
export async function listEnabledRules(bookGuid: string): Promise<CategorizationRule[]> {
  await ensureTable();
  const rows = await prisma.$queryRaw<RuleRow[]>`
    SELECT id, book_guid, pattern, match_type, account_guid,
           priority, enabled, hit_count, last_hit_at, created_at
    FROM gnucash_web_categorization_rules
    WHERE book_guid = ${bookGuid} AND enabled = TRUE
    ORDER BY priority DESC, id ASC
  `;
  return rows.map(rowToRule);
}

export interface CreateRuleInput {
  pattern: string;
  matchType: MatchType;
  accountGuid: string;
  priority?: number;
  enabled?: boolean;
}

export async function createRule(
  bookGuid: string,
  input: CreateRuleInput,
): Promise<CategorizationRule> {
  await ensureTable();
  const rows = await prisma.$queryRaw<RuleRow[]>`
    INSERT INTO gnucash_web_categorization_rules
      (book_guid, pattern, match_type, account_guid, priority, enabled)
    VALUES (
      ${bookGuid},
      ${input.pattern},
      ${input.matchType},
      ${input.accountGuid},
      ${input.priority ?? 0},
      ${input.enabled ?? true}
    )
    RETURNING id, book_guid, pattern, match_type, account_guid,
              priority, enabled, hit_count, last_hit_at, created_at
  `;
  return rowToRule(rows[0]);
}

export interface UpdateRulePatch {
  pattern?: string;
  matchType?: MatchType;
  accountGuid?: string;
  priority?: number;
  enabled?: boolean;
}

/** Update a rule (book-scoped). Returns the updated rule or null if not found. */
export async function updateRule(
  bookGuid: string,
  id: number,
  patch: UpdateRulePatch,
): Promise<CategorizationRule | null> {
  await ensureTable();
  const existingRows = await prisma.$queryRaw<RuleRow[]>`
    SELECT id, book_guid, pattern, match_type, account_guid,
           priority, enabled, hit_count, last_hit_at, created_at
    FROM gnucash_web_categorization_rules
    WHERE id = ${id} AND book_guid = ${bookGuid}
  `;
  if (existingRows.length === 0) return null;
  const existing = rowToRule(existingRows[0]);

  const merged = {
    pattern: patch.pattern ?? existing.pattern,
    matchType: patch.matchType ?? existing.matchType,
    accountGuid: patch.accountGuid ?? existing.accountGuid,
    priority: patch.priority ?? existing.priority,
    enabled: patch.enabled ?? existing.enabled,
  };

  const rows = await prisma.$queryRaw<RuleRow[]>`
    UPDATE gnucash_web_categorization_rules
    SET pattern = ${merged.pattern},
        match_type = ${merged.matchType},
        account_guid = ${merged.accountGuid},
        priority = ${merged.priority},
        enabled = ${merged.enabled}
    WHERE id = ${id} AND book_guid = ${bookGuid}
    RETURNING id, book_guid, pattern, match_type, account_guid,
              priority, enabled, hit_count, last_hit_at, created_at
  `;
  return rows.length > 0 ? rowToRule(rows[0]) : null;
}

/** Delete a rule (book-scoped). Returns true if a row was deleted. */
export async function deleteRule(bookGuid: string, id: number): Promise<boolean> {
  await ensureTable();
  const count = await prisma.$executeRaw`
    DELETE FROM gnucash_web_categorization_rules
    WHERE id = ${id} AND book_guid = ${bookGuid}
  `;
  return count > 0;
}

/**
 * Apply the enabled rules for a book to a transaction description.
 * Returns the target account guid on a match, or null.
 * On a hit, increments hit_count / last_hit_at (fire-and-forget).
 * The target account must still exist; stale rules are skipped.
 */
export async function applyRules(
  bookGuid: string,
  description: string,
): Promise<string | null> {
  const rules = await listEnabledRules(bookGuid);
  const rule = matchRule(rules, description);
  if (!rule) return null;

  // Guard against rules pointing at a since-deleted account
  const account = await prisma.accounts.findUnique({
    where: { guid: rule.accountGuid },
    select: { guid: true },
  });
  if (!account) return null;

  // Fire-and-forget hit tracking; never block or fail the import
  void prisma.$executeRaw`
    UPDATE gnucash_web_categorization_rules
    SET hit_count = hit_count + 1, last_hit_at = NOW()
    WHERE id = ${rule.id}
  `.catch((err: unknown) => {
    console.warn('Failed to record categorization rule hit:', err);
  });

  return rule.accountGuid;
}

/** Lowercase, strip digit runs, collapse whitespace. Used to group history. */
export function normalizeDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/[0-9]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive a usable 'contains' pattern from the raw (lowercased) sample
 * descriptions of a group: the longest common prefix, trimmed of trailing
 * digits/punctuation. Falls back to the normalized description when the
 * prefix is too short to be meaningful.
 */
export function derivePattern(samples: string[], normalized: string): string {
  const cleaned = samples.map(s => s.trim()).filter(Boolean);
  if (cleaned.length > 0) {
    let prefix = cleaned[0];
    for (const s of cleaned.slice(1)) {
      let i = 0;
      const max = Math.min(prefix.length, s.length);
      while (i < max && prefix[i] === s[i]) i++;
      prefix = prefix.slice(0, i);
      if (!prefix) break;
    }
    // Trim trailing digits, separators, and dangling punctuation
    prefix = prefix.replace(/[\s0-9#*\-_.,:;/\\]+$/g, '').trim();
    if (prefix.length >= 4) return prefix;
  }
  return normalized;
}

interface SuggestionRow {
  norm: string;
  account_guid: string;
  account_name: string | null;
  occurrences: number;
  share: number;
  samples: string[] | null;
}

/**
 * Learn rule candidates from transaction history for the given book:
 * normalized descriptions appearing >= 3 times where >= 80% of occurrences
 * share one counterpart expense/income account, excluding groups already
 * covered by an existing rule.
 */
export async function suggestRules(bookGuid: string): Promise<RuleSuggestion[]> {
  await ensureTable();

  const book = await prisma.books.findUnique({
    where: { guid: bookGuid },
    select: { root_account_guid: true },
  });
  if (!book) return [];
  const rootGuid = book.root_account_guid;

  const rows = await prisma.$queryRaw<SuggestionRow[]>`
    WITH RECURSIVE book_accounts AS (
      SELECT guid FROM accounts WHERE guid = ${rootGuid}
      UNION ALL
      SELECT a.guid FROM accounts a
      JOIN book_accounts b ON a.parent_guid = b.guid
    ),
    pairs AS (
      SELECT DISTINCT
        t.guid AS tx_guid,
        lower(trim(t.description)) AS raw_desc,
        trim(regexp_replace(regexp_replace(lower(t.description), '[0-9]+', '', 'g'), '\\s+', ' ', 'g')) AS norm,
        s2.account_guid
      FROM transactions t
      JOIN splits s2 ON s2.tx_guid = t.guid
      JOIN accounts a2 ON a2.guid = s2.account_guid
      WHERE a2.account_type IN ('EXPENSE', 'INCOME')
        AND s2.account_guid IN (SELECT guid FROM book_accounts)
        AND t.description IS NOT NULL
        AND trim(t.description) <> ''
    ),
    totals AS (
      SELECT norm, COUNT(DISTINCT tx_guid) AS total_cnt
      FROM pairs
      GROUP BY norm
    ),
    by_account AS (
      SELECT norm, account_guid, COUNT(DISTINCT tx_guid) AS acct_cnt
      FROM pairs
      GROUP BY norm, account_guid
    ),
    best AS (
      SELECT DISTINCT ON (norm) norm, account_guid, acct_cnt
      FROM by_account
      ORDER BY norm, acct_cnt DESC, account_guid ASC
    )
    SELECT
      b.norm,
      b.account_guid,
      ah.fullname AS account_name,
      t.total_cnt::int AS occurrences,
      (b.acct_cnt::float / t.total_cnt::float) AS share,
      (
        SELECT array_agg(d) FROM (
          SELECT DISTINCT p.raw_desc AS d
          FROM pairs p
          WHERE p.norm = b.norm
          LIMIT 10
        ) sub
      ) AS samples
    FROM best b
    JOIN totals t ON t.norm = b.norm
    LEFT JOIN account_hierarchy ah ON ah.guid = b.account_guid
    WHERE t.total_cnt >= 3
      AND b.acct_cnt::float / t.total_cnt::float >= 0.8
      AND b.norm <> ''
    ORDER BY t.total_cnt DESC, b.norm ASC
    LIMIT 50
  `;

  const existingRules = await listRules(bookGuid);

  const suggestions: RuleSuggestion[] = [];
  for (const row of rows) {
    const samples = row.samples || [];
    // Skip groups an existing rule (enabled or not) already covers
    const probe = samples[0] || row.norm;
    const covered = matchRule(
      existingRules.map(r => ({ ...r, enabled: true })),
      probe,
    );
    if (covered) continue;

    suggestions.push({
      pattern: derivePattern(samples, row.norm),
      accountGuid: row.account_guid,
      accountName: row.account_name,
      occurrences: Number(row.occurrences),
      share: Number(row.share),
    });
  }

  return suggestions;
}

/* ------------------------------------------------------------------------- *
 * Retroactive rule application ("apply to history")
 * ------------------------------------------------------------------------- */

/** Maximum number of changes returned/applied per call. */
export const HISTORY_APPLY_CAP = 500;

export interface HistoricalMatch {
  /** Transaction guid. */
  guid: string;
  /** The counter-split that will be moved. */
  splitGuid: string;
  /** Post date, YYYY-MM-DD (UTC). */
  date: string;
  description: string;
  currentAccountGuid: string;
  currentAccount: string;
  newAccountGuid: string;
  newAccount: string;
  /** Counter-split value in the transaction currency. */
  amount: number;
}

export interface HistoricalSkip {
  guid: string;
  date: string;
  description: string;
  reason: string;
}

export interface HistoryPlan {
  matches: HistoricalMatch[];
  skipped: HistoricalSkip[];
  /** True when more qualifying changes exist beyond the cap. */
  moreRemain: boolean;
}

export interface PlanHistoryOptions {
  /** Inclusive, YYYY-MM-DD. Omit for "all history". */
  startDate?: string;
  /** Inclusive, YYYY-MM-DD. */
  endDate?: string;
  /** Only recategorize splits sitting on Imbalance-* / Orphan-* accounts (default true). */
  onlyUncategorized?: boolean;
  /** Change cap; clamped to HISTORY_APPLY_CAP. */
  limit?: number;
}

/**
 * Find historical transactions in the given book whose description matches the
 * rule (identical semantics to the import path: matchRule) and whose
 * counter-split can safely be moved to the rule's target account.
 *
 * Read-only: performs no writes, so it doubles as the dry-run implementation.
 * The rule's enabled flag is intentionally ignored — applying to history is an
 * explicit user action.
 */
export async function planHistoricalApplication(
  rule: CategorizationRule,
  bookAccountGuids: string[],
  options: PlanHistoryOptions = {},
): Promise<HistoryPlan> {
  const onlyUncategorized = options.onlyUncategorized ?? true;
  const limit = Math.max(1, Math.min(options.limit ?? HISTORY_APPLY_CAP, HISTORY_APPLY_CAP));
  const bookSet = new Set(bookAccountGuids);

  const target = await prisma.accounts.findUnique({
    where: { guid: rule.accountGuid },
    select: { guid: true, name: true, commodity_guid: true },
  });
  if (!target) {
    throw new Error('Rule target account no longer exists');
  }

  const where: Prisma.transactionsWhereInput = {
    splits: { some: { account_guid: { in: bookAccountGuids } } },
  };
  // 'contains' can be prefiltered in SQL; exact/regex are filtered in JS below
  // with matchRule so the semantics stay identical to the import path.
  const trimmedPattern = (rule.pattern || '').trim();
  if (rule.matchType === 'contains' && trimmedPattern) {
    where.description = { contains: trimmedPattern, mode: 'insensitive' };
  } else {
    where.description = { not: null };
  }
  if (options.startDate || options.endDate) {
    where.post_date = {
      ...(options.startDate ? { gte: new Date(`${options.startDate}T00:00:00.000Z`) } : {}),
      ...(options.endDate ? { lte: new Date(`${options.endDate}T23:59:59.999Z`) } : {}),
    };
  }

  const txs = await prisma.transactions.findMany({
    where,
    select: { guid: true, post_date: true, description: true },
    orderBy: [{ post_date: 'asc' }, { guid: 'asc' }],
  });

  // Reuse the exact import-time matcher (force-enabled for this explicit action).
  const matcherRule: CategorizationRule = { ...rule, enabled: true };
  const matched = txs.filter(t => matchRule([matcherRule], t.description ?? '') !== null);

  const matches: HistoricalMatch[] = [];
  const skipped: HistoricalSkip[] = [];
  let moreRemain = false;

  const CHUNK = 200;
  outer: for (let i = 0; i < matched.length; i += CHUNK) {
    const chunk = matched.slice(i, i + CHUNK);
    const splitRows = await prisma.splits.findMany({
      where: { tx_guid: { in: chunk.map(t => t.guid) } },
      select: {
        guid: true,
        tx_guid: true,
        value_num: true,
        value_denom: true,
        account: {
          select: { guid: true, name: true, account_type: true, commodity_guid: true },
        },
      },
    });
    const byTx = new Map<string, typeof splitRows>();
    for (const row of splitRows) {
      const list = byTx.get(row.tx_guid);
      if (list) list.push(row);
      else byTx.set(row.tx_guid, [row]);
    }

    for (const tx of chunk) {
      const rows = byTx.get(tx.guid) ?? [];
      const infos = rows.map(r => ({
        guid: r.guid,
        accountGuid: r.account.guid,
        accountName: r.account.name,
        accountType: r.account.account_type,
        commodityGuid: r.account.commodity_guid,
      }));
      const decision = selectHistoryCounterSplit(infos, {
        targetAccountGuid: rule.accountGuid,
        onlyUncategorized,
      });
      if (decision.kind === 'none') continue;

      const date = tx.post_date ? tx.post_date.toISOString().slice(0, 10) : '';
      const description = tx.description ?? '';
      if (decision.kind === 'skip') {
        skipped.push({ guid: tx.guid, date, description, reason: decision.reason });
        continue;
      }
      if (!bookSet.has(decision.split.accountGuid)) {
        skipped.push({ guid: tx.guid, date, description, reason: 'counter-split outside the active book' });
        continue;
      }
      if (
        target.commodity_guid &&
        decision.split.commodityGuid &&
        decision.split.commodityGuid !== target.commodity_guid
      ) {
        skipped.push({ guid: tx.guid, date, description, reason: 'currency mismatch with target account' });
        continue;
      }

      if (matches.length >= limit) {
        moreRemain = true;
        break outer;
      }

      const row = rows.find(r => r.guid === decision.split.guid)!;
      const denom = Number(row.value_denom);
      matches.push({
        guid: tx.guid,
        splitGuid: decision.split.guid,
        date,
        description,
        currentAccountGuid: decision.split.accountGuid,
        currentAccount: decision.split.accountName,
        newAccountGuid: rule.accountGuid,
        newAccount: target.name,
        amount: denom !== 0 ? Number(row.value_num) / denom : 0,
      });
    }
  }

  return { matches, skipped, moreRemain };
}

/**
 * Apply a set of planned historical matches inside a single Prisma
 * transaction. Each split move is guarded on the split still being on the
 * account we planned to move it from, so a concurrently-edited transaction is
 * silently left alone rather than corrupted. Returns the number of splits
 * actually moved.
 */
export async function applyHistoricalMatches(matches: HistoricalMatch[]): Promise<number> {
  if (matches.length === 0) return 0;
  let applied = 0;
  await prisma.$transaction(async tx => {
    for (const m of matches) {
      const res = await tx.splits.updateMany({
        where: { guid: m.splitGuid, account_guid: m.currentAccountGuid },
        data: { account_guid: m.newAccountGuid },
      });
      applied += res.count;
    }
  });
  return applied;
}
