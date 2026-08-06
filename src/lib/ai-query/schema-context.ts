// src/lib/ai-query/schema-context.ts

/**
 * Curated schema description injected into the SQL-generation prompt.
 *
 * Deliberately covers ONLY the relations the "Ask your books" feature is
 * allowed to touch. Keep the names in sync with BOOK_RELATIONS in
 * ./guardrails.ts, which defines them as CTEs already filtered to the active
 * book. The model never names a base table, so it never has to get scoping
 * right — and cannot get it wrong.
 */
export const SCHEMA_CONTEXT = `You can query a GnuCash PostgreSQL database. Available tables/views:

book_accounts
  guid          char(32)  primary key
  name          varchar   account name (single segment, e.g. 'Restaurants')
  account_type  varchar   one of: ASSET, BANK, CASH, CREDIT, LIABILITY, INCOME,
                          EXPENSE, EQUITY, STOCK, MUTUAL, RECEIVABLE, PAYABLE, TRADING, ROOT
  parent_guid   char(32)  parent account guid (NULL for root)
  hidden        integer   1 = hidden account
  placeholder   integer   1 = placeholder (no transactions posted directly)

book_account_hierarchy (view over accounts)
  guid, name, account_type, parent_guid, hidden, placeholder  same as book_accounts
  fullname      varchar   colon-separated full path, e.g. 'Expenses:Dining:Restaurants'
                          (does NOT include the invisible root account)

book_transactions
  guid           char(32)  primary key
  post_date      timestamp date the transaction was posted (compare with date literals,
                           e.g. post_date >= '2026-01-01' AND post_date < '2026-04-01')
  description    varchar   payee / description text
  currency_guid  char(32)  transaction currency commodity

book_splits (one row per leg of a transaction; a transaction has 2+ splits that sum to zero)
  guid            char(32)  primary key
  tx_guid         char(32)  references book_transactions.guid
  account_guid    char(32)  references book_accounts.guid
  value_num       bigint    amount numerator, in transaction currency
  value_denom     bigint    amount denominator
  quantity_num    bigint    quantity numerator, in the account's commodity (shares for STOCK/MUTUAL)
  quantity_denom  bigint    quantity denominator
  memo            varchar   split-level memo text
  reconcile_state char(1)   'n' = not reconciled, 'c' = cleared, 'y' = reconciled

CRITICAL CONVENTIONS:
1. Amounts are stored as fractions. ALWAYS compute money as
   SUM(s.value_num::numeric / s.value_denom) — never use value_num alone.
   For share quantities use s.quantity_num::numeric / s.quantity_denom.
2. Sign conventions (double-entry): money flowing INTO an account is a positive
   split value on that account. Therefore EXPENSE account splits are POSITIVE
   when money is spent, and INCOME account splits are NEGATIVE when income is
   earned (negate income sums for a human-friendly figure). Asset/bank balances
   are the plain sum of their split values. Liabilities usually carry negative sums.
3. Account scoping is already done for you. Every relation above is restricted
   to the user's active book before your query runs, so write plain queries and
   do NOT add any book/account-scope filter. Use ONLY the book_ names above:
   the underlying tables (accounts, splits, transactions, account_hierarchy) are
   not queryable and a statement naming one is rejected. Do not write query
   parameters ($1 and friends) and never invent guid literals.
4. To find accounts by name/category, match book_account_hierarchy.fullname with ILIKE,
   e.g. ah.fullname ILIKE '%restaurant%'. Include child accounts when the user asks
   about a category (fullname ILIKE 'Expenses:Dining%' style patterns, or match the
   segment anywhere in the path).
5. Exclude nothing by default: hidden and placeholder accounts still hold data;
   only filter them out if the user asks.`;
