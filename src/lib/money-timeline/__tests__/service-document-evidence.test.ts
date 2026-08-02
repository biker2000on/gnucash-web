import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listLinkedDocuments, listItems, get1099Compliance } = vi.hoisted(() => ({
  listLinkedDocuments: vi.fn(),
  listItems: vi.fn(),
  get1099Compliance: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const emptyModel = { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) };
  return {
    default: new Proxy({
      books: { findUnique: vi.fn(async () => ({ root_account_guid: 'root' })) },
      accounts: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => ({ commodity: { guid: 'usd', mnemonic: 'USD' } })),
      },
      gnucash_web_entity_profiles: { findUnique: vi.fn(async () => null) },
      gnucash_web_compliance_status: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
    }, {
      get(target, prop: string) {
        if (prop in target) return target[prop as keyof typeof target];
        return emptyModel;
      },
    }),
  };
});
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: vi.fn(async () => []) }));
vi.mock('@/lib/ical', () => ({
  scheduledTransactionEvents: vi.fn(() => []),
  fixedIncomeEvents: vi.fn(() => []),
  rmdEvents: vi.fn(() => []),
  complianceDeadlineEvents: vi.fn((items: Array<{ key: string; period: string; dueDate: string; title: string; description: string }>) =>
    items.map(item => ({
      uid: `compliance-${item.key}-${item.period}@gnucash-web`,
      date: item.dueDate,
      summary: `Due: ${item.title}`,
      description: item.description,
    }))),
}));
vi.mock('@/lib/compliance', () => ({
  complianceItemsForYear: vi.fn((_entity: string, _state: string | null, year: number) => year === 2026 ? [{
    key: 'fed-payment',
    title: 'Estimated payment',
    description: 'Pay the installment.',
    dueDate: '2026-08-15',
    period: '2026-Q3',
    severity: 'payment',
  }] : []),
}));
vi.mock('@/lib/fixed-income', () => ({
  loadFixedIncomePositions: vi.fn(async () => []),
  summarizeFixedIncome: vi.fn(() => ({ upcomingMaturities: [], couponPayments: [] })),
}));
vi.mock('@/lib/scheduled-transactions', () => ({ fetchScheduledTransactions: vi.fn(async () => []) }));
vi.mock('@/lib/user-preferences', () => ({ getPreference: vi.fn(async () => null) }));
vi.mock('@/lib/services/renewals.service', () => ({ listRenewals: vi.fn(async () => []) }));
vi.mock('@/lib/services/home.service', () => ({ listTasks: vi.fn(async () => []), listItems }));
vi.mock('@/lib/business/invoice-engine', () => ({ listInvoices: vi.fn(async () => []) }));
vi.mock('@/lib/services/goal.service', () => ({ listGoals: vi.fn(async () => []) }));
vi.mock('@/lib/report-scheduler', () => ({
  listReportSchedules: vi.fn(async () => []),
  currentOccurrence: vi.fn(),
  schedulableReportLabel: vi.fn(),
}));
vi.mock('@/lib/services/entity.service', () => ({ ENTITY_TYPES: ['household'] }));
vi.mock('@/lib/business/vendor-1099.service', () => ({ get1099Compliance }));
vi.mock('@/lib/resilience/service', () => ({ loadResilienceEvents: vi.fn(async () => []) }));
vi.mock('@/lib/documents', () => ({ listLinkedDocuments }));

import { collectFinancialEventsForBook } from '../service';

function linked(targetId: string, role: string, id: number) {
  return {
    document: {
      id,
      title: `${role} evidence`,
      filename: `${role}.pdf`,
      sourceKind: 'upload',
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    },
    link: { targetId, role },
  };
}

describe('Money Timeline canonical evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    listItems.mockResolvedValue([{
      id: 7,
      name: 'Heat pump',
      warrantyExpires: '2026-10-01',
      notes: null,
    }]);
    get1099Compliance.mockImplementation(async (_book: string, _accounts: string[], year: number) => ({
      taxYear: year,
      filingDueDate: `${year + 1}-01-31`,
      reportableCount: year === 2025 ? 1 : 0,
      unfiledCount: year === 2025 ? 1 : 0,
      missingW9Count: year === 2025 ? 1 : 0,
      rows: year === 2025 ? [{
        vendorGuid: 'vendor-1',
        name: 'Contractor',
        requiresFiling: true,
        filedDate: null,
      }] : [],
    }));
    listLinkedDocuments.mockImplementation(async ({ targetType }: { targetType: string }) => {
      if (targetType === 'compliance_item') return [linked('fed-payment:2026-Q3', 'payment_confirmation', 1)];
      if (targetType === 'vendor_1099') return [linked('vendor-1:2025', 'filing_proof', 2)];
      if (targetType === 'home_item') return [linked('7', 'warranty', 3)];
      return [];
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('adds role/count/href evidence with one read per target type', async () => {
    const { events } = await collectFinancialEventsForBook(9, 'book-1', new Date());
    const compliance = events.find(event => event.sourceId === 'compliance-fed-payment-2026-Q3')!;
    const vendor = events.find(event => event.sourceId === 'vendor-1099:2025')!;
    const warranty = events.find(event => event.sourceId === 'warranty:7')!;

    expect(compliance.evidence[0]).toMatchObject({ verified: true, metadata: { requiredDocumentRole: 'payment_confirmation' } });
    expect(compliance.metadata).toMatchObject({ linkedDocumentCount: 1, evidenceHref: '/taxes/compliance' });
    expect(vendor.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '2', href: '/business/reports/1099?year=2025' }),
    ]));
    expect(vendor.metadata).toMatchObject({ linkedDocumentCount: 1 });
    expect(warranty.evidence[0]).toMatchObject({ verified: true, metadata: { requiredDocumentRole: 'warranty' } });
    expect(warranty.metadata).toMatchObject({ linkedDocumentCount: 1, evidenceHref: '/home/inventory' });
    expect(listLinkedDocuments).toHaveBeenCalledTimes(3);
  });
});
