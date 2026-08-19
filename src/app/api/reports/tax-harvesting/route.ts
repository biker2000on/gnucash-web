import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getLotsForAccounts } from '@/lib/lots';
import { buildAccountPathMap } from '@/lib/reports/utils';
import { detectWashSales, WashSaleResult } from '@/lib/lot-assignment';
import { getRetirementAccountGuids } from '@/lib/reports/contribution-classifier';
import { DEFAULT_QTY_EPSILON } from '@/lib/tolerances';

interface HarvestCandidate {
  accountGuid: string;
  accountName: string;
  ticker: string;
  lotGuid: string;
  lotTitle: string;
  shares: number;
  costBasis: number;
  marketValue: number;
  unrealizedLoss: number;
  holdingPeriod: 'short_term' | 'long_term' | null;
  projectedSavings: {
    shortTerm: number;
    longTerm: number;
  };
}

interface TaxHarvestingData {
  candidates: HarvestCandidate[];
  washSales: WashSaleResult[];
  taxRates: { shortTerm: number; longTerm: number };
  summary: {
    totalHarvestableLoss: number;
    totalProjectedSavingsShortTerm: number;
    totalProjectedSavingsLongTerm: number;
    washSaleCount: number;
    candidateCount: number;
  };
  /** Charges the fee allocator refused to capitalize — see @/lib/trade-fees. */
  warnings: string[];
  generatedAt: string;
}

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const shortTermRate = parseFloat(searchParams.get('shortTermRate') || '0.37');
    const longTermRate = parseFloat(searchParams.get('longTermRate') || '0.20');

    const bookAccountGuids = await getBookAccountGuids();

    const [investmentAccounts, retirementGuids] = await Promise.all([
      prisma.accounts.findMany({
        where: {
          guid: { in: bookAccountGuids },
          account_type: { in: ['STOCK', 'MUTUAL'] },
        },
        select: {
          guid: true,
          name: true,
          commodity_guid: true,
          commodity: { select: { mnemonic: true } },
        },
      }),
      getRetirementAccountGuids(bookAccountGuids),
    ]);

    const candidates: HarvestCandidate[] = [];

    // Losses inside tax-advantaged accounts are not deductible — never offer
    // them as harvest candidates. (Wash-sale detection below still spans ALL
    // accounts on purpose: an IRA repurchase can wash a taxable loss,
    // Rev. Rul. 2008-5.)
    const harvestableAccounts = investmentAccounts.filter(a => !retirementGuids.has(a.guid));

    // Cost basis and unrealized gain are NET of classified brokerage
    // commissions, the same treatment Form 8949 and the Investment Lots report
    // apply — a harvestable loss quoted gross of the commission that produced
    // it disagrees with the loss the 8949 will actually report. Batched so the
    // fee allocation runs once for the whole book rather than per account, and
    // classified against the full account paths (the allocator's bare-name
    // fallback can classify a charge differently than the 8949 path does).
    const feeWarnings: string[] = [];
    const lotsByAccount = await getLotsForAccounts(harvestableAccounts.map(a => a.guid), {
      includeTradeFees: true,
      accountPaths: await buildAccountPathMap(bookAccountGuids),
      feeWarnings,
    });

    for (const account of harvestableAccounts) {
      const lots = lotsByAccount.get(account.guid) ?? [];

      for (const lot of lots) {
        if (lot.isClosed || lot.unrealizedGain === null || lot.unrealizedGain >= 0) continue;
        if (Math.abs(lot.totalShares) < DEFAULT_QTY_EPSILON) continue;

        const marketValue = lot.currentPrice !== null
          ? lot.currentPrice * lot.totalShares
          : 0;
        const unrealizedLoss = lot.unrealizedGain;

        candidates.push({
          accountGuid: account.guid,
          accountName: account.name,
          ticker: account.commodity?.mnemonic || 'Unknown',
          lotGuid: lot.guid,
          lotTitle: lot.title,
          shares: lot.totalShares,
          costBasis: lot.totalCost,
          marketValue,
          unrealizedLoss,
          holdingPeriod: lot.holdingPeriod,
          projectedSavings: {
            shortTerm: Math.abs(unrealizedLoss) * shortTermRate,
            longTerm: Math.abs(unrealizedLoss) * longTermRate,
          },
        });
      }
    }

    candidates.sort((a, b) => a.unrealizedLoss - b.unrealizedLoss);

    const washSales = await detectWashSales(bookAccountGuids);

    const totalHarvestableLoss = candidates.reduce((sum, c) => sum + c.unrealizedLoss, 0);

    const data: TaxHarvestingData = {
      candidates,
      washSales,
      taxRates: { shortTerm: shortTermRate, longTerm: longTermRate },
      summary: {
        totalHarvestableLoss,
        totalProjectedSavingsShortTerm: Math.abs(totalHarvestableLoss) * shortTermRate,
        totalProjectedSavingsLongTerm: Math.abs(totalHarvestableLoss) * longTermRate,
        washSaleCount: washSales.length,
        candidateCount: candidates.length,
      },
      warnings: feeWarnings,
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error generating tax harvesting report:', error);
    return NextResponse.json(
      { error: 'Failed to generate tax harvesting report' },
      { status: 500 }
    );
  }
}
