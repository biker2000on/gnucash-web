import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InlineAmountEditor } from '../InlineAmountEditor';

const baseProps = {
    budgetGuid: 'b'.repeat(32),
    accountGuid: 'a'.repeat(32),
    periodNum: 3,
    currency: 'USD',
};

function mockFetchOk() {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

describe('InlineAmountEditor', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('displays income in the reversed (positive) space and stores raw negative', async () => {
        const fetchMock = mockFetchOk();
        const onUpdate = vi.fn();
        render(
            <InlineAmountEditor
                {...baseProps}
                value={-5000}
                accountType="INCOME"
                balanceReversal="income_expense"
                onUpdate={onUpdate}
                isActive
            />
        );

        // Raw -5000 shows as +5000 in the input under income_expense reversal.
        const input = screen.getByRole('textbox') as HTMLInputElement;
        expect(input.value).toBe('5000');

        fireEvent.change(input, { target: { value: '6000' } });
        fireEvent.blur(input);

        // Optimistic: parent is updated immediately with the RAW value (-6000).
        expect(onUpdate).toHaveBeenCalledWith(-6000);

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.amount).toBe(-6000);
        expect(body.period_num).toBe(3);
    });

    it('Tab commits optimistically and navigates forward; Shift+Tab navigates back', () => {
        mockFetchOk();
        const onUpdate = vi.fn();
        const onNavigate = vi.fn();
        render(
            <InlineAmountEditor
                {...baseProps}
                value={100}
                accountType="EXPENSE"
                onUpdate={onUpdate}
                onNavigate={onNavigate}
                isActive
            />
        );
        const input = screen.getByRole('textbox');

        fireEvent.change(input, { target: { value: '250' } });
        fireEvent.keyDown(input, { key: 'Tab' });
        expect(onUpdate).toHaveBeenCalledWith(250);
        expect(onNavigate).toHaveBeenCalledWith(1);

        fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
        expect(onNavigate).toHaveBeenCalledWith(-1);
    });

    it('Enter commits and deactivates; Escape deactivates without committing', () => {
        const fetchMock = mockFetchOk();
        const onUpdate = vi.fn();
        const onDeactivate = vi.fn();

        const { rerender } = render(
            <InlineAmountEditor
                {...baseProps}
                value={100}
                accountType="EXPENSE"
                onUpdate={onUpdate}
                onDeactivate={onDeactivate}
                isActive
            />
        );
        let input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: '175' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onUpdate).toHaveBeenCalledWith(175);
        expect(onDeactivate).toHaveBeenCalledTimes(1);

        // Escape: no commit.
        onUpdate.mockClear();
        fetchMock.mockClear();
        rerender(
            <InlineAmountEditor
                {...baseProps}
                value={100}
                accountType="EXPENSE"
                onUpdate={onUpdate}
                onDeactivate={onDeactivate}
                isActive
            />
        );
        input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: '999' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(onUpdate).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reverts the optimistic update and reports an error when the save fails', async () => {
        const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const onUpdate = vi.fn();
        const onError = vi.fn();
        render(
            <InlineAmountEditor
                {...baseProps}
                value={100}
                accountType="EXPENSE"
                onUpdate={onUpdate}
                onError={onError}
                isActive
            />
        );
        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: '250' } });
        fireEvent.blur(input);

        // Optimistic set to 250, then reverted to the original 100 on failure.
        expect(onUpdate).toHaveBeenNthCalledWith(1, 250);
        await waitFor(() => expect(onUpdate).toHaveBeenNthCalledWith(2, 100));
        expect(onError).toHaveBeenCalled();
    });
});
