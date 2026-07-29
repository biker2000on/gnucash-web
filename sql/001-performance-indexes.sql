-- Performance Indexes for GnuCash Web
--
-- These indexes optimize the most common query patterns across the application.
-- They are safe to run on an existing database - all use IF NOT EXISTS / CONCURRENTLY.
--
-- Run manually:  psql -f sql/001-performance-indexes.sql
-- Auto-applied:  Indexes are also created on app startup via db-init.ts
--
-- Background: The GnuCash schema ships with only primary key indexes.
-- Without these, the prices table alone accumulates hundreds of millions
-- of sequential tuple reads as every currency/price lookup does a full scan.

-- Ensure the query planner has accurate table statistics
ANALYZE;

-- ============================================================================
-- PRICES TABLE (Critical - eliminates full table scans on every price lookup)
-- ============================================================================

-- Exchange rate lookups: WHERE commodity_guid = ? AND currency_guid = ? AND date <= ?
-- Used by: currency.ts (findExchangeRate), net-worth, KPIs, investment valuations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prices_commodity_currency_date
  ON prices (commodity_guid, currency_guid, date DESC);

-- Single-commodity price lookups: WHERE commodity_guid = ? AND date <= ?
-- Used by: commodities.ts, yahoo-price-service.ts, investment history
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prices_commodity_date
  ON prices (commodity_guid, date DESC);

-- ============================================================================
-- ACCOUNTS TABLE (High - recursive CTE performance for account hierarchies)
-- ============================================================================

-- Recursive CTEs: JOIN accounts a ON a.parent_guid = t.guid
-- Used by: book-scope.ts (getBookAccountGuids), account hierarchy view, asset routes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_parent_guid
  ON accounts (parent_guid);

-- Account type filtering: WHERE account_type IN ('ASSET', 'LIABILITY', ...)
-- Used by: dashboard APIs, reports, equity statement, balance sheet
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_account_type
  ON accounts (account_type);

-- Foreign key to commodities (missing FK index flagged by introspection)
-- Used by: investment filtering (commodity.namespace != 'CURRENCY')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_commodity_guid
  ON accounts (commodity_guid);

-- ============================================================================
-- TRANSACTIONS TABLE (Medium - search and sort optimization)
-- ============================================================================

-- Dual-column sort: ORDER BY post_date DESC, enter_date DESC
-- Used by: account ledger, transaction list (both paginated)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_post_date_enter
  ON transactions (post_date DESC, enter_date DESC);

-- NOTE: idx_transactions_description (varchar_pattern_ops) was removed.
-- The app searches with ILIKE '%...%', which a pattern_ops prefix index can
-- never serve; live-DB stats showed 0 scans. db-init drops it if present.

-- Currency filtering: WHERE currency_guid = ?
-- Used by: multi-currency report queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_currency_guid
  ON transactions (currency_guid);

-- Covering index for the ubiquitous splits -> transactions join that only
-- needs the post_date filter (report aggregates, balance queries):
--   JOIN transactions t ON t.guid = s.tx_guid WHERE t.post_date <= ?
-- INCLUDE (post_date) enables index-only scans on the join side.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_guid_postdate
  ON transactions (guid) INCLUDE (post_date);

-- ============================================================================
-- SPLITS TABLE (Low - refinements to existing indexes)
-- ============================================================================

-- Reconciliation workflow: WHERE account_guid = ? AND reconcile_state = ?
-- Used by: reconciliation report, bulk reconcile API
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_splits_account_reconcile
  ON splits (account_guid, reconcile_state);

-- Lot-linked splits: WHERE lot_guid = ? / lot_guid IS NOT NULL
-- Used by: invoice views, cost-basis tracing, payment allocation
-- Partial: most splits carry no lot, so the index stays tiny
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_splits_lot_guid
  ON splits (lot_guid) WHERE lot_guid IS NOT NULL;

-- ============================================================================
-- LOTS TABLE (Medium - per-account lot listing)
-- ============================================================================

-- Per-account lot lookups: WHERE account_guid = ?
-- Used by: lot engine (lots.ts, lot-assignment.ts), invoice posting
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lots_account_guid
  ON lots (account_guid);

-- ============================================================================
-- SLOTS TABLE (Medium - name-only metadata lookups)
-- ============================================================================

-- Name-first lookups: WHERE name = ? (obj_guid unknown/joined afterwards)
-- Used by: forecast-data.ts, equity-comp history/tag scans
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slots_name_obj
  ON slots (name, obj_guid);

-- Re-analyze after index creation so planner uses the new indexes
ANALYZE;
