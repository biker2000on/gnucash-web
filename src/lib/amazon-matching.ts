import { scoreDate } from './receipt-matching';

export interface AmazonMatchCandidate {
  transaction_guid: string;
  description: string;
  post_date: string;
  amount: number;
  split_guid: string;
  account_guid: string;
  score: number;
  score_breakdown: { amount: number; date: number };
}

const AMOUNT_WEIGHT = 0.7;
const DATE_WEIGHT = 0.3;
const MIN_SCORE = 0.3;
const MAX_CANDIDATES = 5;

/** Stricter amount scoring than receipt matching */
export function scoreAmazonAmount(orderAmount: number, txAmount: number): number {
  const diff = Math.abs(orderAmount - txAmount);
  if (diff <= 0.01) return 1.0;
  const pct = diff / orderAmount;
  if (pct <= 0.01) return 0.5;
  return 0.0;
}

/** Compute match score for Amazon (amount 0.7, date 0.3) */
export function computeAmazonMatchScore(
  orderAmount: number,
  orderDate: string,
  txAmount: number,
  txDate: string
): { score: number; breakdown: { amount: number; date: number } } {
  const amountScore = scoreAmazonAmount(orderAmount, txAmount);
  const dateScore = scoreDate(orderDate, txDate);
  const score = amountScore * AMOUNT_WEIGHT + dateScore * DATE_WEIGHT;

  return {
    score: Math.round(score * 100) / 100,
    breakdown: { amount: amountScore, date: dateScore },
  };
}

/** Rank candidates for an order, return top 5 with score >= 0.3 */
export function rankAmazonCandidates(
  orderAmount: number,
  orderDate: string,
  candidates: Array<{
    guid: string;
    description: string;
    post_date: string;
    amount: number;
    split_guid: string;
    account_guid: string;
  }>,
  excludeGuids?: string[]
): AmazonMatchCandidate[] {
  const excluded = new Set(excludeGuids ?? []);

  return candidates
    .filter(c => !excluded.has(c.guid))
    .map(c => {
      const { score, breakdown } = computeAmazonMatchScore(
        orderAmount, orderDate, c.amount, c.post_date
      );
      return {
        transaction_guid: c.guid,
        description: c.description,
        post_date: c.post_date,
        amount: c.amount,
        split_guid: c.split_guid,
        account_guid: c.account_guid,
        score,
        score_breakdown: breakdown,
      };
    })
    .filter(c => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

/**
 * Find pairs of unmatched orders whose totals sum to an unmatched charge.
 * Only checks pairs within the same 7-day window.
 */
export function findPairMatches(
  unmatchedOrders: Array<{ orderId: string; amount: number; orderDate: string }>,
  unmatchedCharges: Array<{ guid: string; amount: number; post_date: string; split_guid: string; account_guid: string }>
): Array<{
  orderIds: [string, string];
  chargeGuid: string;
  sumDiff: number;
}> {
  const results: Array<{
    orderIds: [string, string];
    chargeGuid: string;
    sumDiff: number;
  }> = [];

  const DAY_MS = 1000 * 60 * 60 * 24;

  for (let i = 0; i < unmatchedOrders.length; i++) {
    for (let j = i + 1; j < unmatchedOrders.length; j++) {
      const a = unmatchedOrders[i];
      const b = unmatchedOrders[j];

      // Check if the two orders are within 7 days of each other
      const dateA = new Date(a.orderDate).getTime();
      const dateB = new Date(b.orderDate).getTime();
      if (Math.abs(dateA - dateB) > 7 * DAY_MS) continue;

      const pairSum = a.amount + b.amount;

      for (const charge of unmatchedCharges) {
        const diff = Math.abs(pairSum - charge.amount);
        if (diff <= 0.05) {
          results.push({
            orderIds: [a.orderId, b.orderId],
            chargeGuid: charge.guid,
            sumDiff: Math.round(diff * 100) / 100,
          });
        }
      }
    }
  }

  return results;
}
