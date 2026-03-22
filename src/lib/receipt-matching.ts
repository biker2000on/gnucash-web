// src/lib/receipt-matching.ts

import { distance } from 'fastest-levenshtein';
import { normalizeVendor } from './receipt-extraction';

export interface MatchCandidate {
  transaction_guid: string;
  description: string;
  post_date: string;
  amount: string;
  score: number;
  score_breakdown: {
    amount: number;
    date: number;
    vendor: number;
  };
}

const AMOUNT_WEIGHT = 0.5;
const DATE_WEIGHT = 0.3;
const VENDOR_WEIGHT = 0.2;
const MIN_SCORE = 0.3;
const MAX_CANDIDATES = 5;

export function scoreAmount(receiptAmount: number, txAmount: number): number {
  const diff = Math.abs(receiptAmount - txAmount);
  if (diff <= 0.01) return 1.0;
  const pct = diff / receiptAmount;
  if (pct <= 0.01) return 0.8;
  if (pct <= 0.05) return 0.5;
  return 0.0;
}

export function scoreDate(receiptDate: string, txDate: string): number {
  const r = new Date(receiptDate);
  const t = new Date(txDate);
  const daysDiff = Math.abs(Math.round((r.getTime() - t.getTime()) / (1000 * 60 * 60 * 24)));
  if (daysDiff === 0) return 1.0;
  if (daysDiff <= 1) return 0.9;
  if (daysDiff <= 3) return 0.7;
  if (daysDiff <= 7) return 0.4;
  return 0.0;
}

export function scoreVendor(receiptVendor: string | null, txDescription: string): number {
  const normReceipt = normalizeVendor(receiptVendor);
  const normTx = normalizeVendor(txDescription);

  if (!normReceipt || !normTx) return 0.0;
  if (normReceipt === normTx) return 1.0;
  if (normTx.includes(normReceipt) || normReceipt.includes(normTx)) return 0.7;
  if (distance(normReceipt, normTx) < 3) return 0.5;
  return 0.0;
}

export function computeMatchScore(
  receiptAmount: number | null,
  receiptDate: string | null,
  receiptVendor: string | null,
  txAmount: number,
  txDate: string,
  txDescription: string
): { score: number; breakdown: { amount: number; date: number; vendor: number } } {
  const amountScore = receiptAmount != null ? scoreAmount(receiptAmount, txAmount) : 0;
  const dateScore = receiptDate ? scoreDate(receiptDate, txDate) : 0;
  const vendorScore = scoreVendor(receiptVendor, txDescription);

  const score = amountScore * AMOUNT_WEIGHT + dateScore * DATE_WEIGHT + vendorScore * VENDOR_WEIGHT;

  return {
    score,
    breakdown: { amount: amountScore, date: dateScore, vendor: vendorScore },
  };
}

/** Score and rank candidate transactions for a receipt. */
export function rankCandidates(
  receiptAmount: number | null,
  receiptDate: string | null,
  receiptVendor: string | null,
  candidates: { guid: string; description: string; post_date: string; amount: string }[],
  dismissedGuids: string[] = []
): MatchCandidate[] {
  const dismissed = new Set(dismissedGuids);

  return candidates
    .filter(c => !dismissed.has(c.guid))
    .map(c => {
      const txAmount = parseFloat(c.amount);
      const { score, breakdown } = computeMatchScore(
        receiptAmount, receiptDate, receiptVendor,
        txAmount, c.post_date, c.description
      );
      return {
        transaction_guid: c.guid,
        description: c.description,
        post_date: c.post_date,
        amount: c.amount,
        score: Math.round(score * 100) / 100,
        score_breakdown: breakdown,
      };
    })
    .filter(c => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}
