import type { FinancialAction } from './types';

const SEVERITY_RANK: Record<FinancialAction['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Canonical Action Center ordering. The stable key is the final tiebreaker so
 * identical-priority actions never shuffle between requests or family books.
 */
export function compareFinancialActions(
  left: FinancialAction,
  right: FinancialAction,
): number {
  const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severity !== 0) return severity;

  const score = (right.score?.total ?? 0) - (left.score?.total ?? 0);
  if (score !== 0) return score;

  if (left.dueDate !== right.dueDate) {
    if (left.dueDate === null || left.dueDate === undefined) return 1;
    if (right.dueDate === null || right.dueDate === undefined) return -1;
    return left.dueDate.localeCompare(right.dueDate);
  }

  const firstSeen = right.firstSeenAt.localeCompare(left.firstSeenAt);
  if (firstSeen !== 0) return firstSeen;

  const stableKey = left.stableKey.localeCompare(right.stableKey);
  if (stableKey !== 0) return stableKey;

  const book = left.bookGuid.localeCompare(right.bookGuid);
  if (book !== 0) return book;

  return left.id.localeCompare(right.id);
}
