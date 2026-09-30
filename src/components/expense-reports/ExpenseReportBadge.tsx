'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const MAX_BATCH = 500;

/**
 * Expense-report allocation text per split guid for the ledger rows
 * ("Reported · ER-3 · Paid 2026-10-05", "$40.00 of $62.22 on ER-3 ·
 * $22.22 personal"). Same fetch discipline as useCommentCounts: ask about
 * each guid once, key the effect on the joined identity (the parent passes
 * a fresh array every render), and never let a decoration fail the ledger.
 */
export function useExpenseReportBadges(splitGuids: string[]): Record<string, string> {
  const [badges, setBadges] = useState<Record<string, string>>({});
  const asked = useRef<Set<string>>(new Set());
  const key = splitGuids.join(',');

  useEffect(() => {
    const pending = (key === '' ? [] : key.split(',')).filter((g) => g !== '' && !asked.current.has(g));
    if (pending.length === 0) return;
    const unique = [...new Set(pending)];
    for (const g of unique) asked.current.add(g);
    // No cancellation on key change: the ledger's row list changes identity
    // right after its first load, and discarding the in-flight answer would
    // strand these guids as "asked" forever. Results are keyed by split guid,
    // so merging a late answer is always correct (and a no-op if unmounted).
    void (async () => {
      for (let start = 0; start < unique.length; start += MAX_BATCH) {
        const batch = unique.slice(start, start + MAX_BATCH);
        try {
          const response = await fetch('/api/expense-reports/badges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ splitGuids: batch }),
          });
          if (!response.ok) {
            for (const g of batch) asked.current.delete(g);
            continue;
          }
          const body = await response.json();
          const fresh = (body.badges ?? {}) as Record<string, string>;
          if (Object.keys(fresh).length > 0) setBadges((prev) => ({ ...prev, ...fresh }));
        } catch {
          for (const g of batch) asked.current.delete(g);
        }
      }
    })();
  }, [key]);

  return badges;
}

export function ExpenseReportBadge({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <Link
      href="/expense-reports"
      onClick={(e) => e.stopPropagation()}
      className="whitespace-nowrap rounded-sm border border-secondary/30 bg-secondary-light px-1.5 py-0.5 text-[10px] font-medium text-secondary hover:border-secondary/60"
    >
      {text}
    </Link>
  );
}
