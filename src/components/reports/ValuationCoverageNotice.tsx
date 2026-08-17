import { ErrorLiveRegion } from '@/components/a11y/LiveRegion';
import type { ValuationCoverage } from '@/lib/account-valuation';

/**
 * Disclosure for a financial statement built on partially valued balances.
 *
 * An unconvertible balance contributes 0 to its own section while whatever
 * funded it stays valued in another, so the statement's own balance check no
 * longer holds. Saying "the check cannot be assessed" is the honest reading;
 * showing a residual as though it were a rounding error is not.
 *
 * A stale price is the OTHER way a statement can be quietly wrong, and it
 * travels on the same coverage record so a reader sees both in one place. It
 * is reported separately from the gaps above because it says something
 * different: the balance IS in the total, at a price old enough that the total
 * may have moved. A complete statement can still be stale, so this notice
 * renders for staleness alone — the silence it replaces was the whole defect.
 */
export function ValuationCoverageNotice({
    coverage,
}: {
    coverage: ValuationCoverage | undefined;
}) {
    const stalePrices = coverage?.stalePrices ?? [];
    const incomplete = !!coverage && !coverage.complete;
    if (!coverage || (!incomplete && stalePrices.length === 0)) return null;

    // What is spoken, as one sentence. The visible panel below carries no role
    // of its own: it renders with its text already in place, and a live region
    // that arrives holding its message is the mount-with-the-message bug
    // ErrorLiveRegion exists to prevent — the node and the text enter the
    // accessibility tree in the same commit and nothing announces. The shared
    // region publishes on a later commit instead, so this is the path that
    // actually reaches a screen reader.
    const announcement = incomplete
        ? `This statement is incomplete: ${coverage.unvaluedAccountCount} account balance(s) `
            + 'could not be converted to the report currency, so the balance check cannot be '
            + 'assessed.'
            + (stalePrices.length > 0
                ? ` ${stalePrices.length} further commodit`
                    + `${stalePrices.length === 1 ? 'y is' : 'ies are'} priced from an out-of-date `
                    + 'quote.'
                : '')
        : `${stalePrices.length} commodit${stalePrices.length === 1 ? 'y is' : 'ies are'} `
            + 'included in this statement at an out-of-date quote; the figures may not reflect '
            + 'current value.';

    return (
        <div className="bg-warning/10 border border-warning/30 rounded-lg px-4 py-3 mb-4 text-sm text-warning">
            {/*
              * An exclusion breaks the statement and interrupts; an old price
              * qualifies a statement that still holds together, so it waits for
              * a pause rather than cutting across what the reader is doing.
              */}
            <ErrorLiveRegion
                message={announcement}
                politeness={incomplete ? 'assertive' : 'polite'}
            />
            {incomplete && (
                <>
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
                </>
            )}
            {stalePrices.length > 0 && (
                <div className={incomplete ? 'mt-3 pt-3 border-t border-warning/30' : undefined}>
                    <div className="font-medium">Priced from out-of-date quotes</div>
                    <p className="mt-1.5 text-xs">
                        {stalePrices.length} commodit{stalePrices.length === 1 ? 'y is' : 'ies are'}{' '}
                        included in this statement at the last price on file, which has not been
                        updated recently. The figures are real but may not reflect current value.
                        Each line below states the age of the quote and the age its market would
                        have to exceed before this said anything.
                    </p>
                    <ul className="mt-1.5 space-y-1 text-xs">
                        {stalePrices.map(stale => (
                            <li key={stale.commodityGuid}>{stale.message}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
