import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Profiler, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AccountHierarchy from '../AccountHierarchy';
import type { AccountWithChildren } from '@/lib/types';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
    default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/lib/hooks/useIsMobile', () => ({
    useIsMobile: () => false,
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
    useUserPreferences: () => ({ balanceReversal: 'none', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('@/contexts/ToastContext', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/hooks/useAccounts', () => ({
    useInvalidateAccounts: () => vi.fn(),
}));

vi.mock('@/lib/hooks/useReviewStatus', () => ({
    useReviewStatus: () => ({ data: undefined }),
}));

vi.mock('@/lib/hooks/useHouseholdNames', () => ({
    useHouseholdNames: () => ({ selfName: 'Self', spouseName: 'Spouse' }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({
    useCurrentUser: () => ({ isReadonly: false }),
    READONLY_TOOLTIP: 'Read-only',
}));

vi.mock('../SimpleFinSyncIndicator', () => ({
    default: () => null,
}));

function makeAccount(
    guid: string,
    name: string,
    children: AccountWithChildren[] = [],
    parentGuid: string | null = null,
): AccountWithChildren {
    return {
        guid,
        name,
        account_type: 'ASSET',
        commodity_guid: 'usd',
        commodity_scu: 100,
        non_std_scu: 0,
        parent_guid: parentGuid,
        code: '',
        description: '',
        hidden: 0,
        placeholder: 0,
        total_balance: '100.00',
        period_balance: '10.00',
        commodity_mnemonic: 'USD',
        children,
    };
}

const accounts: AccountWithChildren[] = [
    makeAccount('assets', 'Assets', [
        makeAccount('checking', 'Checking', [], 'assets'),
        makeAccount('savings', 'Savings', [], 'assets'),
    ]),
];

/**
 * Fetch stub that keeps the reconcile-summary and tags queries PENDING
 * forever. While those queries are in flight (or failed), `data` is
 * undefined; a plain `= []` destructure default then mints a fresh array
 * every render, which is exactly the identity churn that fed the infinite
 * re-render loop this suite pins (see the regression test below).
 */
function installFetch({ hang }: { hang: boolean }) {
    const never = new Promise<Response>(() => {});
    const handler = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/accounts/reconcile-summary')) {
            if (hang) return never;
            return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.startsWith('/api/tags')) {
            if (hang) return never;
            return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.startsWith('/api/user/preferences')) {
            return new Response(JSON.stringify({ preferences: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', handler);
    return handler;
}

function renderHierarchy() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    let commits = 0;
    render(
        <QueryClientProvider client={queryClient}>
            <Profiler id="hierarchy" onRender={() => { commits += 1; }}>
                <AccountHierarchy accounts={accounts} />
            </Profiler>
        </QueryClientProvider>
    );
    return { queryClient, commitCount: () => commits };
}

async function flushSettleWindow() {
    for (let i = 0; i < 20; i++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
}

beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
});

describe('AccountHierarchy', () => {
    it('renders the account tree', async () => {
        installFetch({ hang: false });
        renderHierarchy();

        expect(screen.getByText('Assets')).toBeInTheDocument();
        expect(screen.getByText('Checking')).toBeInTheDocument();
        expect(screen.getByText('Savings')).toBeInTheDocument();
        await flushSettleWindow();
    });

    /**
     * Regression: intermittent full-page freeze on /accounts load
     * (2026-08-27), same mechanism as the document-vault loop fixed in
     * 556fb21b. While the reconcile-summary or tags query was pending (or
     * failed), `const { data = [] } = useQuery(...)` minted a fresh array
     * every render; the identity churn cascaded into the table's
     * `data`/`columns`, every row-model memo bust queued
     * `_autoResetPageIndex`, and its `resetPageIndex()` spread a never-equal
     * state object — an infinite DefaultLane loop pegging a core until the
     * query resolved (or forever, if it errored). This pins "commits settle
     * while the queries are still in flight".
     */
    it('settles after mount while its queries are still pending', async () => {
        installFetch({ hang: true });
        const { commitCount } = renderHierarchy();

        // Let mount effects and any queued table-core auto-resets flush.
        await flushSettleWindow();
        const settled = commitCount();

        await flushSettleWindow();
        expect(commitCount()).toBe(settled);
    });
});
