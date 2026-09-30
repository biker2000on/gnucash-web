/**
 * Payee-history category suggestions for expense report lines.
 *
 * For each line description, count which EXPENSE account the business book
 * used for the same (normalized) payee — both in its own ledger and on
 * earlier expense report lines someone categorized there. The household
 * book's accounts are never consulted: the business chart is the only
 * source of categories.
 */

import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { derivePattern, normalizeDescription } from '@/lib/services/categorization.service';

/** description → [{accountGuid, count}] */
export async function historySuggestions(
  businessBookGuid: string,
  descriptions: readonly string[],
): Promise<Map<string, Array<{ accountGuid: string; count: number }>>> {
  const out = new Map<string, Array<{ accountGuid: string; count: number }>>();
  const byNormalized = new Map<string, string[]>();
  for (const d of new Set(descriptions)) {
    const n = normalizeDescription(d);
    if (!n) continue;
    byNormalized.set(n, [...(byNormalized.get(n) ?? []), d]);
  }
  if (byNormalized.size === 0) return out;
  const normalized = [...byNormalized.keys()];
  const bookAccounts = await getAccountGuidsForBook(businessBookGuid);

  const ledger = await prisma.$queryRaw<Array<{ normalized: string; account_guid: string; n: bigint }>>`
    SELECT btrim(regexp_replace(regexp_replace(lower(t.description), '[0-9]+', '', 'g'), '\\s+', ' ', 'g')) AS normalized,
           s.account_guid, COUNT(*) AS n
      FROM splits s
      JOIN transactions t ON t.guid = s.tx_guid
      JOIN accounts a ON a.guid = s.account_guid
     WHERE a.account_type = 'EXPENSE'
       AND s.account_guid = ANY(${bookAccounts}::text[])
       AND btrim(regexp_replace(regexp_replace(lower(t.description), '[0-9]+', '', 'g'), '\\s+', ' ', 'g')) = ANY(${normalized}::text[])
     GROUP BY 1, 2
  `;
  const reportLines = await prisma.$queryRaw<Array<{ normalized: string; account_guid: string; n: bigint }>>`
    SELECT btrim(regexp_replace(regexp_replace(lower(l.description), '[0-9]+', '', 'g'), '\\s+', ' ', 'g')) AS normalized,
           l.expense_account_guid AS account_guid, COUNT(*) AS n
      FROM gnucash_web_expense_report_lines l
      JOIN gnucash_web_expense_reports r ON r.id = l.report_id
     WHERE l.business_book_guid = ${businessBookGuid}
       AND l.kind = 'business'
       AND l.expense_account_guid IS NOT NULL
       AND r.status NOT IN ('rejected', 'withdrawn')
       AND btrim(regexp_replace(regexp_replace(lower(l.description), '[0-9]+', '', 'g'), '\\s+', ' ', 'g')) = ANY(${normalized}::text[])
     GROUP BY 1, 2
  `;
  const counts = new Map<string, Map<string, number>>();
  for (const r of [...ledger, ...reportLines]) {
    const perAccount = counts.get(r.normalized) ?? new Map<string, number>();
    perAccount.set(r.account_guid, (perAccount.get(r.account_guid) ?? 0) + Number(r.n));
    counts.set(r.normalized, perAccount);
  }
  for (const [n, originals] of byNormalized) {
    const perAccount = counts.get(n);
    if (!perAccount) continue;
    const list = [...perAccount.entries()].map(([accountGuid, count]) => ({ accountGuid, count }));
    for (const d of originals) out.set(d, list);
  }
  return out;
}

/** The 'contains' pattern "Remember for this payee" saves as a rule. */
export function payeePattern(description: string): string {
  const normalized = normalizeDescription(description);
  return derivePattern([description.toLowerCase()], normalized);
}
