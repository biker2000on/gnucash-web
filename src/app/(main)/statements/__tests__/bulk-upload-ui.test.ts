import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
}));

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ success: mocks.toastSuccess, error: vi.fn() }),
}));

vi.mock('@/components/ui/AccountSelector', () => ({
  AccountSelector: () => null,
}));

vi.mock('../AssignAccountForm', () => ({
  AssignAccountForm: () => null,
  RECONCILE_ACCOUNT_TYPES: ['BANK'],
}));

import {
  isOfxFilename,
  needsSharedReconcileAccount,
  UploadModal,
  type StatementUploadItem,
} from '../page';

function item(name: string, status: StatementUploadItem['status'] = 'queued'): StatementUploadItem {
  return {
    id: name,
    file: { name } as File,
    status,
  };
}

describe('bulk statement upload account requirements', () => {
  it('recognizes both OFX filename extensions without regard to case', () => {
    expect(isOfxFilename('checking.OFX')).toBe(true);
    expect(isOfxFilename('brokerage.qfx')).toBe(true);
    expect(isOfxFilename('statement.csv')).toBe(false);
  });

  it('allows an OFX/QFX-only queued batch to omit the shared account', () => {
    expect(needsSharedReconcileAccount([item('checking.ofx'), item('brokerage.qfx')])).toBe(false);
  });

  it('requires the shared account when any queued file is PDF or CSV', () => {
    expect(needsSharedReconcileAccount([item('checking.ofx'), item('card.pdf')])).toBe(true);
    expect(needsSharedReconcileAccount([item('checking.csv')])).toBe(true);
  });

  it('does not require an account solely because an already-successful PDF remains visible', () => {
    expect(needsSharedReconcileAccount([item('old.pdf', 'success'), item('new.ofx')])).toBe(false);
  });

  it('continues requiring an account while a failed PDF or CSV can be retried', () => {
    expect(needsSharedReconcileAccount([item('card.pdf', 'error')])).toBe(true);
    expect(needsSharedReconcileAccount([item('card.csv', 'error')])).toBe(true);
  });
});

describe('bulk statement upload UI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.toastSuccess.mockReset();
  });

  it('uploads selected files sequentially, leaves partial failures visible, and retries only the failed file', async () => {
    let resolveFirstUpload: ((value: Response) => void) | undefined;
    const firstUpload = new Promise<Response>((resolve) => {
      resolveFirstUpload = resolve;
    });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstUpload)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unsupported CSV layout' }), { status: 422 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const onClose = vi.fn();
    const onUploaded = vi.fn();
    render(createElement(UploadModal, { isOpen: true, onClose, onUploaded }));
    const files = [
      new File(['first'], 'checking.ofx', { type: 'application/x-ofx' }),
      new File(['second'], 'card.qfx', { type: 'application/x-ofx' }),
    ];
    const fileInput = document.body.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();

    fireEvent.change(fileInput!, { target: { files } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload queued (2)' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0][1].body as FormData).get('file')).toBe(files[0]);

    await act(async () => {
      resolveFirstUpload?.(new Response(null, { status: 201 }));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[1][1].body as FormData).get('file')).toBe(files[1]);
    expect(await screen.findByText('Unsupported CSV layout')).toBeInTheDocument();
    expect(screen.getByText('checking.ofx')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onUploaded).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry card.qfx' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect((fetchMock.mock.calls[2][1].body as FormData).get('file')).toBe(files[1]);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Unsupported CSV layout')).not.toBeInTheDocument();
  });
});
