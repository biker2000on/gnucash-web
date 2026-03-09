/**
 * Price Service Facade
 *
 * Re-exports all price service functionality from the Yahoo Finance provider.
 * This facade ensures consumers don't need to change their imports.
 */

export {
  fetchBatchQuotes,
  fetchAndStorePrices,
  fetchHistoricalPrices,
  getLastPriceDate,
  detectAndFillGaps,
  auditAndBackfillPrices,
  getQuotableCommodities,
  storeFetchedPrice,
  getExistingPriceDates,
} from './yahoo-price-service';

export type {
  PriceFetchResult,
  QuotableCommodity,
  FetchAndStoreResult,
  AuditPricesResult,
} from './yahoo-price-service';

export {
  ensureIndexCommodities,
  fetchIndexPrices,
  getIndexHistory,
  normalizeToPercent,
} from './market-index-service';

export type {
  IndexPriceData,
  IndexHistoryResult,
} from './market-index-service';
