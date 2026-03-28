/**
 * Mortgage Detection Service
 *
 * Core mortgage analysis logic:
 * - Detecting original loan amount from GnuCash splits
 * - Separating payment splits into principal vs interest
 * - Reverse-engineering interest rate using Newton-Raphson method
 */

import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';

/**
 * A single payment broken into principal and interest components
 */
export interface PaymentSplit {
  date: Date;
  principal: number;
  interest: number;
  total: number;
}

/**
 * Result of interest rate detection via Newton-Raphson
 */
export interface RateDetectionResult {
  rate: number;
  converged: boolean;
}

/**
 * Confidence level for mortgage detection
 */
export type DetectionConfidence = 'high' | 'medium' | 'low';

/**
 * Full mortgage detection result
 */
export interface MortgageDetectionResult {
  originalAmount: number;
  interestRate: number;
  monthlyPayment: number;
  paymentsAnalyzed: number;
  confidence: DetectionConfidence;
  warnings: string[];
  paymentHistory: PaymentSplit[];
}

/**
 * Service class for mortgage detection and analysis
 */
export class MortgageService {
  /**
   * Separate transaction splits into principal vs interest components.
   *
   * Principal = splits posting to the mortgage liability account
   * Interest = splits posting to the interest expense account
   * Escrow and other splits are excluded.
   *
   * Groups by transaction date and returns an array of PaymentSplit.
   */
  static separateSplits(
    splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint | number | string;
      value_denom: bigint | number | string;
      post_date: Date;
    }>,
    mortgageAccountGuid: string,
    interestAccountGuid: string
  ): PaymentSplit[] {
    // Group splits by transaction
    const txMap = new Map<
      string,
      { date: Date; principal: number; interest: number }
    >();

    for (const split of splits) {
      const value = parseFloat(toDecimal(split.value_num, split.value_denom));

      // Only consider splits posting to mortgage or interest accounts
      if (
        split.account_guid !== mortgageAccountGuid &&
        split.account_guid !== interestAccountGuid
      ) {
        continue;
      }

      let entry = txMap.get(split.tx_guid);
      if (!entry) {
        entry = { date: split.post_date, principal: 0, interest: 0 };
        txMap.set(split.tx_guid, entry);
      }

      if (split.account_guid === mortgageAccountGuid) {
        // Principal payment reduces the liability (positive value = paying down)
        entry.principal += Math.abs(value);
      } else if (split.account_guid === interestAccountGuid) {
        // Interest expense
        entry.interest += Math.abs(value);
      }
    }

    // Convert to array sorted by date
    const payments: PaymentSplit[] = [];
    for (const entry of txMap.values()) {
      payments.push({
        date: entry.date,
        principal: entry.principal,
        interest: entry.interest,
        total: entry.principal + entry.interest,
      });
    }

    payments.sort((a, b) => a.date.getTime() - b.date.getTime());
    return payments;
  }

  /**
   * Detect the original loan amount.
   *
   * Strategy 1: Look for the first/largest posting to the liability account
   * (opening balance transaction).
   * Strategy 2 (fallback): Sum all principal postings.
   */
  static detectOriginalAmount(
    splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint | number | string;
      value_denom: bigint | number | string;
      post_date: Date;
    }>,
    mortgageAccountGuid: string
  ): number {
    // Filter to splits posting to the mortgage account
    const mortgageSplits = splits
      .filter((s) => s.account_guid === mortgageAccountGuid)
      .map((s) => ({
        ...s,
        value: parseFloat(toDecimal(s.value_num, s.value_denom)),
      }))
      .sort((a, b) => a.post_date.getTime() - b.post_date.getTime());

    if (mortgageSplits.length === 0) return 0;

    // Strategy 1: The first/largest posting is likely the opening balance.
    // In GnuCash, the opening balance for a liability is typically negative
    // (credit to the liability account). We look for the largest absolute value
    // among the earliest transactions.
    const firstDate = mortgageSplits[0].post_date.getTime();
    const openingSplits = mortgageSplits.filter(
      (s) => s.post_date.getTime() === firstDate
    );

    // Find the largest absolute value on the first date
    let maxAbsValue = 0;
    for (const s of openingSplits) {
      const absVal = Math.abs(s.value);
      if (absVal > maxAbsValue) {
        maxAbsValue = absVal;
      }
    }

    // If the largest opening split is significantly larger than subsequent splits,
    // it's likely the opening balance
    if (mortgageSplits.length > 1) {
      const subsequentValues = mortgageSplits
        .filter((s) => s.post_date.getTime() !== firstDate)
        .map((s) => Math.abs(s.value));

      if (subsequentValues.length > 0) {
        const avgSubsequent =
          subsequentValues.reduce((a, b) => a + b, 0) / subsequentValues.length;

        // If opening is at least 3x the average subsequent payment, use it
        if (maxAbsValue > avgSubsequent * 3) {
          return maxAbsValue;
        }
      } else {
        // Only one date of transactions, return the max
        return maxAbsValue;
      }
    } else {
      return maxAbsValue;
    }

    // Strategy 2 (fallback): Sum all principal postings
    const totalPrincipal = mortgageSplits.reduce(
      (sum, s) => sum + Math.abs(s.value),
      0
    );
    return totalPrincipal;
  }

  /**
   * Detect the interest rate using Newton-Raphson method.
   *
   * Solves: M = P * r(1+r)^n / ((1+r)^n - 1) for monthly rate r
   * Returns annual rate = r * 12 * 100
   *
   * @param originalAmount - Original loan principal (P)
   * @param monthlyPayment - Monthly payment amount (M)
   * @param totalPayments - Total number of payments (n)
   * @returns Rate detection result with annual percentage and convergence status
   */
  static detectInterestRate(
    originalAmount: number,
    monthlyPayment: number,
    totalPayments: number
  ): RateDetectionResult {
    if (totalPayments < 3) {
      return { rate: 0, converged: false };
    }

    if (originalAmount <= 0 || monthlyPayment <= 0) {
      return { rate: 0, converged: false };
    }

    // If monthly payment * totalPayments <= original amount, no interest
    if (monthlyPayment * totalPayments <= originalAmount) {
      return { rate: 0, converged: true };
    }

    // Newton-Raphson to find monthly rate r
    // f(r) = M - P * r * (1+r)^n / ((1+r)^n - 1) = 0
    let r = 0.04 / 12; // Initial guess: 4% annual
    const maxIterations = 100;
    const tolerance = 0.01;
    const P = originalAmount;
    const M = monthlyPayment;
    const n = totalPayments;

    for (let i = 0; i < maxIterations; i++) {
      const rn = Math.pow(1 + r, n); // (1+r)^n
      const f = M - (P * r * rn) / (rn - 1);

      // Check convergence
      if (Math.abs(f) < tolerance) {
        return { rate: r * 12 * 100, converged: true };
      }

      // Derivative of f with respect to r:
      // f'(r) = -P * [ (rn*(rn - 1) - r*n*(1+r)^(n-1)*(rn-1) + r*rn*n*(1+r)^(n-1)) / (rn-1)^2 ]
      // Simplified: f'(r) = -P * [ rn / (rn-1) + r*n*(1+r)^(n-1) * (1/(rn-1) - rn/(rn-1)^2) ]
      // Let's compute numerically for clarity
      const rn1 = Math.pow(1 + r, n - 1); // (1+r)^(n-1)
      const denom = rn - 1;
      const denom2 = denom * denom;

      // d/dr [r * rn / (rn - 1)]
      // = [rn + r * n * rn1] * (rn - 1) - r * rn * n * rn1
      // all over (rn - 1)^2
      // = [rn * (rn - 1) + r * n * rn1 * (rn - 1) - r * rn * n * rn1] / (rn - 1)^2
      // = [rn * (rn - 1) + r * n * rn1 * (rn - 1 - rn)] / (rn - 1)^2
      // = [rn * (rn - 1) - r * n * rn1] / (rn - 1)^2
      const numerator = rn * denom - r * n * rn1;
      const df = -P * numerator / denom2;

      if (Math.abs(df) < 1e-15) {
        return { rate: r * 12 * 100, converged: false };
      }

      const rNew = r - f / df;

      // Ensure rate stays positive and reasonable
      if (rNew <= 0) {
        r = r / 2;
      } else if (rNew > 1) {
        r = 0.5; // Cap at 50% monthly
      } else {
        r = rNew;
      }
    }

    // Did not converge
    return { rate: r * 12 * 100, converged: false };
  }

  /**
   * Compute the principal/interest split for a mortgage payment at a given date.
   * Uses the current account balance and detected interest rate.
   *
   * Returns null if computation fails (balance zero, rate not detected).
   */
  static async computePaymentForDate(
    liabilityAccountGuid: string,
    interestAccountGuid: string,
    totalPayment: number,
  ): Promise<{ principal: number; interest: number } | null> {
    try {
      // Get current balance of the liability account
      const balanceRows = await prisma.$queryRaw<{ balance: string }[]>`
        SELECT CAST(SUM(CAST(value_num AS DECIMAL) / CAST(value_denom AS DECIMAL)) AS TEXT) as balance
        FROM splits
        WHERE account_guid = ${liabilityAccountGuid}
      `;

      const balance = Math.abs(parseFloat(balanceRows[0]?.balance ?? '0'));
      if (balance <= 0) return null;

      // Detect interest rate from full mortgage detection pipeline
      const details = await MortgageService.detectMortgageDetails(
        liabilityAccountGuid,
        interestAccountGuid,
      );

      if (details.interestRate <= 0 || details.paymentsAnalyzed < 3) return null;

      const monthlyRate = details.interestRate / 100 / 12;
      const interest = Math.round(balance * monthlyRate * 100) / 100;
      const principal = Math.round((totalPayment - interest) * 100) / 100;

      if (principal <= 0) return null;

      return { principal, interest };
    } catch {
      return null;
    }
  }

  /**
   * Full pipeline: query DB for splits, separate, detect amount, detect rate.
   *
   * @param mortgageAccountGuid - GUID of the mortgage liability account
   * @param interestAccountGuid - GUID of the interest expense account
   * @returns Full mortgage detection result
   */
  static async detectMortgageDetails(
    mortgageAccountGuid: string,
    interestAccountGuid: string
  ): Promise<MortgageDetectionResult> {
    const warnings: string[] = [];

    // Query all splits for both the mortgage and interest accounts, joined with transaction dates
    const splits = await prisma.splits.findMany({
      where: {
        account_guid: {
          in: [mortgageAccountGuid, interestAccountGuid],
        },
      },
      include: {
        transaction: {
          select: {
            post_date: true,
          },
        },
      },
      orderBy: {
        transaction: {
          post_date: 'asc',
        },
      },
    });

    // Transform splits to include post_date at the top level
    const enrichedSplits = splits.map((s) => ({
      tx_guid: s.tx_guid,
      account_guid: s.account_guid,
      value_num: s.value_num,
      value_denom: s.value_denom,
      post_date: s.transaction!.post_date!,
    }));

    // Separate into principal and interest
    const payments = MortgageService.separateSplits(
      enrichedSplits,
      mortgageAccountGuid,
      interestAccountGuid
    );

    // Detect original amount
    const originalAmount = MortgageService.detectOriginalAmount(
      enrichedSplits,
      mortgageAccountGuid
    );

    // Calculate interest rate directly from interest/balance ratios.
    // This avoids contamination from escrow splits that also post to the mortgage account.
    //
    // Exclude the opening balance transaction: it's the one with principal close to
    // originalAmount (within 10%), which is not a regular monthly payment.
    const regularPayments = payments.filter(
      (p) => p.principal > 0 && p.interest > 0 &&
        Math.abs(p.principal - originalAmount) / originalAmount > 0.1
    );

    // Estimate total payments (assume 30-year mortgage if we can't determine)
    const totalPayments = 360;

    let rateResult: RateDetectionResult;

    if (regularPayments.length >= 3) {
      // Estimate monthly rate from interest/balance ratios
      let remainingBalance = originalAmount;
      const monthlyRates: number[] = [];

      for (const payment of regularPayments) {
        if (remainingBalance > 0) {
          const impliedMonthlyRate = payment.interest / remainingBalance;
          monthlyRates.push(impliedMonthlyRate);
          // Only subtract the interest-implied principal (total P+I minus interest),
          // not the raw principal which may include escrow
          const impliedPrincipal = payment.total - payment.interest;
          // But escrow inflates payment.total too, so use: principal from amortization
          // For a fixed rate: principal = M - interest, but we don't know M yet.
          // Use interest to estimate rate first, then compute M from rate.
          // For balance tracking, approximate with: balance * monthly_rate gives interest,
          // so principal portion ≈ balance_change. Use the smallest mortgage split
          // (which is more likely the real principal) minus escrow.
          // Simplest: just reduce by interest-implied principal from the formula.
          remainingBalance -= (payment.total - payment.interest);
          if (remainingBalance < 0) remainingBalance = 0;
        }
      }

      // Use median rate for robustness
      monthlyRates.sort((a, b) => a - b);
      const medianRate = monthlyRates[Math.floor(monthlyRates.length / 2)];
      const annualRate = medianRate * 12 * 100;

      rateResult = { rate: annualRate, converged: true };
    } else {
      // Fallback to Newton-Raphson with whatever monthly payment we have
      const monthlyPayment =
        regularPayments.length > 0
          ? regularPayments.reduce((sum, p) => sum + p.total, 0) /
            regularPayments.length
          : 0;
      rateResult = MortgageService.detectInterestRate(
        originalAmount,
        monthlyPayment,
        totalPayments
      );
    }

    // Compute theoretical monthly P+I payment from detected rate and original amount
    const detectedMonthlyRate = rateResult.rate / 100 / 12;
    let monthlyPayment: number;
    if (detectedMonthlyRate > 0 && rateResult.converged) {
      const rn = Math.pow(1 + detectedMonthlyRate, totalPayments);
      monthlyPayment = originalAmount * detectedMonthlyRate * rn / (rn - 1);
    } else {
      monthlyPayment =
        regularPayments.length > 0
          ? regularPayments.reduce((sum, p) => sum + p.total, 0) /
            regularPayments.length
          : 0;
    }

    // Check for variable rate by computing implied rates from individual payments
    if (regularPayments.length >= 3) {
      const individualRates: number[] = [];
      let remainingBalance = originalAmount;

      for (const payment of regularPayments) {
        if (remainingBalance > 0) {
          const impliedMonthlyRate = payment.interest / remainingBalance;
          individualRates.push(impliedMonthlyRate * 12 * 100);
          // Use theoretical principal (P+I - interest) to track balance,
          // not payment.principal which may include escrow splits
          const theoreticalPrincipal = monthlyPayment - payment.interest;
          remainingBalance -= Math.max(theoreticalPrincipal, 0);
        }
      }

      if (individualRates.length >= 3) {
        const avgRate =
          individualRates.reduce((a, b) => a + b, 0) / individualRates.length;
        const maxDeviation = Math.max(
          ...individualRates.map((r) => Math.abs(r - avgRate))
        );

        if (maxDeviation > 0.5) {
          warnings.push('Variable rate detected');
        }
      }
    }

    // Determine confidence
    let confidence: DetectionConfidence;
    if (regularPayments.length > 10) {
      // Check payment variance
      const paymentAmounts = regularPayments.map((p) => p.total);
      const avgPayment =
        paymentAmounts.reduce((a, b) => a + b, 0) / paymentAmounts.length;
      const maxVariance = Math.max(
        ...paymentAmounts.map((p) => Math.abs(p - avgPayment) / avgPayment)
      );

      confidence = maxVariance < 0.001 ? 'high' : 'medium';
    } else if (regularPayments.length >= 3) {
      confidence = 'medium';
    } else {
      confidence = 'low';
      if (regularPayments.length < 3) {
        warnings.push('Insufficient data');
      }
    }

    // Build payment history excluding the opening balance transaction
    const paymentHistory = payments.filter(
      (p) => Math.abs(p.principal - originalAmount) / originalAmount > 0.1
    );

    return {
      originalAmount,
      interestRate: rateResult.rate,
      monthlyPayment,
      paymentsAnalyzed: payments.length,
      confidence,
      warnings,
      paymentHistory,
    };
  }
}

export default MortgageService;
