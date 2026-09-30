import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpenseReportBadge, useExpenseReportBadges } from '../ExpenseReportBadge';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

function Harness({ guids }: { guids: string[] }) {
  const badges = useExpenseReportBadges(guids);
  return (
    <ul>
      {guids.map((g) => (
        <li key={g}>
          <ExpenseReportBadge text={badges[g]} />
        </li>
      ))}
    </ul>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useExpenseReportBadges', () => {
  it('keeps a late answer when the row list changes mid-flight', async () => {
    // Regression: the ledger's row list changes identity right after its
    // first load. Discarding the in-flight answer stranded the guid as
    // "asked" and the badge never appeared.
    let resolveFirst: (r: Response) => void = () => undefined;
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ badges: {} }), { status: 200 }));

    const { rerender } = render(<Harness guids={[A]} />);
    rerender(<Harness guids={[A, B]} />);
    await act(async () => {
      resolveFirst(new Response(JSON.stringify({ badges: { [A]: 'Reported · ER-1 · Submitted' } }), { status: 200 }));
    });

    expect(await screen.findByText('Reported · ER-1 · Submitted')).toBeInTheDocument();
    // A was asked once; only B was fetched for the second list.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondBody.splitGuids).toEqual([B]);
  });

  it('retries after a failed request', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValue(new Response(JSON.stringify({ badges: { [A]: 'Reported · ER-2 · Paid 2026-10-05' } }), { status: 200 }));
    const { rerender } = render(<Harness guids={[A]} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<Harness guids={[A, B]} />);
    expect(await screen.findByText('Reported · ER-2 · Paid 2026-10-05')).toBeInTheDocument();
  });

  it('renders nothing without a badge and links to the reports page', () => {
    const { container } = render(<ExpenseReportBadge text={undefined} />);
    expect(container).toBeEmptyDOMElement();
    render(<ExpenseReportBadge text="Reported · ER-3 · Approved" />);
    expect(screen.getByRole('link', { name: 'Reported · ER-3 · Approved' })).toHaveAttribute('href', '/expense-reports');
  });
});
