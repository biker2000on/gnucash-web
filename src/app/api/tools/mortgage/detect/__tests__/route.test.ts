import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getAccountGuidsForBook: vi.fn(),
  detectMortgageDetails: vi.fn(),
  createCalculationTrace: vi.fn(),
  persistCalculationTrace: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/book-scope', () => ({ getAccountGuidsForBook: mocks.getAccountGuidsForBook }));
vi.mock('@/lib/services/mortgage.service', () => ({
  MortgageService: { detectMortgageDetails: mocks.detectMortgageDetails },
}));
vi.mock('@/lib/provenance', () => ({
  createCalculationTrace: mocks.createCalculationTrace,
  persistCalculationTrace: mocks.persistCalculationTrace,
}));

import { GET } from '../route';

const BOOK = 'b'.repeat(32);
const MORTGAGE = 'a'.repeat(32);
const INTEREST = 'c'.repeat(32);

function request(accountGuid = MORTGAGE, interestAccountGuid = INTEREST) {
  return { url: `http://localhost/api/tools/mortgage/detect?accountGuid=${accountGuid}&interestAccountGuid=${interestAccountGuid}` } as NextRequest;
}

describe('mortgage detection provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ user: { id: 9 }, bookGuid: BOOK, role: 'readonly' });
    mocks.getAccountGuidsForBook.mockResolvedValue([MORTGAGE, INTEREST]);
    mocks.detectMortgageDetails.mockResolvedValue({
      originalAmount: 300_000,
      interestRate: 6.5,
      monthlyPayment: 1_896.2,
      paymentsAnalyzed: 12,
      confidence: 'high',
      warnings: [],
      paymentHistory: [],
    });
    mocks.createCalculationTrace.mockReturnValue({ id: `trace_${'d'.repeat(32)}` });
    mocks.persistCalculationTrace.mockResolvedValue(undefined);
  });

  it('returns and persists a trace reference for book-scoped accounts', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.trace).toEqual({
      traceId: `trace_${'d'.repeat(32)}`,
      href: `/api/provenance/trace_${'d'.repeat(32)}`,
    });
    expect(mocks.createCalculationTrace).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'mortgage-detection',
      result: 1_896.2,
      unit: 'currency',
    }));
    expect(mocks.persistCalculationTrace).toHaveBeenCalledWith(9, BOOK, expect.anything());
  });

  it('rejects accounts outside the active book before detection', async () => {
    mocks.getAccountGuidsForBook.mockResolvedValue([MORTGAGE]);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(mocks.detectMortgageDetails).not.toHaveBeenCalled();
  });
});
