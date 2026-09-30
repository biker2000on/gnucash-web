import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityStatusRow } from '@/lib/entity-status';

const { getLinksToHouseholdBook, listEntityStatusHistories, aggregateBookTaxData } = vi.hoisted(() => ({
  getLinksToHouseholdBook: vi.fn(),
  listEntityStatusHistories: vi.fn(),
  aggregateBookTaxData: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => ['acct-1']) }));
vi.mock('@/lib/tax/book-income', () => ({ aggregateBookTaxData }));
vi.mock('@/lib/services/book-links.service', () => ({ getLinksToHouseholdBook }));
vi.mock('@/lib/services/entity-status.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/entity-status.service')>()),
  listEntityStatusHistories,
}));

import { getLinkedBusinessIncome } from '../linked-business';

function row(partial: Partial<EntityStatusRow> & { effectiveFrom: string }): EntityStatusRow {
  return {
    id: 1,
    legalForm: 'llc_single_member',
    taxClassification: 'disregarded',
    electionForm: null,
    electionFiledOn: null,
    electionAcceptedOn: null,
    shortYearConfirmed: false,
    electionDocumentId: null,
    acceptanceDocumentId: null,
    notes: null,
    ...partial,
  };
}

describe('getLinkedBusinessIncome — tax-year status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLinksToHouseholdBook.mockResolvedValue([
      {
        businessBookGuid: 'biz',
        householdBookGuid: 'home',
        ownershipPercent: 100,
        businessBookName: 'Lotus Bud',
        householdBookName: 'Crawford Home',
        // Today's type — must NOT decide a past or future year's treatment.
        businessEntityType: 's_corp',
        businessEntityName: 'Lotus Bud Acupuncture',
      },
    ]);
    aggregateBookTaxData.mockResolvedValue({
      categories: [
        { category: 'self_employment_income', total: 10000, accounts: [] },
        { category: 'business_expense', total: 4000, accounts: [] },
      ],
    });
    listEntityStatusHistories.mockResolvedValue(
      new Map([
        [
          'biz',
          [
            row({ id: 1, effectiveFrom: '1900-01-01' }),
            row({ id: 2, effectiveFrom: '2027-01-01', taxClassification: 's_corp', electionForm: '2553' }),
          ],
        ],
      ]),
    );
  });

  it('treats the year before an S election as Schedule C income', async () => {
    const [biz] = await getLinkedBusinessIncome('home', 2026);
    expect(biz).toMatchObject({ entityType: 'llc_single', treatment: 'schedule_c', share: 6000, statusMixed: false });
  });

  it('treats the election year as K-1 income', async () => {
    const [biz] = await getLinkedBusinessIncome('home', 2027);
    expect(biz).toMatchObject({ entityType: 's_corp', treatment: 'k1', share: 6000 });
  });

  it('flags a year with a mid-year change and uses the year-end status', async () => {
    listEntityStatusHistories.mockResolvedValue(
      new Map([
        [
          'biz',
          [
            row({ id: 1, effectiveFrom: '1900-01-01' }),
            row({ id: 3, effectiveFrom: '2027-07-01', taxClassification: 'c_corp', shortYearConfirmed: true }),
          ],
        ],
      ]),
    );
    const [biz] = await getLinkedBusinessIncome('home', 2027);
    expect(biz).toMatchObject({ entityType: 'c_corp', treatment: 'none', share: 0, statusMixed: true });
  });
});
