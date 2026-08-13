import type { ValuationCoverage } from '@/lib/account-valuation';

/**
 * Disclosure for a financial statement built on partially valued balances.
 *
 * An unconvertible balance contributes 0 to its own section while whatever
 * funded it stays valued in another, so the statement's own balance check no
 * longer holds. Saying "the check cannot be assessed" is the honest reading;
 * showing a residual as though it were a rounding error is not.
 */
export function ValuationCoverageNotice({
    coverage,
}: {
    coverage: ValuationCoverage | undefined;
}) {
    if (!coverage || coverage.complete) return null;

    return (
        <div
            role="alert"
            className="bg-warning/10 border border-warning/30 rounded-lg px-4 py-3 mb-4 text-sm text-warning"
        >
            <div className="font-medium">
                This statement is incomplete — the balance check cannot be assessed
            </div>
            <p className="mt-1.5 text-xs">
                {coverage.unvaluedAccountCount} account balance(s) could not be converted to
                the report currency, so they count as nothing in their own section while the
                accounts that fund them stay valued. Assets, liabilities, and equity will not
                agree until the missing prices and rates are supplied.
            </p>
            {coverage.gaps.length > 0 && (
                <ul className="mt-1.5 space-y-1 text-xs">
                    {coverage.gaps.map(gap => (
                        <li key={gap.commodityGuid}>{gap.message}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}
