import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import FilingComparisonPage from './page';

afterEach(() => {
  vi.restoreAllMocks();
});

const APPLICABLE_PAYLOAD = {
  applicable: true,
  year: 2025,
  filingStatus: 'mfj',
  bookData: {
    year: 2025,
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    asOfDate: '2025-12-31',
    elapsedYearFraction: 1,
    categories: [
      {
        category: 'w2_wages',
        total: 150_000,
        accounts: [
          { accountGuid: 'wage-self', accountName: 'Salary A', accountPath: 'Income:Salary A', amount: 100_000 },
          { accountGuid: 'wage-spouse', accountName: 'Salary B', accountPath: 'Income:Salary B', amount: 50_000 },
        ],
      },
      {
        category: 'interest_income',
        total: 1_000,
        accounts: [
          { accountGuid: 'joint-savings', accountName: 'Savings', accountPath: 'Assets:Savings', amount: 1_000 },
        ],
      },
    ],
    realizedGains: { shortTerm: 0, longTerm: 0, accounts: [] },
    contributionsByType: {},
    contributionsByTypeAndOwner: {},
    flaggedRetirementTypes: [],
    mappedAccountCount: 3,
  },
  ownerByAccount: { 'wage-self': 'self', 'wage-spouse': 'spouse' },
  household: {
    selfName: 'Alex',
    spouseName: 'Riley',
    dependentsUnder17: 1,
    self: { age65: false, coveredByEmployerPlan: true, iraLimit: 7000 },
    spouse: { age65: false, coveredByEmployerPlan: false, iraLimit: 7000 },
  },
};

function mockFetch(payload: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/tax/filing-comparison')) {
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (url.includes('/api/tools/config')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

describe('filing comparison page', () => {
  it('renders the verdict, side-by-side table, breakeven sweep, and caveats for a joint household', async () => {
    mockFetch(APPLICABLE_PAYLOAD);
    render(<FilingComparisonPage />);

    await waitFor(() => {
      expect(screen.getByText('Filing jointly')).toBeInTheDocument();
    });
    expect(screen.getByText('Filing separately (combined)')).toBeInTheDocument();
    expect(screen.getByText('Side by side')).toBeInTheDocument();
    expect(screen.getByText('Breakeven sweep')).toBeInTheDocument();
    expect(screen.getByText('Marriage penalty / bonus lens')).toBeInTheDocument();
    // Caveats are surfaced in the result, not fine print.
    expect(screen.getByText(/MFS forfeits the Earned Income Tax Credit/)).toBeInTheDocument();
    expect(screen.getByText(/Community-property states are out of scope/)).toBeInTheDocument();
    // Household names label the separate columns.
    expect(screen.getByText('Alex (sep.)')).toBeInTheDocument();
    expect(screen.getByText('Riley (sep.)')).toBeInTheDocument();
  });

  it('shows the gentle empty state for a household that does not file jointly', async () => {
    mockFetch({ applicable: false, entityType: 'household', filingStatus: 'single' });
    render(<FilingComparisonPage />);

    await waitFor(() => {
      expect(screen.getByText('Nothing to compare here')).toBeInTheDocument();
    });
    expect(screen.getByText(/only applies when your household currently files\s+jointly/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '/settings');
  });

  it('shows the business empty state for non-household books', async () => {
    mockFetch({ applicable: false, entityType: 's_corp', filingStatus: 'single' });
    render(<FilingComparisonPage />);
    await waitFor(() => {
      expect(screen.getByText(/business entity, which doesn't file a personal 1040/)).toBeInTheDocument();
    });
  });
});
