import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { MortgageService } from '@/lib/services/mortgage.service';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { createCalculationTrace, persistCalculationTrace } from '@/lib/provenance';

const GUID_REGEX = /^[0-9a-f]{32}$/;

/**
 * GET /api/tools/mortgage/detect
 * Auto-detect mortgage details (original amount, interest rate, monthly payment)
 * by analyzing transaction history for the given mortgage and interest accounts.
 *
 * Query params:
 *   accountGuid - GUID of the mortgage liability account (32-char hex)
 *   interestAccountGuid - GUID of the interest expense account (32-char hex)
 */
export async function GET(request: NextRequest) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;

  const { searchParams } = new URL(request.url);
  const accountGuid = searchParams.get('accountGuid');
  const interestAccountGuid = searchParams.get('interestAccountGuid');

  if (!accountGuid || !interestAccountGuid) {
    return NextResponse.json(
      { error: 'Both accountGuid and interestAccountGuid query parameters are required' },
      { status: 400 }
    );
  }

  if (!GUID_REGEX.test(accountGuid) || !GUID_REGEX.test(interestAccountGuid)) {
    return NextResponse.json(
      { error: 'accountGuid and interestAccountGuid must be 32-character hex strings' },
      { status: 400 }
    );
  }

  try {
    const bookAccountGuids = await getAccountGuidsForBook(roleResult.bookGuid);
    if (!bookAccountGuids.includes(accountGuid) || !bookAccountGuids.includes(interestAccountGuid)) {
      return NextResponse.json({ error: 'Mortgage accounts not found in the active book' }, { status: 404 });
    }
    const result = await MortgageService.detectMortgageDetails(accountGuid, interestAccountGuid);
    const observedAt = new Date().toISOString();
    const trace = createCalculationTrace({
      namespace: 'mortgage-detection',
      identity: { bookGuid: roleResult.bookGuid, accountGuid, interestAccountGuid },
      title: 'Detected mortgage payment',
      summary: 'Mortgage principal, interest rate, and payment inferred from linked liability and interest-account history.',
      asOfDate: observedAt.slice(0, 10),
      formula: 'payment = principal × monthly rate × (1 + monthly rate)^360 ÷ ((1 + monthly rate)^360 − 1)',
      result: result.monthlyPayment,
      unit: 'currency',
      steps: [
        {
          key: 'principal',
          label: 'Detect original principal',
          inputs: { paymentsAnalyzed: result.paymentsAnalyzed },
          result: result.originalAmount,
        },
        {
          key: 'rate',
          label: 'Infer annual interest rate',
          inputs: { paymentsAnalyzed: result.paymentsAnalyzed, confidence: result.confidence },
          result: result.interestRate,
        },
        {
          key: 'payment',
          label: 'Calculate monthly principal and interest',
          inputs: { principal: result.originalAmount, annualRate: result.interestRate, termMonths: 360 },
          result: result.monthlyPayment,
        },
      ],
      evidence: [
        {
          kind: 'account',
          id: accountGuid,
          label: 'Mortgage liability account history',
          source: 'system',
          href: `/accounts/${accountGuid}`,
          observedAt,
          verified: false,
        },
        {
          kind: 'account',
          id: interestAccountGuid,
          label: 'Mortgage interest account history',
          source: 'system',
          href: `/accounts/${interestAccountGuid}`,
          observedAt,
          verified: false,
        },
      ],
      assumptions: ['A 360-month term is used when the transaction history does not establish a term.'],
      warnings: [
        ...result.warnings,
        ...(result.confidence === 'low' ? ['Limited payment history makes this detection low confidence.'] : []),
      ],
      metadata: { confidence: result.confidence, paymentsAnalyzed: result.paymentsAnalyzed },
    });
    await persistCalculationTrace(roleResult.user.id, roleResult.bookGuid, trace);
    return NextResponse.json({
      ...result,
      trace: { traceId: trace.id, href: `/api/provenance/${trace.id}` },
    });
  } catch (error) {
    console.error('Error detecting mortgage details:', error);
    const message = error instanceof Error ? error.message : 'Failed to detect mortgage details';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
