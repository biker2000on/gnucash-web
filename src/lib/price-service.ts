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
  getQuotableCommodities,
  storeFetchedPrice,
  getExistingPriceDates,
} from './yahoo-price-service';

export type {
  PriceFetchResult,
  QuotableCommodity,
  FetchAndStoreResult,
} from './yahoo-price-service';
