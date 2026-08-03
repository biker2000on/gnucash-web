import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FamilyOfficePage from './page';

const { switchBookMock, booksRef, HOUSEHOLD, BUSINESS, REVOKED } = vi.hoisted(() => {
  const household = 'h'.repeat(32);
  const business = 'b'.repeat(32);
  const revoked = 'r'.repeat(32);
  return {
    switchBookMock: vi.fn(),
    booksRef: {
      current: [
        { guid: household, name: 'Household' },
        { guid: business, name: 'Business' },
      ],
    },
    HOUSEHOLD: household,
    BUSINESS: business,
    REVOKED: revoked,
  };
});

vi.mock('@/contexts/BookContext', () => ({
  useBooks: () => ({
    activeBookGuid: HOUSEHOLD,
    books: booksRef.current,
    switchBook: switchBookMock,
  }),
}));

function documentResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'receipt:1',
    bookGuid: BUSINESS,
    bookName: 'Business',
    kind: 'receipt',
    title: 'Feed invoice',
    detail: 'Apiary feed, 12 bags',
    date: '2026-07-01T00:00:00.000Z',
    href: '/receipts',
    ...overrides,
  };
}

function payload(documents: Array<Record<string, unknown>>) {
  return {
    summary: {
      generatedAt: '2026-08-03T00:00:00.000Z',
      reportingCurrency: 'USD',
      graph: { rootBookGuid: HOUSEHOLD, entities: [], relationships: [] },
      entities: [],
      consolidated: {
        netWorth: 0,
        totalIncome: 0,
        totalExpenses: 0,
        cashFlow: 0,
        investmentValue: 0,
        liquidity: 0,
      },
      warnings: [],
    },
    transfers: [],
    documents,
    actionCounts: {},
    timeline: { events: [], conflicts: [] },
  };
}

function stubFamilyOffice(documents: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => payload(documents),
  } as Response)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  booksRef.current = [
    { guid: HOUSEHOLD, name: 'Household' },
    { guid: BUSINESS, name: 'Business' },
  ];
});

describe('Family Office cross-book document results', () => {
  it('switches the active book to the owning book before opening the document', async () => {
    switchBookMock.mockResolvedValue({ ok: true });
    stubFamilyOffice([documentResult()]);

    render(<FamilyOfficePage />);
    expect(await screen.findByText('Feed invoice')).toBeVisible();
    expect(screen.getByText(/Opens in Business/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Open Feed invoice in Business/ }));

    await waitFor(() => expect(switchBookMock).toHaveBeenCalledWith(BUSINESS, '/receipts'));
    expect(screen.getByText('Switching to Business…')).toBeVisible();
    expect(screen.queryByText(/no longer have access/)).not.toBeInTheDocument();
  });

  it('refuses a result whose book the caller is not authorized for instead of switching', async () => {
    stubFamilyOffice([documentResult({
      id: 'document:9',
      bookGuid: REVOKED,
      bookName: 'Former Client',
      title: 'Old lease',
    })]);

    render(<FamilyOfficePage />);
    expect(await screen.findByText('Old lease')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Open Old lease in Former Client/ }));

    await waitFor(() => expect(
      screen.getByText(/You no longer have access to Former Client/),
    ).toBeVisible());
    expect(switchBookMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Switching to/)).not.toBeInTheDocument();
  });

  it('reports a server refusal rather than leaving the click inert', async () => {
    // The client's book list can be stale after a revoked grant, so the book
    // passes the local check but the server rejects it. That rejection is the
    // authoritative one and has to reach the user.
    switchBookMock.mockResolvedValue({ ok: false, error: 'No access to this book' });
    stubFamilyOffice([documentResult()]);

    render(<FamilyOfficePage />);
    expect(await screen.findByText('Feed invoice')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Open Feed invoice in Business/ }));

    await waitFor(() => expect(
      screen.getByText(/was not opened: No access to this book/),
    ).toBeVisible());
    // The in-flight label must clear so the card is clickable again.
    expect(screen.queryByText('Switching to Business…')).not.toBeInTheDocument();
  });

  it('opens a document in the active book as a plain link without switching books', async () => {
    stubFamilyOffice([documentResult({
      id: 'receipt:2',
      bookGuid: HOUSEHOLD,
      bookName: 'Household',
      title: 'Grocery receipt',
    })]);

    render(<FamilyOfficePage />);
    const title = await screen.findByText('Grocery receipt');

    expect(title.closest('a')).toHaveAttribute('href', '/receipts');
    expect(screen.queryByText(/Opens in Household/)).not.toBeInTheDocument();
    expect(switchBookMock).not.toHaveBeenCalled();
  });
});

