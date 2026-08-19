/**
 * Prisma Client Singleton with GnuCash Extensions
 *
 * This module provides a singleton Prisma client instance that:
 * 1. Handles Next.js Hot Module Replacement (HMR) correctly
 * 2. Adds computed decimal fields for GnuCash fraction-based numerics
 * 3. Uses Prisma 7's adapter pattern for database connectivity
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { toDecimal } from './gnucash';
import {
  assertAccountRowWriteAllowed,
  noteAccountRowInserted,
  withAccountLockScope,
  AccountRowWriteUnderNameLockError,
} from './account-lock-order';

// Re-export utility functions for convenience
export { toDecimal, fromDecimal, generateGuid } from './gnucash';

/**
 * Create the extended Prisma Client with computed decimal fields
 */
function createPrismaClient() {
  // Create PostgreSQL connection pool.
  // Prisma 7 uses the pg driver adapter, so this pool's `max` (not the
  // `connection_limit` URL param) governs Prisma's connection count.
  // Shares the DB_POOL_MAX env override with the raw pool in db.ts.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number.parseInt(process.env.DB_POOL_MAX ?? '', 10) || 20,
  });

  // pg emits 'error' on IDLE pooled clients. Without a listener Node turns a
  // Postgres restart into an uncaught exception that kills the server and every
  // in-flight request. Log and let pg replace the broken client.
  pool.on('error', (err) => {
    console.error('Postgres pool (prisma.ts) idle client error:', err);
  });

  // Create Prisma adapter
  const adapter = new PrismaPg(pool);

  const prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

  // Extend with computed decimal fields for splits, and with the account
  // name-lock row-write invariant (RULE 2 in src/lib/account-lock-order.ts).
  const extended = prisma.$extends({
    query: {
      accounts: {
        // Rows this transaction INSERTs are exempt from the invariant: their
        // guids are invisible to every other session until COMMIT, so no
        // other backend can hold or want a lock on them. Recording them here
        // rather than at the call sites is what makes the exemption exact —
        // the importers' `updateMany(createdGuids)` fix-up passes, and an
        // update of anything else does not.
        async create({ args, query }) {
          const result = await query(args);
          const guid = (args as { data?: { guid?: unknown } }).data?.guid;
          if (typeof guid === 'string') noteAccountRowInserted(guid);
          return result;
        },
        async createMany({ args, query }) {
          const result = await query(args);
          const data = (args as { data?: unknown }).data;
          for (const row of Array.isArray(data) ? data : [data]) {
            const guid = (row as { guid?: unknown })?.guid;
            if (typeof guid === 'string') noteAccountRowInserted(guid);
          }
          return result;
        },
        async update({ args, query }) {
          guardAccountRowWrite('update', (args as { where?: unknown }).where);
          return query(args);
        },
        async updateMany({ args, query }) {
          guardAccountRowWrite('updateMany', (args as { where?: unknown }).where);
          return query(args);
        },
        async upsert({ args, query }) {
          guardAccountRowWrite('upsert', (args as { where?: unknown }).where);
          return query(args);
        },
        async delete({ args, query }) {
          guardAccountRowWrite('delete', (args as { where?: unknown }).where);
          return query(args);
        },
        async deleteMany({ args, query }) {
          guardAccountRowWrite('deleteMany', (args as { where?: unknown }).where);
          return query(args);
        },
      },
    },
    result: {
      splits: {
        value_decimal: {
          needs: { value_num: true, value_denom: true },
          compute(split) {
            return toDecimal(split.value_num, split.value_denom);
          },
        },
        quantity_decimal: {
          needs: { quantity_num: true, quantity_denom: true },
          compute(split) {
            return toDecimal(split.quantity_num, split.quantity_denom);
          },
        },
      },
      prices: {
        value_decimal: {
          needs: { value_num: true, value_denom: true },
          compute(price) {
            return toDecimal(price.value_num, price.value_denom);
          },
        },
      },
      budget_amounts: {
        amount_decimal: {
          needs: { amount_num: true, amount_denom: true },
          compute(amount) {
            return toDecimal(amount.amount_num, amount.amount_denom);
          },
        },
      },
    },
  });

  return withTransactionLockScope(extended);
}

/**
 * How a RULE 2 violation is reported. Unlike the ordering check, this one
 * infers intent from a Prisma `where` clause, so a shape nobody anticipated
 * could in principle be a false positive — which is survivable in development
 * and not worth a 500 in production. `ACCOUNT_LOCK_ROW_WRITE_GUARD` overrides
 * either way ('throw' | 'warn' | 'off').
 */
function rowWriteGuardMode(): 'throw' | 'warn' | 'off' {
  const override = process.env.ACCOUNT_LOCK_ROW_WRITE_GUARD;
  if (override === 'throw' || override === 'warn' || override === 'off') return override;
  return process.env.NODE_ENV === 'production' ? 'warn' : 'throw';
}

function guardAccountRowWrite(operation: string, where: unknown): void {
  const mode = rowWriteGuardMode();
  if (mode === 'off') return;
  try {
    assertAccountRowWriteAllowed(operation, where);
  } catch (error) {
    if (mode === 'throw' || !(error instanceof AccountRowWriteUnderNameLockError)) throw error;
    console.error('[account-lock-order]', error.message);
  }
}

/**
 * Gives every interactive transaction its own account-lock scope.
 *
 * Done here, once, rather than at the ~12 sites that hold name locks: the
 * invariant is only worth having if it covers the transaction someone adds
 * next year without reading src/lib/account-lock-order.ts. A `get` trap is
 * used instead of assigning `$transaction` because the object `$extends`
 * returns is itself a Proxy and does not accept property writes.
 */
function withTransactionLockScope<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      const original = Reflect.get(target, property, target) as
        | ((...args: unknown[]) => Promise<unknown>)
        | undefined;
      if (typeof original !== 'function') return original;
      return (...args: unknown[]) =>
        withAccountLockScope(() => original.apply(target, args) as Promise<unknown>);
    },
  });
}

// Type for the extended Prisma Client
export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

// Global variable declaration for HMR
declare global {
   
  var prisma: ExtendedPrismaClient | undefined;
}

// Singleton pattern with HMR support
const prisma = globalThis.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma;
}

export default prisma;

// Also export the raw PrismaClient type for type references
export { PrismaClient };
