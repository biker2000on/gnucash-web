/**
 * Commodity Metadata Service
 *
 * Fetches and caches industry/sector data from Yahoo Finance quoteSummary.
 * - For individual stocks: gets sector/industry from assetProfile
 * - For ETFs/funds: gets sector weightings from topHoldings
 *
 * Caches results in gnucash_web_commodity_metadata table with 7-day TTL.
 */

import YahooFinance from 'yahoo-finance2';
import { getQuotableCommodities } from './price-service';

/** Raw metadata fetched from Yahoo Finance */
interface YahooMetadata {
  sector: string | null;
  industry: string | null;
  sectorWeights: Record<string, number> | null;
  assetClass: string | null;
}

/** Cached metadata row from the database */
export interface CommodityMetadata {
  id: number;
  commodityGuid: string;
  mnemonic: string;
  sector: string | null;
  industry: string | null;
  sectorWeights: Record<string, number> | null;
  assetClass: string | null;
  lastUpdated: Date;
}

/** Sector exposure entry for portfolio aggregation */
export interface SectorExposure {
  sector: string;
  value: number;
  percent: number;
}

/** Holding input for sector exposure calculation */
export interface HoldingForSector {
  commodityGuid: string;
  marketValue: number;
}

const CACHE_TTL_DAYS = 7;

/**
 * Fetch commodity metadata from Yahoo Finance quoteSummary.
 * Returns sector/industry for stocks, sector weightings for ETFs/funds.
 * Returns null on any error (does not throw).
 */
export async function fetchCommodityMetadata(
  symbol: string
): Promise<YahooMetadata | null> {
  try {
    const yahooFinance = new YahooFinance();
    const summary = await yahooFinance.quoteSummary(symbol, {
      modules: ['assetProfile', 'topHoldings'],
    });

    let sector: string | null = null;
    let industry: string | null = null;
    let sectorWeights: Record<string, number> | null = null;
    let assetClass: string | null = null;

    // Individual stocks: assetProfile has sector/industry
    if (summary.assetProfile?.sector) {
      sector = summary.assetProfile.sector;
      industry = summary.assetProfile.industry ?? null;
      assetClass = 'stock';
    }

    // ETFs/mutual funds: topHoldings has sectorWeightings
    if (summary.topHoldings?.sectorWeightings) {
      const weights: Record<string, number> = {};
      for (const entry of summary.topHoldings.sectorWeightings) {
        // Each entry is an object like { realestate: 0.02 } or { technology: 0.28 }
        for (const [key, value] of Object.entries(entry)) {
          if (typeof value === 'number') {
            // Capitalize first letter for display
            const sectorName = key.charAt(0).toUpperCase() + key.slice(1);
            weights[sectorName] = Math.round(value * 10000) / 100; // Convert to percentage
          }
        }
      }
      if (Object.keys(weights).length > 0) {
        sectorWeights = weights;
        assetClass = assetClass ?? 'etf';
      }
    }

    // If we couldn't determine asset class from above
    if (!assetClass && (sector || sectorWeights)) {
      assetClass = 'stock';
    }

    return { sector, industry, sectorWeights, assetClass };
  } catch (error) {
    console.warn(`Failed to fetch metadata for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get cached metadata for a commodity from the database.
 * Returns null if not cached or if cache is expired.
 */
export async function getCachedMetadata(
  commodityGuid: string
): Promise<CommodityMetadata | null> {
  const { default: prisma } = await import('./prisma');

  const row = await prisma.gnucash_web_commodity_metadata.findUnique({
    where: { commodity_guid: commodityGuid },
  });

  if (!row) return null;

  return {
    id: row.id,
    commodityGuid: row.commodity_guid,
    mnemonic: row.mnemonic,
    sector: row.sector,
    industry: row.industry,
    sectorWeights: row.sector_weights as Record<string, number> | null,
    assetClass: row.asset_class,
    lastUpdated: row.last_updated,
  };
}

/**
 * Check if cached metadata is still fresh (within TTL).
 */
function isCacheFresh(lastUpdated: Date): boolean {
  const now = new Date();
  const diffMs = now.getTime() - lastUpdated.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays < CACHE_TTL_DAYS;
}

/**
 * Refresh metadata for a single commodity.
 * Fetches from Yahoo Finance and upserts to the database.
 * Returns the updated metadata, or null on failure.
 */
export async function refreshMetadata(
  commodityGuid: string,
  symbol: string
): Promise<CommodityMetadata | null> {
  const metadata = await fetchCommodityMetadata(symbol);
  if (!metadata) return null;

  const { default: prisma } = await import('./prisma');

  const row = await prisma.gnucash_web_commodity_metadata.upsert({
    where: { commodity_guid: commodityGuid },
    create: {
      commodity_guid: commodityGuid,
      mnemonic: symbol,
      sector: metadata.sector,
      industry: metadata.industry,
      sector_weights: metadata.sectorWeights ?? undefined,
      asset_class: metadata.assetClass,
      last_updated: new Date(),
    },
    update: {
      sector: metadata.sector,
      industry: metadata.industry,
      sector_weights: metadata.sectorWeights ?? undefined,
      asset_class: metadata.assetClass,
      last_updated: new Date(),
    },
  });

  return {
    id: row.id,
    commodityGuid: row.commodity_guid,
    mnemonic: row.mnemonic,
    sector: row.sector,
    industry: row.industry,
    sectorWeights: row.sector_weights as Record<string, number> | null,
    assetClass: row.asset_class,
    lastUpdated: row.last_updated,
  };
}

/**
 * Refresh metadata for all quotable commodities.
 * Skips commodities whose cache is still fresh.
 */
export async function refreshAllMetadata(): Promise<{
  refreshed: number;
  skipped: number;
  failed: number;
}> {
  const commodities = await getQuotableCommodities();
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  for (const commodity of commodities) {
    const cached = await getCachedMetadata(commodity.guid);
    if (cached && isCacheFresh(cached.lastUpdated)) {
      skipped++;
      continue;
    }

    const result = await refreshMetadata(commodity.guid, commodity.mnemonic);
    if (result) {
      refreshed++;
    } else {
      failed++;
    }
  }

  return { refreshed, skipped, failed };
}

/**
 * Aggregate sector exposure across holdings, weighted by market value.
 * - Individual stocks get 100% weight to their sector
 * - ETFs/funds distribute market value across sectors using sector_weights
 */
export async function getPortfolioSectorExposure(
  holdings: HoldingForSector[]
): Promise<SectorExposure[]> {
  const sectorTotals: Record<string, number> = {};
  let totalValue = 0;

  for (const holding of holdings) {
    const metadata = await getCachedMetadata(holding.commodityGuid);
    totalValue += holding.marketValue;

    if (metadata?.sectorWeights && Object.keys(metadata.sectorWeights).length > 0) {
      // ETF/fund: distribute market value across sectors
      for (const [sector, weightPercent] of Object.entries(metadata.sectorWeights)) {
        const sectorValue = holding.marketValue * (weightPercent / 100);
        sectorTotals[sector] = (sectorTotals[sector] ?? 0) + sectorValue;
      }
    } else if (metadata?.sector) {
      // Individual stock: 100% to its sector
      sectorTotals[metadata.sector] = (sectorTotals[metadata.sector] ?? 0) + holding.marketValue;
    } else {
      // Unknown sector
      sectorTotals['Unknown'] = (sectorTotals['Unknown'] ?? 0) + holding.marketValue;
    }
  }

  // Convert to array sorted by value descending
  const exposures: SectorExposure[] = Object.entries(sectorTotals)
    .map(([sector, value]) => ({
      sector,
      value: Math.round(value * 100) / 100,
      percent: totalValue > 0 ? Math.round((value / totalValue) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  return exposures;
}
