import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { MortgageService } from '@/lib/services/mortgage.service';

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
    const result = await MortgageService.detectMortgageDetails(accountGuid, interestAccountGuid);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error detecting mortgage details:', error);
    const message = error instanceof Error ? error.message : 'Failed to detect mortgage details';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
