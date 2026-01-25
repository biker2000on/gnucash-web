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

// Re-export utility functions for convenience
export { toDecimal, fromDecimal, generateGuid } from './gnucash';

/**
 * Create the extended Prisma Client with computed decimal fields
 */
function createPrismaClient() {
  // Create PostgreSQL connection pool
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  // Create Prisma adapter
  const adapter = new PrismaPg(pool);

  const prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

  // Extend with computed decimal fields for splits
  return prisma.$extends({
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
}

// Type for the extended Prisma Client
export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

// Global variable declaration for HMR
declare global {
  // eslint-disable-next-line no-var
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
