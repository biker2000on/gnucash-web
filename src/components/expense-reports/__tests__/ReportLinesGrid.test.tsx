import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReportLineView } from '../api';

const ACCOUNTS = [
  { guid: 'sw'.padEnd(32, '0'), name: 'Software', fullname: 'Root:Expenses:Software & Subscriptions', account_type: 'EXPENSE' },
  { guid: 'su'.padEnd(32, '0'), name: 'Supplies', fullname: 'Root:Expenses:Supplies', account_type: 'EXPENSE' },
  { guid: 'ed'.padEnd(32, '0'), name: 'Education', fullname: 'Root:Expenses:Continuing Education', account_type: 'EXPENSE' },
];
vi.mock('@/lib/hooks/useAccounts', () => ({ useAccounts: () => ({ data: ACCOUNTS, isLoading: false }) }));

import { ReportLinesGrid } from '../ReportLinesGrid';

// jsdom has no layout; AccountSelector scrolls the highlighted option into view.
Element.prototype.scrollIntoView = vi.fn();

const [SW, SU, ED] = ACCOUNTS.map((a) => a.guid);

function line(id: number, description: string, account: string | null = null): ReportLineView {
  return {
    id,
    kind: 'business',
    sourceSplitGuid: `s${id}`.padEnd(32, '0'),
    sourceTxGuid: `t${id}`.padEnd(32, '0'),
    amountCents: 1000 * id,
    expenseDate: `2026-09-0${id}`,
    description,
    businessPurpose: null,
    expenseAccountGuid: account,
    categorizedBy: account ? 'manual' : null,
    categorizedByLabel: account ? 'Manual' : 'Uncategorized',
    expenseAccountName: null,
    documentIds: [],
    accountablePlan: false,
    late: false,
    sortOrder: id,
  };
}

const LINES = [line(1, 'Google Workspace'), line(2, 'Golden Needle'), line(3, 'Protrainings CPR'), line(4, 'Silverliningherbs')];

function setup(lines = LINES) {
  const onSave = vi.fn(async () => undefined);
  render(<ReportLinesGrid lines={lines} mode="categorize" busy={false} onSave={onSave} />);
  const accountInput = (desc: string) =>
    screen.getByLabelText(`Expense account for ${desc}`).querySelector('input') as HTMLInputElement;
  return { onSave, accountInput };
}

/** Type into an AccountSelector and pick the first match with Enter. */
function pick(input: HTMLInputElement, text: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReportLinesGrid', () => {
  it('types a category, moves down with the keyboard, and types the next', () => {
    const { accountInput, onSave } = setup();
    const first = accountInput('Google Workspace');
    first.focus();
    pick(first, 'soft');
    // Dropdown closed after the pick: ↓ moves to the next line's account cell.
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(accountInput('Golden Needle'));
    pick(accountInput('Golden Needle'), 'suppl');
    // Enter (dropdown closed) also moves down.
    fireEvent.keyDown(accountInput('Golden Needle'), { key: 'Enter' });
    expect(document.activeElement).toBe(accountInput('Protrainings CPR'));
    // ↑ goes back up.
    fireEvent.keyDown(accountInput('Protrainings CPR'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(accountInput('Golden Needle'));

    fireEvent.click(screen.getByRole('button', { name: /Save 2 changes/ }));
    expect(onSave).toHaveBeenCalledWith(
      [
        { lineId: 1, expenseAccountGuid: SW },
        { lineId: 2, expenseAccountGuid: SU },
      ],
      [],
    );
  });

  it('edits line names and moves between rows in the same column', () => {
    const { onSave } = setup();
    const name1 = screen.getByLabelText('Line name for Google Workspace') as HTMLInputElement;
    name1.focus();
    fireEvent.change(name1, { target: { value: 'Google Workspace (Sept)' } });
    fireEvent.keyDown(name1, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByLabelText('Line name for Golden Needle'));
    fireEvent.keyDown(document.activeElement!, { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith([{ lineId: 1, description: 'Google Workspace (Sept)' }], []);
  });

  it('refuses to save an empty line name', () => {
    const { onSave } = setup();
    const name1 = screen.getByLabelText('Line name for Google Workspace');
    fireEvent.change(name1, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: /Save 1 change/ })).toBeDisabled();
    fireEvent.keyDown(name1, { key: 's', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('bulk-sets a category on a shift-clicked range', () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByLabelText('Select Golden Needle'));
    fireEvent.click(screen.getByLabelText('Select Silverliningherbs'), { shiftKey: true });
    expect(screen.getByText('3 selected · set category')).toBeInTheDocument();
    const bulk = screen.getByPlaceholderText('Type a category for the selected lines…') as HTMLInputElement;
    pick(bulk, 'educ');
    fireEvent.click(screen.getByRole('button', { name: /Save 3 changes/ }));
    expect(onSave).toHaveBeenCalledWith(
      [2, 3, 4].map((lineId) => ({ lineId, expenseAccountGuid: ED })),
      [],
    );
  });

  it('keeps the shift-click anchor when React defers the state update', () => {
    setup();
    // Both clicks inside one act(): React batches them, so the updaters run
    // after both handlers — as in a real browser — exposing a stale anchor.
    act(() => {
      fireEvent.click(screen.getByLabelText('Select Google Workspace'));
      fireEvent.click(screen.getByLabelText('Select Protrainings CPR'), { shiftKey: true });
    });
    expect(screen.getByText('3 selected · set category')).toBeInTheDocument();
  });

  it('selects every line from the header and discards edits', () => {
    setup();
    fireEvent.click(screen.getByLabelText('Select all lines'));
    expect(screen.getByText('4 selected · set category')).toBeInTheDocument();
    const name1 = screen.getByLabelText('Line name for Google Workspace') as HTMLInputElement;
    fireEvent.change(name1, { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(name1.value).toBe('Google Workspace');
  });

  it('sends "remember for this payee" with the save', () => {
    const { onSave } = setup([line(1, 'Google Workspace', SW)]);
    fireEvent.click(screen.getByLabelText('Remember for this payee'));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(onSave).toHaveBeenCalledWith([], [1]);
  });

  it('renders read-only lines without inputs', () => {
    render(<ReportLinesGrid lines={[line(1, 'Google Workspace', SW)]} mode="readonly" busy={false} onSave={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('Google Workspace')).toBeInTheDocument();
  });
});
