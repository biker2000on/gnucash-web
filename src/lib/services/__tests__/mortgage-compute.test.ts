import { describe, it, expect } from 'vitest';

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
});
