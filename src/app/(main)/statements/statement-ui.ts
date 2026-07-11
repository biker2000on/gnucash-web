/**
 * Pure helpers for the Statement Import & Reconcile UI.
 *
 * Kept free of React / DOM so they can be unit-tested in isolation
 * (see __tests__/statement-ui.test.ts). Components import the badge maps,
 * tie-out formatter, and decision-diff builder from here.
 */

// ---------------------------------------------------------------------------
// Backend-shaped types (subset of the API contracts the UI consumes)
// ---------------------------------------------------------------------------

export type BatchStatus =
  | 'uploaded'
  | 'parsing'
  | 'parsed'
  | 'error'
  | 'reconciled';

export type StatementSource = 'pdf' | 'csv' | 'ofx';

export interface TieOut {
  expectedChange: number | null;
  actualChange: number | null;
  difference: number | null;
  tiesOut: boolean | null;
}

/** Per-line UI decision for a "missing" (on statement, not in ledger) line. */
export type MissingDecision = 'add' | 'ignore';

export interface MissingLineState {
  lineId: number;
  decision: MissingDecision;
  /** Counterpart account for an 'add' decision (income/expense/transfer side). */
  counterpartAccountGuid?: string;
}

/** Shape accepted by PUT /api/statements/[id]/lines. */
export interface LineDecisionPayload {
  lineId: number;
  decision: 'match' | 'add' | 'ignore';
  matchedSplitGuid?: string;
  counterpartAccountGuid?: string;
}

// ---------------------------------------------------------------------------
// Status badge map
// ---------------------------------------------------------------------------

export interface BadgeMeta {
  label: string;
  /** Tailwind classes using CSS-variable tokens (flat tints, no gradients). */
  className: string;
}

const STATUS_BADGES: Record<BatchStatus, BadgeMeta> = {
  uploaded: { label: 'Uploaded', className: 'bg-surface-hover text-foreground-muted' },
  parsing: { label: 'Parsing', className: 'bg-surface-hover text-foreground-muted' },
  parsed: { label: 'Parsed', className: 'bg-secondary-light text-secondary' },
  reconciled: { label: 'Reconciled', className: 'bg-[color:var(--positive)]/10 text-[color:var(--positive)]' },
  error: { label: 'Error', className: 'bg-[color:var(--negative)]/10 text-[color:var(--negative)]' },
};

export function statusBadge(status: string): BadgeMeta {
  return (
    STATUS_BADGES[status as BatchStatus] ?? {
      label: status || 'Unknown',
      className: 'bg-surface-hover text-foreground-muted',
    }
  );
}

const SOURCE_BADGES: Record<StatementSource, BadgeMeta> = {
  pdf: { label: 'PDF', className: 'bg-surface-hover text-foreground-secondary' },
  csv: { label: 'CSV', className: 'bg-surface-hover text-foreground-secondary' },
  ofx: { label: 'OFX', className: 'bg-surface-hover text-foreground-secondary' },
};

export function sourceBadge(source: string): BadgeMeta {
  return (
    SOURCE_BADGES[source as StatementSource] ?? {
      label: (source || '').toUpperCase() || 'FILE',
      className: 'bg-surface-hover text-foreground-secondary',
    }
  );
}

export function isPollingStatus(status: string): boolean {
  return status === 'uploaded' || status === 'parsing';
}

// ---------------------------------------------------------------------------
// Tie-out display
// ---------------------------------------------------------------------------

export type TieOutTone = 'positive' | 'warning' | 'negative';

export interface TieOutDisplay {
  tone: TieOutTone;
  /** Short status word for the banner heading. */
  status: string;
  /** One-line human explanation. */
  detail: string;
}

/**
 * Map a tie-out result to a banner tone + copy.
 *   tiesOut === true  → positive "Balances"
 *   tiesOut === null  → warning  (statement balances missing / unverifiable)
 *   tiesOut === false → negative (report the outstanding difference)
 */
export function tieOutDisplay(tieOut: TieOut | null | undefined): TieOutDisplay {
  if (!tieOut || tieOut.tiesOut === null || tieOut.tiesOut === undefined) {
    return {
      tone: 'warning',
      status: 'Unverifiable',
      detail:
        'Opening or closing balance is missing, so this statement cannot be tied out automatically.',
    };
  }

  if (tieOut.tiesOut === true) {
    return {
      tone: 'positive',
      status: 'Balances',
      detail: 'Opening balance plus reviewed activity equals the closing balance.',
    };
  }

  const diff = tieOut.difference ?? 0;
  return {
    tone: 'negative',
    status: 'Out of balance',
    detail: `Off by ${formatSignedAbsolute(diff)}. Review the sections below until the difference is zero.`,
  };
}

/** Whether Finalize should be enabled: only when the statement ties out exactly. */
export function canFinalize(tieOut: TieOut | null | undefined): boolean {
  return !!tieOut && tieOut.tiesOut === true;
}

// ---------------------------------------------------------------------------
// Decision-diff builders
// ---------------------------------------------------------------------------

/**
 * Build the PUT payload for the "missing" section from local UI state.
 * 'add' lines carry their chosen counterpart account; 'ignore' lines do not.
 */
export function buildMissingDecisions(
  states: MissingLineState[],
): LineDecisionPayload[] {
  return states.map((s) =>
    s.decision === 'add'
      ? {
          lineId: s.lineId,
          decision: 'add',
          ...(s.counterpartAccountGuid
            ? { counterpartAccountGuid: s.counterpartAccountGuid }
            : {}),
        }
      : { lineId: s.lineId, decision: 'ignore' },
  );
}

/** Un-match a confirmed line: the backend models this as an 'ignore' decision. */
export function buildUnmatchDecision(lineId: number): LineDecisionPayload {
  return { lineId, decision: 'ignore' };
}

/**
 * True when an 'add' line still lacks a counterpart account. Finalize would 400
 * on these, so the UI blocks Save/Finalize and highlights them.
 */
export function missingCounterparts(states: MissingLineState[]): number[] {
  return states
    .filter((s) => s.decision === 'add' && !s.counterpartAccountGuid)
    .map((s) => s.lineId);
}

// ---------------------------------------------------------------------------
// Categorization-rule pattern cleaner
// ---------------------------------------------------------------------------

/**
 * Clean a statement-line description into a categorization-rule pattern for a
 * 'contains' match.
 *
 * Mirrors the intent of normalizeMerchant (src/lib/recurring-detection.ts):
 * lowercase, drop digit-bearing tokens (store numbers, dates, reference codes).
 * It deviates in one important way: the result must remain a case-insensitive
 * SUBSTRING of the description, because rule matching is
 * `description.toLowerCase().includes(pattern)` — rewriting separators the way
 * normalizeMerchant does ("paypal *spotify" → "paypal spotify") would produce
 * patterns that never match. So instead we split the description into runs of
 * consecutive digit-free tokens (keeping their original separators), strip
 * leading bank-noise words (POS, PURCHASE, DEBIT, ACH, …), and take the FIRST
 * run with meaningful content — the merchant almost always precedes the
 * city/state suffix. Stray edge punctuation is trimmed (still substring-safe).
 *
 * "POS PURCHASE STARBUCKS #1234 SEATTLE" → "starbucks"
 * "PAYPAL *SPOTIFY 402-935-7733"         → "paypal *spotify"
 * Falls back to the whole lowercased description when every token has digits.
 */
const RULE_NOISE_WORDS = new Set([
  'pos', 'purchase', 'debit', 'credit', 'card', 'checkcard', 'check', 'chk',
  'ach', 'web', 'online', 'recurring', 'payment', 'pmt', 'withdrawal',
  'deposit', 'transaction', 'transfer', 'to', 'from', 'at',
]);

export function cleanRulePattern(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';

  // Runs of consecutive digit-free tokens (digit tokens are refs/dates/ids).
  const tokens = collapsed.split(' ');
  const runs: string[][] = [];
  let run: string[] = [];
  for (const t of tokens) {
    if (/\d/.test(t)) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push(t);
    }
  }
  if (run.length) runs.push(run);

  // Every token carried digits (e.g. "7-ELEVEN 123") — keep the raw text so
  // the user still gets an editable prefill.
  if (runs.length === 0) return collapsed.toLowerCase();

  const bare = (w: string) => w.replace(/[^a-zA-Z0-9&]/g, '').toLowerCase();
  // Trimming leading tokens / edge characters keeps the result a substring of
  // the (collapsed) description, so a 'contains' rule still matches this line.
  const finish = (words: string[]) =>
    words
      .join(' ')
      .replace(/^[^a-zA-Z0-9&]+/, '')
      .replace(/[^a-zA-Z0-9&]+$/, '')
      .toLowerCase();

  // First run with non-noise content wins (merchant precedes city/state).
  for (const r of runs) {
    let start = 0;
    while (start < r.length && RULE_NOISE_WORDS.has(bare(r[start]))) start++;
    if (start < r.length) return finish(r.slice(start));
  }

  // Everything was noise — keep the last word of the first run so the user
  // still gets an editable prefill ("ACH PAYMENT" → "payment").
  const first = runs[0];
  return finish(first.slice(first.length - 1));
}

// ---------------------------------------------------------------------------
// Amount / sign helpers
// ---------------------------------------------------------------------------

/** Signed-amount color token class. Positive = into account, negative = out. */
export function amountTone(amount: number): string {
  if (amount > 0) return 'text-[color:var(--positive)]';
  if (amount < 0) return 'text-[color:var(--negative)]';
  return 'text-foreground-secondary';
}

/** Format an absolute magnitude with a leading sign always shown. */
export function formatSignedAbsolute(amount: number): string {
  const abs = Math.abs(amount);
  const s = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${s}`;
}
