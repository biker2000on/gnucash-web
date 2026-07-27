import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FinancialActionCenterPage from './page';
import type { FinancialAction, FinancialActionList } from '@/lib/financial-actions/types';

const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => toastMock,
}));
vi.mock('@/lib/financial-actions/client-events', () => ({
  subscribeToActionCenterUpdates: () => () => undefined,
}));

function action(
  id: string,
  title: string,
  lane: FinancialAction['lane'] = 'fix',
): FinancialAction {
  return {
    id,
    stableKey: id,
    bookGuid: 'b'.repeat(32),
    lane,
    origin: 'data_health',
    sourceId: id,
    severity: 'warning',
    title,
    summary: `${title} summary`,
    dueDate: null,
    impact: null,
    confidence: 1,
    score: null,
    assignee: null,
    operations: [],
    trace: {
      id: `trace-${id}`,
      version: 1,
      title,
      summary: '',
      generatedAt: '2026-07-27T00:00:00.000Z',
      asOfDate: '2026-07-27',
      result: null,
      steps: [],
      evidence: [],
      assumptions: [],
      warnings: [],
    },
    metadata: {},
    state: 'open',
    snoozedUntil: null,
    firstSeenAt: '2026-07-27T00:00:00.000Z',
    lastSeenAt: '2026-07-27T00:00:00.000Z',
    stateChangedAt: '2026-07-27T00:00:00.000Z',
    resolvedAt: null,
  };
}

function list(actions: FinancialAction[]): FinancialActionList {
  return {
    actions,
    summary: { new: actions.length, resolved: 0, automated: 0, overdue: 0 },
    verifiedThrough: null,
    generatedAt: '2026-07-27T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('FinancialActionCenterPage mutations', () => {
  it('keeps the card grid mounted while a dismissed item is refreshed away', async () => {
    const dismissed = action('dismiss-me', 'Dismiss me');
    const remaining = action('stay-here', 'Stay here');
    let finishBackgroundRefresh: (() => void) | null = null;
    let getCount = 0;

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse({ ok: true, updated: 1 });
      getCount += 1;
      if (getCount === 1) return jsonResponse(list([dismissed, remaining]));
      return new Promise<Response>((resolve) => {
        finishBackgroundRefresh = () => resolve(jsonResponse(list([remaining])));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FinancialActionCenterPage />);
    const dismissedTitle = await screen.findByText('Dismiss me');
    const dismissedCard = dismissedTitle.closest('article');
    expect(dismissedCard).not.toBeNull();

    fireEvent.click(within(dismissedCard!).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument());
    expect(screen.getByText('Stay here')).toBeVisible();
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();

    finishBackgroundRefresh?.();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('moves card focus with arrow keys instead of j/k', async () => {
    const first = action('first', 'First action');
    const second = action('second', 'Second action');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(list([first, second]))));

    render(<FinancialActionCenterPage />);
    const firstCard = (await screen.findByText('First action')).closest('article')!;
    const secondCard = screen.getByText('Second action').closest('article')!;
    expect(firstCard).toHaveClass('ring-1');
    expect(secondCard).not.toHaveClass('ring-1');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(firstCard).not.toHaveClass('ring-1');
    expect(secondCard).toHaveClass('ring-1');

    fireEvent.keyDown(window, { key: 'j' });
    expect(secondCard).toHaveClass('ring-1');

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(firstCard).toHaveClass('ring-1');
    expect(secondCard).not.toHaveClass('ring-1');
  });

  it('moves within lanes vertically and between desktop lanes horizontally', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(min-width: 1280px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const fixFirst = action('fix-first', 'Fix first', 'fix');
    const decideFirst = action('decide-first', 'Decide first', 'decide');
    const fixSecond = action('fix-second', 'Fix second', 'fix');
    const decideSecond = action('decide-second', 'Decide second', 'decide');
    const doFirst = action('do-first', 'Do first', 'do');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(list([
      fixFirst,
      decideFirst,
      fixSecond,
      decideSecond,
      doFirst,
    ]))));

    render(<FinancialActionCenterPage />);
    const fixFirstCard = (await screen.findByText('Fix first')).closest('article')!;
    const fixSecondCard = screen.getByText('Fix second').closest('article')!;
    const decideSecondCard = screen.getByText('Decide second').closest('article')!;
    const doFirstCard = screen.getByText('Do first').closest('article')!;

    expect(fixFirstCard).toHaveClass('ring-1');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(fixSecondCard).toHaveClass('ring-1');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(decideSecondCard).toHaveClass('ring-1');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(doFirstCard).toHaveClass('ring-1');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('Decide first').closest('article')).toHaveClass('ring-1');
  });

  it('does not switch lanes with horizontal arrows on stacked layouts', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(min-width: 1280px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const fix = action('fix', 'Fix action', 'fix');
    const decide = action('decide', 'Decide action', 'decide');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(list([fix, decide]))));

    render(<FinancialActionCenterPage />);
    const fixCard = (await screen.findByText('Fix action')).closest('article')!;

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(fixCard).toHaveClass('ring-1');
  });

  it('supports pending, all, and completed-only views', async () => {
    const pending = action('pending', 'Pending action');
    const resolved = { ...action('resolved', 'Resolved action'), state: 'resolved' as const };
    const dismissed = { ...action('dismissed', 'Dismissed action'), state: 'dismissed' as const };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const includeCompleted = new URL(String(input), 'http://localhost').searchParams
        .get('includeCompleted') === 'true';
      return jsonResponse(list(includeCompleted ? [pending, resolved, dismissed] : [pending]));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FinancialActionCenterPage />);
    const view = screen.getByRole('combobox', { name: 'Action view' });

    expect(await screen.findByText('Pending action')).toBeVisible();
    expect(screen.queryByText('Resolved action')).not.toBeInTheDocument();

    fireEvent.change(view, { target: { value: 'completed' } });
    expect(await screen.findByText('Resolved action')).toBeVisible();
    expect(screen.getByText('Dismissed action')).toBeVisible();
    expect(screen.queryByText('Pending action')).not.toBeInTheDocument();

    fireEvent.change(view, { target: { value: 'all' } });
    expect(await screen.findByText('Pending action')).toBeVisible();
    expect(screen.getByText('Resolved action')).toBeVisible();
    expect(screen.getByText('Dismissed action')).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('includeCompleted=true'),
      { cache: 'no-store' },
    );
  });
});
