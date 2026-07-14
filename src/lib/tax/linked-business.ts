/**
 * Linked-business income for the household 1040.
 *
 * A pass-through business's profit is taxed on the owner's personal return
 * whether or not it was drawn, so a household book's tax estimate must
 * include its share of each linked business book's net profit (see
 * src/lib/services/book-links.service.ts for the link model):
 *
 * - sole_prop / llc_single / llc_partnership → Schedule C/E treatment:
 *   the share counts as self-employment income (SE tax + income tax).
 * - s_corp → K-1 ordinary income: income tax but no SE tax (the W-2 salary
 *   side arrives in the household book as normal mapped wages).
 * - c_corp → excluded: the corporation pays its own tax; only actual
 *   dividends (recorded in the household book) hit the 1040.
 *
 * Owner's draws recorded in the household book (e.g. Income:Business Draws:*)
 * must be mapped 'exclude' — the profit computed here is the taxable amount.
 */

import { getAccountGuidsForBook } from '@/lib/book-scope';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { getLinksToHouseholdBook } from '@/lib/services/book-links.service';
import type { BookTaxData, TaxCategory } from '@/lib/tax/types';
import type { EntityType } from '@/lib/services/entity.service';

export type LinkedIncomeTreatment = 'schedule_c' | 'k1' | 'none';

export interface LinkedBusinessIncome {
  businessBookGuid: string;
  businessBookName: string | null;
  entityName: string | null;
  entityType: EntityType | null;
  ownershipPercent: number;
  /** Business net profit (SE income − business expenses) for the year, YTD. */
  netProfit: number;
  /** netProfit × ownershipPercent / 100 */
  share: number;
  treatment: LinkedIncomeTreatment;
}

function treatmentFor(entityType: EntityType | null): LinkedIncomeTreatment {
  switch (entityType) {
    case 'sole_prop':
    case 'llc_single':
    case 'llc_partnership':
      return 'schedule_c';
    case 's_corp':
      return 'k1';
    default:
      return 'none';
  }
}

function categoryTotal(data: BookTaxData, category: TaxCategory): number {
  return data.categories.find(c => c.category === category)?.total ?? 0;
}

/**
 * Compute each linked business's YTD net profit and this household's share.
 * Books whose entity type gets no personal pass-through ('none') are still
 * returned (share 0-effect) so the UI can explain why they're excluded.
 */
export async function getLinkedBusinessIncome(
  householdBookGuid: string,
  year: number
): Promise<LinkedBusinessIncome[]> {
  const links = await getLinksToHouseholdBook(householdBookGuid);
  if (links.length === 0) return [];

  const results: LinkedBusinessIncome[] = [];
  for (const link of links) {
    const accountGuids = await getAccountGuidsForBook(link.businessBookGuid);
    if (accountGuids.length === 0) continue;

    const data = await aggregateBookTaxData(accountGuids, year, null);
    const netProfit =
      categoryTotal(data, 'self_employment_income') - categoryTotal(data, 'business_expense');
    const treatment = treatmentFor(link.businessEntityType);

    results.push({
      businessBookGuid: link.businessBookGuid,
      businessBookName: link.businessBookName,
      entityName: link.businessEntityName,
      entityType: link.businessEntityType,
      ownershipPercent: link.ownershipPercent,
      netProfit,
      share: treatment === 'none' ? 0 : (netProfit * link.ownershipPercent) / 100,
      treatment,
    });
  }
  return results;
}

/**
 * Fold linked-business shares into a household book's aggregated tax data,
 * with a synthetic per-business drill-down row so the estimator shows
 * provenance. Mutates and returns `bookData`.
 */
export function applyLinkedBusinessIncome(
  bookData: BookTaxData,
  linked: LinkedBusinessIncome[]
): BookTaxData {
  for (const biz of linked) {
    if (biz.treatment === 'none' || biz.share === 0) continue;
    const category: TaxCategory =
      biz.treatment === 'schedule_c' ? 'self_employment_income' : 'other_income';

    let aggregate = bookData.categories.find(c => c.category === category);
    if (!aggregate) {
      aggregate = { category, total: 0, accounts: [] };
      bookData.categories.push(aggregate);
    }
    aggregate.total += biz.share;
    aggregate.accounts.push({
      accountGuid: biz.businessBookGuid,
      accountName: `${biz.entityName ?? biz.businessBookName ?? 'Linked business'} (${biz.ownershipPercent}% share)`,
      accountPath: `Linked business book: ${biz.businessBookName ?? biz.businessBookGuid}`,
      amount: biz.share,
    });
  }
  return bookData;
}
