// src/app/api/receipts/inbox/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { query } from '@/lib/db';
import { rankCandidates } from '@/lib/receipt-matching';
import { getBookAccountGuids } from '@/lib/book-scope';

export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    // Fetch unlinked receipts with extracted data
    const receiptsResult = await query(
      `SELECT id, filename, thumbnail_key, extracted_data, ocr_status, created_at
       FROM gnucash_web_receipts
       WHERE book_guid = $1 AND transaction_guid IS NULL
       ORDER BY created_at DESC
       LIMIT 50`,
      [bookGuid]
    );

    const bookAccountGuids = await getBookAccountGuids();

    // For each receipt with extracted data, compute match candidates
    const receiptsWithMatches = await Promise.all(
      receiptsResult.rows.map(async (receipt: Record<string, unknown>) => {
        const extracted = receipt.extracted_data as Record<string, unknown> | null;
        if (!extracted || !extracted.amount) {
          return { ...receipt, match_candidates: [] };
        }

        const receiptDate = extracted.date as string | null;
        const receiptAmount = extracted.amount as number;

        // Determine date range for candidate query
        const dateCenter = receiptDate || (receipt.created_at as string);
        const dateWindow = receiptDate ? 7 : 30;

        // Fetch candidate transactions
        const candidatesResult = await query(
          `SELECT DISTINCT t.guid, t.description, t.post_date::text,
                  ABS(s.value_num::decimal / NULLIF(s.value_denom, 0)) as amount
           FROM transactions t
           JOIN splits s ON s.tx_guid = t.guid
           JOIN accounts a ON a.guid = s.account_guid
           WHERE t.post_date BETWEEN ($1::date - ($2 || ' days')::interval) AND ($1::date + ($2 || ' days')::interval)
             AND a.guid = ANY($3::text[])
             AND t.guid NOT IN (
               SELECT DISTINCT transaction_guid FROM gnucash_web_receipts
               WHERE transaction_guid IS NOT NULL AND book_guid = $4
               AND id != $5
             )`,
          [dateCenter, dateWindow, bookAccountGuids, bookGuid, receipt.id]
        );

        const dismissedGuids = (extracted.dismissed_guids as string[]) || [];

        const matchCandidates = rankCandidates(
          receiptAmount,
          receiptDate,
          extracted.vendor as string | null,
          candidatesResult.rows.map((r: Record<string, unknown>) => ({
            guid: r.guid as string,
            description: r.description as string,
            post_date: r.post_date as string,
            amount: String(r.amount),
          })),
          dismissedGuids
        );

        return { ...receipt, match_candidates: matchCandidates };
      })
    );

    return NextResponse.json({
      receipts: receiptsWithMatches,
      total: receiptsResult.rows.length,
    });
  } catch (error) {
    console.error('Inbox error:', error);
    return NextResponse.json({ error: 'Failed to load inbox' }, { status: 500 });
  }
}
