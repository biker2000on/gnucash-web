// src/lib/ai-query/schema-context.ts

/**
 * Curated schema description injected into the SQL-generation prompt.
 *
 * Deliberately covers ONLY the tables the "Ask your books" feature is allowed
 * to touch. Keep this in sync with the guardrails in ./guardrails.ts (which
 * require the $1 account-scope parameter whenever these tables are referenced).
 */
export const SCHEMA_CONTEXT = `You can query a GnuCash PostgreSQL database. Available tables/views:

accounts
  guid          char(32)  primary key
  name          varchar   account name (single segment, e.g. 'Restaurants')
  account_type  varchar   one of: ASSET, BANK, CASH, CREDIT, LIABILITY, INCOME,
                          EXPENSE, EQUITY, STOCK, MUTUAL, RECEIVABLE, PAYABLE, TRADING, ROOT
  parent_guid   char(32)  parent account guid (NULL for root)
  hidden        integer   1 = hidden account
  placeholder   integer   1 = placeholder (no transactions posted directly)

account_hierarchy (view over accounts)
  guid, name, account_type, parent_guid, hidden, placeholder  same as accounts
  fullname      varchar   colon-separated full path, e.g. 'Expenses:Dining:Restaurants'
                          (does NOT include the invisible root account)

transactions
  guid           char(32)  primary key
  post_date      timestamp date the transaction was posted (compare with date literals,
                           e.g. post_date >= '2026-01-01' AND post_date < '2026-04-01')
  description    varchar   payee / description text
  currency_guid  char(32)  transaction currency commodity

splits (one row per leg of a transaction; a transaction has 2+ splits that sum to zero)
  guid            char(32)  primary key
  tx_guid         char(32)  references transactions.guid
  account_guid    char(32)  references accounts.guid
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
3. Account scoping: the application passes the array of account guids belonging
   to the user's active book as the ONLY query parameter, $1. ALL filtering of
   accounts MUST go through it: every query that references accounts, splits, or
   transactions must constrain account rows with guid = ANY($1) and/or split rows
   with account_guid = ANY($1). Never invent guid literals.
4. To find accounts by name/category, match account_hierarchy.fullname with ILIKE,
   e.g. ah.fullname ILIKE '%restaurant%'. Include child accounts when the user asks
   about a category (fullname ILIKE 'Expenses:Dining%' style patterns, or match the
   segment anywhere in the path).
5. Exclude nothing by default: hidden and placeholder accounts still hold data;
   only filter them out if the user asks.`;
