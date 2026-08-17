import { afterEach, describe, it, expect, vi } from 'vitest';
import prisma from '@/lib/prisma';
import { MortgageService } from '../mortgage.service';

vi.mock('@/lib/prisma', () => ({
  default: {
    $queryRaw: vi.fn(),
    splits: { findMany: vi.fn() },
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Mortgage Payment Computation', () => {
  it('should compute correct principal/interest for standard amortization', () => {
    const balance = 200000;
    const annualRate = 0.06;
    const monthlyRate = annualRate / 12;
    const monthlyPayment = 1199.10;

    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const principal = Math.round((monthlyPayment - interest) * 100) / 100;

    expect(interest).toBe(1000);
    expect(principal).toBeCloseTo(199.10, 1);
  });

  it('should return zero interest when balance is zero', () => {
    const balance = 0;
    const monthlyRate = 0.005;
    const interest = Math.round(balance * monthlyRate * 100) / 100;
    expect(interest).toBe(0);
  });

  it('should compute correct interest for partially paid down mortgage', () => {
    const balance = 150000;
    const annualRate = 0.05;
    const monthlyRate = annualRate / 12;
    const monthlyPayment = 1073.64;

    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const principal = Math.round((monthlyPayment - interest) * 100) / 100;

    expect(interest).toBe(625);
    expect(principal).toBeCloseTo(448.64, 1);
    expect(interest + principal).toBeCloseTo(monthlyPayment, 0);
  });

  it('should result in negative principal when payment is less than interest', () => {
    const balance = 300000;
    const annualRate = 0.08;
    const monthlyRate = annualRate / 12;
    const monthlyPayment = 1500;

    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const principal = Math.round((monthlyPayment - interest) * 100) / 100;

    expect(interest).toBe(2000);
    expect(principal).toBe(-500);
  });

  it('refuses to split a payment using a low-confidence 40% inferred rate without warnings', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma.$queryRaw as any).mockResolvedValue([{ balance: '-100000' }]);
    vi.spyOn(MortgageService, 'detectMortgageDetails').mockResolvedValue({
      originalAmount: 0,
      interestRate: 40,
      monthlyPayment: 0,
      paymentsAnalyzed: 3,
      confidence: 'low',
      warnings: [],
      paymentHistory: [],
    });

    // Before this regression fix, this returned { interest: 3333.33, principal: 1666.67 }.
    await expect(MortgageService.computePaymentForDate('mortgage', 'interest', 5000)).resolves.toEqual({
      reason: 'Mortgage rate confidence is too low to split this payment safely',
    });
  });

  it('uses a high-confidence ARM rate even when variable-rate detection warns', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma.$queryRaw as any).mockResolvedValue([{ balance: '-100000' }]);
    vi.spyOn(MortgageService, 'detectMortgageDetails').mockResolvedValue({
      originalAmount: 100000,
      interestRate: 7.46664,
      monthlyPayment: 1013.37,
      paymentsAnalyzed: 12,
      confidence: 'high',
      warnings: ['Variable rate detected'],
      paymentHistory: [],
    });

    await expect(MortgageService.computePaymentForDate('mortgage', 'interest', 1013.37)).resolves.toEqual({
      interest: 622.22,
      principal: 391.15,
    });
  });
});
