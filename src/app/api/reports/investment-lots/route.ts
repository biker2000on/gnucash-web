import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { getLatestPrice } from '@/lib/commodities';
import { getBaseCurrency } from '@/lib/currency';
import { buildAccountPathMap } from '@/lib/reports/utils';
import { getLotsForAccounts, type LotSummary } from '@/lib/lots';

interface LotReportRow {
    accountName: string;
    accountGuid: string;
    commodityMnemonic: string;
    lotTitle: string;
    lotGuid: string;
    isClosed: boolean;
    openDate: string | null;
    /**
     * Original acquisition date carried through an in-kind transfer, when the
     * lot has one. This — not openDate — is what the holding period and
     * daysHeld are measured from, so the UI can explain a long-term lot whose
     * destination account only received the shares recently.
     */
    acquisitionDate: string | null;
    closeDate: string | null;
    shares: number;
    costBasis: number;
    marketValue: number | null;
    realizedGain: number;
    unrealizedGain: number | null;
    totalGain: number | null;
    holdingPeriod: 'short_term' | 'long_term' | null;
    daysHeld: number | null;
}

interface InvestmentLotsReportData {
    rows: LotReportRow[];
    /**
     * Charges on a trade transaction that were deliberately NOT folded into
     * basis or proceeds because they could not be classified as a commission
     * (see @/lib/trade-fees). A silent refusal would leave this report short by
     * the fee with nothing on screen to say so, so it is reported — the same
     * notices the Form 8949 report shows for the same book.
     */
    warnings: string[];
    summary: {
        totalCostBasis: number;
        totalMarketValue: number | null;
        totalRealizedGain: number;
        totalUnrealizedGain: number | null;
        openLotCount: number;
        closedLotCount: number;
        shortTermCount: number;
        longTermCount: number;
    };
    generatedAt: string;
}

const SHARE_EPSILON = 0.0001;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Calendar-day (YYYY-MM-DD) form of an ISO timestamp from the lot engine. */
function toDateOnly(iso: string | null): string | null {
    return iso ? iso.slice(0, 10) : null;
}

/**
 * Cost basis attributable to the shares still held, pro-rated over the lot's
 * purchased shares so a partially-sold lot doesn't count the sold shares'
 * basis twice. `lot.totalCost` already includes any `carried_basis` brought in
 * by an in-kind transfer, so a transferred lot prices against its real basis.
 *
 * This mirrors the allocation getLotsForAccounts uses for its own
 * `unrealizedGain`; the report re-applies it over engine-supplied figures only
 * because it must value holdings at the book's base currency, and the engine's
 * price lookup takes no currency argument.
 */
function remainingCostBasis(lot: LotSummary): number {
    const boughtShares = lot.splits
        .filter(s => s.shares > 0)
        .reduce((sum, s) => sum + s.shares, 0);
    return boughtShares > SHARE_EPSILON
        ? lot.totalCost * (lot.totalShares / boughtShares)
        : lot.totalCost;
}

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const showClosed = searchParams.get('showClosed') === 'true';
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const bookAccountGuids = await getBookAccountGuids();

        // Find all investment accounts (STOCK, MUTUAL) in the active book.
        // Lots, their splits and their metadata slots are loaded by the lot
        // engine below — this query only needs the account's own attributes.
        const investmentAccounts = await prisma.accounts.findMany({
            where: {
                guid: { in: bookAccountGuids },
                account_type: { in: ['STOCK', 'MUTUAL'] },
            },
            include: {
                commodity: true,
            },
        });

        const accountPathMap = await buildAccountPathMap(bookAccountGuids);
        // Price lookups are filtered to the base/report currency so a newer
        // quote in another currency is never used for unrealized gains.
        const baseCurrency = await getBaseCurrency();
        // Every shares/basis/realized/holding-period figure below comes from
        // this one canonical engine, which is the only place that knows about
        // carried basis, transferred acquisition dates and gains-offset splits.
        //
        // includeTradeFees makes basis and proceeds NET of brokerage
        // commissions, the same treatment Form 8949 applies (@/lib/trade-fees:
        // a classified trade fee is always capitalized, never deducted). It is
        // what keeps this report and the capital-gains report from reporting
        // two different gains for one sale. The account-path map is the one
        // already built above — fee classification reads the full path, and the
        // 8949 path classifies against the same map over the same book scope.
        const feeWarnings: string[] = [];
        const lotsByAccount = await getLotsForAccounts(investmentAccounts.map(a => a.guid), {
            includeTradeFees: true,
            accountPaths: accountPathMap,
            feeWarnings,
        });
        const now = new Date();
        const nowIso = now.toISOString();
        const rows: LotReportRow[] = [];

        for (const account of investmentAccounts) {
            const accountName = accountPathMap.get(account.guid) || account.name;
            const commodityMnemonic = account.commodity?.mnemonic || '';
            const commodityGuid = account.commodity_guid;

            // Get current price for unrealized gain calculation.
            // getLatestPrice DROPS its currency filter when the argument is
            // undefined, so an unknown base currency must skip the lookup
            // outright rather than accept a quote denominated in anything. The
            // lot then reports a null market value, which is honest; a number
            // derived from an arbitrary-currency quote would not be.
            let currentPrice: number | null = null;
            if (commodityGuid && baseCurrency) {
                try {
                    const priceData = await getLatestPrice(commodityGuid, baseCurrency.guid);
                    if (priceData) currentPrice = priceData.value;
                } catch {
                    // No price available
                }
            }

            for (const lot of lotsByAccount.get(account.guid) ?? []) {
                if (lot.splits.length === 0) continue;
                const { isClosed, totalShares } = lot;
                if (!showClosed && isClosed) continue;

                const openDate = toDateOnly(lot.openDate);
                const closeDate = toDateOnly(lot.closeDate);
                const acquisitionDate = toDateOnly(lot.acquisitionDate);

                // Value the remaining shares against the base-currency price.
                const marketValue = !isClosed && currentPrice !== null
                    ? currentPrice * totalShares
                    : null;
                const unrealizedGain = marketValue !== null && Math.abs(totalShares) > SHARE_EPSILON
                    ? marketValue - remainingCostBasis(lot)
                    : null;

                // Holding period runs from the ORIGINAL acquisition date when a
                // transfer carried one, not from the date this account received
                // the shares; the engine already resolves that.
                const holdingPeriod = lot.holdingPeriod;
                const termStart = acquisitionDate ?? openDate;
                const daysHeld = termStart
                    ? Math.floor(
                        (new Date(`${closeDate ?? nowIso.slice(0, 10)}T00:00:00.000Z`).getTime()
                            - new Date(`${termStart}T00:00:00.000Z`).getTime()) / MS_PER_DAY,
                    )
                    : null;

                // Date filtering: skip lots opened after the end date,
                // or closed lots that closed before the start date
                if (endDate && openDate && openDate > endDate) continue;
                if (startDate && isClosed && closeDate && closeDate < startDate) continue;

                rows.push({
                    accountName,
                    accountGuid: account.guid,
                    commodityMnemonic,
                    lotTitle: lot.title,
                    lotGuid: lot.guid,
                    isClosed,
                    openDate,
                    acquisitionDate,
                    closeDate,
                    shares: totalShares,
                    costBasis: lot.totalCost,
                    marketValue,
                    realizedGain: lot.realizedGain,
                    unrealizedGain,
                    // A partially-sold open lot has BOTH a realized and an
                    // unrealized component; total gain is their sum. Open lots
                    // with no price have no knowable total.
                    totalGain: unrealizedGain !== null
                        ? lot.realizedGain + unrealizedGain
                        : (isClosed ? lot.realizedGain : null),
                    holdingPeriod,
                    daysHeld,
                });
            }
        }

        // Sort: open lots first, then by account name, then by open date
        rows.sort((a, b) => {
            if (a.isClosed !== b.isClosed) return a.isClosed ? 1 : -1;
            if (a.accountName !== b.accountName) return a.accountName.localeCompare(b.accountName);
            if (a.openDate && b.openDate) return a.openDate.localeCompare(b.openDate);
            return 0;
        });

        // Market-value and unrealized totals cover the OPEN lots only. An
        // unpriced open lot has no knowable market value, and summing it as 0
        // would present an incomplete total as though it were complete — the
        // same class of error as pricing it off an arbitrary-currency quote.
        // If any open lot is unpriced, the whole aggregate reports null.
        const openRows = rows.filter(r => !r.isClosed);
        const everyOpenRowPriced = openRows.length > 0
            && openRows.every(r => r.marketValue !== null);
        const everyOpenGainKnown = openRows.length > 0
            && openRows.every(r => r.unrealizedGain !== null);

        const summary = {
            totalCostBasis: openRows.reduce((s, r) => s + r.costBasis, 0),
            totalMarketValue: everyOpenRowPriced
                ? openRows.reduce((s, r) => s + (r.marketValue ?? 0), 0)
                : null,
            // Includes the realized portion of partially-sold OPEN lots, which
            // the engine reports and which a closed-only filter would drop.
            totalRealizedGain: rows.reduce((s, r) => s + r.realizedGain, 0),
            totalUnrealizedGain: everyOpenGainKnown
                ? openRows.reduce((s, r) => s + (r.unrealizedGain ?? 0), 0)
                : null,
            openLotCount: openRows.length,
            closedLotCount: rows.filter(r => r.isClosed).length,
            shortTermCount: rows.filter(r => r.holdingPeriod === 'short_term').length,
            longTermCount: rows.filter(r => r.holdingPeriod === 'long_term').length,
        };

        const reportData: InvestmentLotsReportData = {
            rows,
            warnings: feeWarnings,
            summary,
            generatedAt: new Date().toISOString(),
        };

        return NextResponse.json(reportData);
    } catch (error) {
        console.error('Error generating investment lots report:', error);
        return NextResponse.json(
            { error: 'Failed to generate investment lots report' },
            { status: 500 }
        );
    }
}
