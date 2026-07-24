import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  requireRoleMock,
  getAccountGuidsForBookMock,
  listFinancialActionsMock,
  updateFinancialActionsMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  getAccountGuidsForBookMock: vi.fn(),
  listFinancialActionsMock: vi.fn(),
  updateFinancialActionsMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({
  getAccountGuidsForBook: getAccountGuidsForBookMock,
}));
vi.mock('@/lib/financial-actions/store', () => ({
  FinancialActionValidationError: class FinancialActionValidationError extends Error {},
  listFinancialActions: listFinancialActionsMock,
  updateFinancialActions: updateFinancialActionsMock,
}));

import { GET, PATCH } from '../route';

const BOOK_GUID = 'b'.repeat(32);
const ACTION_ID = `act_${'a'.repeat(32)}`;

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/actions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({
    user: { id: 7, username: 'reviewer' },
    role: 'edit',
    bookGuid: BOOK_GUID,
  });
  getAccountGuidsForBookMock.mockResolvedValue(['account-a']);
  updateFinancialActionsMock.mockResolvedValue(1);
});

describe('GET /api/actions', () => {
  it('uses the authorized book and denies forced refresh for readonly users', async () => {
    requireRoleMock.mockResolvedValue({
      user: { id: 7, username: 'reader' },
      role: 'readonly',
      bookGuid: BOOK_GUID,
    });

    const response = await GET(new NextRequest('http://localhost/api/actions?refresh=true'));

    expect(response.status).toBe(403);
    expect(listFinancialActionsMock).not.toHaveBeenCalled();
  });

  it('loads account scope from the role-authorized book', async () => {
    listFinancialActionsMock.mockResolvedValue({
      actions: [],
      summary: { new: 0, resolved: 0, automated: 0, overdue: 0 },
      verifiedThrough: null,
      generatedAt: '2026-07-23T00:00:00.000Z',
    });

    const response = await GET(new NextRequest('http://localhost/api/actions'));

    expect(response.status).toBe(200);
    expect(getAccountGuidsForBookMock).toHaveBeenCalledWith(BOOK_GUID);
    expect(listFinancialActionsMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      bookGuid: BOOK_GUID,
      bookAccountGuids: ['account-a'],
      refresh: false,
    }));
  });
});

describe('PATCH /api/actions', () => {
  it('returns the authorization response without touching storage', async () => {
    requireRoleMock.mockResolvedValue(
      NextResponse.json({ error: 'Requires edit role' }, { status: 403 }),
    );

    const response = await PATCH(request({ ids: [ACTION_ID], state: 'accepted' }));

    expect(response.status).toBe(403);
    expect(updateFinancialActionsMock).not.toHaveBeenCalled();
  });

  it('rejects malformed IDs and states', async () => {
    const badIds = await PATCH(request({ ids: 'not-an-array', state: 'accepted' }));
    const badState = await PATCH(request({ ids: [ACTION_ID], state: 'destroyed' }));

    expect(badIds.status).toBe(400);
    expect(badState.status).toBe(400);
    expect(updateFinancialActionsMock).not.toHaveBeenCalled();
  });

  it('passes user and book scope into a valid state update', async () => {
    const response = await PATCH(request({
      ids: [ACTION_ID],
      state: 'snoozed',
      snoozedUntil: '2026-08-01T00:00:00.000Z',
    }));

    expect(response.status).toBe(200);
    expect(updateFinancialActionsMock).toHaveBeenCalledWith({
      userId: 7,
      bookGuid: BOOK_GUID,
      ids: [ACTION_ID],
      state: 'snoozed',
      snoozedUntil: '2026-08-01T00:00:00.000Z',
    });
  });

  it('does not leak unexpected storage errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    updateFinancialActionsMock.mockRejectedValue(
      new Error('column private_schema.secret does not exist'),
    );

    const response = await PATCH(request({ ids: [ACTION_ID], state: 'accepted' }));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to update actions');
    expect(body.error).not.toContain('private_schema');
    errorSpy.mockRestore();
  });
});
