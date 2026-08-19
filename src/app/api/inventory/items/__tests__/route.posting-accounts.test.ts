/**
 * Route-level contract for item posting-account validation.
 *
 * The service raises one InventoryValidationError carrying per-field messages;
 * the route must surface it as a 400 whose body is `{ error, fields }` so the
 * item form can mark each offending input. Errors WITHOUT field detail keep
 * the plain `{ error }` shape every other inventory route already returns.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const BOOK = 'b'.repeat(32);

const { requireRoleMock, createItemMock, listItemsMock, updateItemMock } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  createItemMock: vi.fn(),
  listItemsMock: vi.fn(),
  updateItemMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));

// The real error classes matter here: mapInventoryError branches on
// `instanceof`, so the route test would be vacuous with stubbed ones.
vi.mock('@/lib/services/inventory.service', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/services/inventory.service')
  >('@/lib/services/inventory.service');
  return {
    ...actual,
    createItem: createItemMock,
    listItems: listItemsMock,
    updateItem: updateItemMock,
    getItem: vi.fn(),
    deactivateItem: vi.fn(),
  };
});
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/redis', () => ({ getRedis: () => null }));

import { POST } from '../route';
import { PUT } from '../[id]/route';
import { InventoryValidationError } from '@/lib/services/inventory.service';

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({ bookGuid: BOOK, user: { id: 1 } });
});

describe('POST /api/inventory/items', () => {
  it('returns 400 with per-field messages when posting accounts are missing', async () => {
    createItemMock.mockRejectedValue(new InventoryValidationError(
      'Ledger posting is enabled for this item, so its posting accounts must be set',
      {
        incomeAccountGuid: 'Income account is required when ledger posting is enabled',
        cogsAccountGuid: 'COGS account is required when ledger posting is enabled',
      },
    ));

    const response = await POST(request({ sku: 'SKU-1', name: 'Widget' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(Object.keys(body.fields)).toEqual(['incomeAccountGuid', 'cogsAccountGuid']);
    expect(body.error).toMatch(/ledger posting/i);
  });

  it('keeps the plain { error } shape for validation errors with no field detail', async () => {
    createItemMock.mockRejectedValue(new InventoryValidationError('sku is required'));

    const response = await POST(request({ sku: 'x', name: 'y' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'sku is required' });
    expect('fields' in body).toBe(false);
  });

  it('forwards postToLedger to the service so a stock-only item can opt out', async () => {
    createItemMock.mockResolvedValue({ id: 1 });

    const response = await POST(request({
      sku: 'SKU-1', name: 'Widget', postToLedger: false,
    }));

    expect(response.status).toBe(201);
    expect(createItemMock).toHaveBeenCalledWith(
      BOOK,
      expect.objectContaining({ postToLedger: false }),
    );
  });
});

describe('PUT /api/inventory/items/[id]', () => {
  const params = Promise.resolve({ id: '7' });

  it('forwards postToLedger on update', async () => {
    updateItemMock.mockResolvedValue({ id: 7 });

    await PUT(request({ postToLedger: true }), { params });

    expect(updateItemMock).toHaveBeenCalledWith(
      BOOK, 7, expect.objectContaining({ postToLedger: true }),
    );
  });

  it('surfaces the field-level 400 from a posting-account failure', async () => {
    updateItemMock.mockRejectedValue(new InventoryValidationError(
      'Ledger posting is enabled for this item, so its posting accounts must be set',
      { assetAccountGuid: 'Asset account is required when ledger posting is enabled' },
    ));

    const response = await PUT(request({ assetAccountGuid: null }), { params });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.fields.assetAccountGuid).toMatch(/required/i);
  });
});
