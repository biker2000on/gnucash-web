/**
 * GnuCash Utility Functions
 *
 * This module provides utility functions for working with GnuCash data:
 * - Fraction-to-decimal conversion
 * - Decimal-to-fraction conversion
 * - GUID generation
 */

/**
 * Decimal places kept when long-dividing a non-power-of-ten denominator.
 * Capped for display: these strings surface raw via the Prisma computed
 * `value_decimal`/`quantity_decimal` fields, so a non-terminating quotient
 * must not render as a 20-digit wall. 10 clears the stored precision --
 * quotes top out at PRICE_DENOM (1e8) and split denominators are all powers
 * of ten -- while keeping 1/3 readable.
 */
const ARBITRARY_DENOM_SCALE = 10;
const ARBITRARY_DENOM_POW = 10n ** BigInt(ARBITRARY_DENOM_SCALE);

/**
 * Returns p when d === 10^p, otherwise null.
 */
function powerOfTenExponent(d: bigint): number | null {
  let value = d;
  let exponent = 0;
  while (value % 10n === 0n) {
    value /= 10n;
    exponent++;
  }
  return value === 1n ? exponent : null;
}

/**
 * Converts GnuCash fraction values (numerator/denominator) to a decimal string.
 * Handles negative values and zero denominators safely.
 *
 * Power-of-ten denominators (the overwhelming majority: 100, 1000, 1e8, ...)
 * keep their full scale, so 150/100 stays "1.50". Any other denominator --
 * GCD-reduced price rows produce these -- is long-divided in BigInt at
 * ARBITRARY_DENOM_SCALE places and trimmed, so 1/8 is "0.125" rather than a
 * digit-count guess.
 *
 * @param num - The numerator (BigInt, number, or string)
 * @param denom - The denominator (BigInt, number, or string)
 * @returns A string representation of the decimal value
 *
 * @example
 * toDecimal(150n, 100n) // Returns "1.50"
 * toDecimal(-50n, 100n) // Returns "-0.50"
 * toDecimal(1n, 8n)     // Returns "0.125"
 */
export function toDecimal(num: bigint | number | string, denom: bigint | number | string): string {
  const n = BigInt(num);
  const rawD = BigInt(denom);

  if (rawD === 0n) return "0";

  const d = rawD < 0n ? -rawD : rawD;
  const absoluteN = n < 0n ? -n : n;

  if (absoluteN === 0n) return "0";

  const sign = (n < 0n) !== (rawD < 0n) ? "-" : "";
  const integerPart = absoluteN / d;
  const remainder = absoluteN % d;

  if (remainder === 0n) {
    return sign + integerPart.toString();
  }

  const exponent = powerOfTenExponent(d);
  if (exponent !== null) {
    return sign + integerPart.toString() + "." + remainder.toString().padStart(exponent, '0');
  }

  // Half-up rounding via integer arithmetic: floor((r * 10^s) / d + 1/2)
  const scaled = (remainder * ARBITRARY_DENOM_POW * 2n + d) / (d * 2n);
  if (scaled >= ARBITRARY_DENOM_POW) {
    return sign + (integerPart + 1n).toString();
  }

  const fraction = scaled.toString().padStart(ARBITRARY_DENOM_SCALE, '0').replace(/0+$/, '');
  if (fraction === '') {
    return sign + integerPart.toString();
  }

  return sign + integerPart.toString() + "." + fraction;
}

/** Largest value storable in the int64 `*_num` columns. */
export const MAX_INT64 = 9223372036854775807n;

/**
 * Converts GnuCash fraction values to a number (not a string).
 * Returns 0 for null inputs.
 *
 * @param num - The numerator (BigInt, number, string, or null)
 * @param denom - The denominator (BigInt, number, string, or null)
 * @returns A numeric representation of the decimal value
 *
 * @example
 * toDecimalNumber(150n, 100n) // Returns 1.5
 * toDecimalNumber(null, 100n) // Returns 0
 */
export function toDecimalNumber(
  num: bigint | number | string | null,
  denom: bigint | number | string | null
): number {
  if (num === null || denom === null) return 0;
  return parseFloat(toDecimal(num, denom));
}

/**
 * Converts a decimal number to GnuCash fraction format.
 *
 * @param value - The decimal value to convert
 * @param denom - The denominator to use (default: 100 for currency)
 * @returns An object with num and denom as BigInt
 *
 * @example
 * fromDecimal(1.50) // Returns { num: 150n, denom: 100n }
 * fromDecimal(1.2345, 10000) // Returns { num: 12345n, denom: 10000n }
 */
export function fromDecimal(value: number, denom: number = 100): { num: bigint; denom: bigint } {
  return {
    num: BigInt(Math.round(value * denom)),
    denom: BigInt(denom)
  };
}

/**
 * Generate a GnuCash-compatible GUID (32-character lowercase hex string)
 *
 * @returns A 32-character lowercase hexadecimal string
 *
 * @example
 * generateGuid() // Returns something like "a1b2c3d4e5f6789012345678abcdef00"
 */
export function generateGuid(): string {
  // Use crypto API if available
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  // Fallback for environments without crypto
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

/**
 * Convert a BigInt value to a regular number for JSON serialization.
 * Use carefully - may lose precision for very large values.
 */
export function bigIntToNumber(value: bigint): number {
  return Number(value);
}

/**
 * Serialize an object containing BigInt values to JSON-safe format
 */
export function serializeBigInts<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'bigint') {
    return obj.toString() as unknown as T;
  }

  // Preserve Date objects as ISO strings for proper JSON serialization
  if (obj instanceof Date) {
    return obj.toISOString() as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(serializeBigInts) as unknown as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeBigInts(value);
    }
    return result as T;
  }

  return obj;
}

import prisma from './prisma';
import { accountNameLockKey, acquireNamedXactLock } from './book-lock';

/**
 * Find or create a GnuCash account by colon-delimited path.
 * Creates missing intermediate accounts as placeholders.
 */
export async function findOrCreateAccount(
  path: string,
  bookRootGuid: string,
  currencyGuid: string,
  tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<string> {
  const db = tx || prisma;
  const segments = path.split(':');
  let parentGuid = bookRootGuid;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    let existing = await db.accounts.findFirst({
      where: { name: segment, parent_guid: parentGuid },
      select: { guid: true },
    });

    if (!existing) {
      // Guard the check-then-create: take a per-(parent, name) advisory
      // lock and re-check, so concurrent callers reach the create one at a
      // time instead of both inserting a duplicate sibling. This lock is the
      // ONLY serializer — there is deliberately no unique index on
      // accounts(parent_guid, name), because scheduled-transaction template
      // children share (parent, '') by design (see db-init.ts,
      // ACCOUNTS_SIBLING_NAME_INDEX).
      // Only effective inside a transaction (pass `tx`); test doubles
      // without $queryRaw skip the lock and keep legacy behavior.
      const locked = await acquireNamedXactLock(db, accountNameLockKey(parentGuid, segment));
      if (locked) {
        existing = await db.accounts.findFirst({
          where: { name: segment, parent_guid: parentGuid },
          select: { guid: true },
        });
      }
    }

    if (existing) {
      parentGuid = existing.guid;
      continue;
    }

    const newGuid = generateGuid();
    await db.accounts.create({
      data: {
        guid: newGuid,
        name: segment,
        account_type: 'INCOME',
        commodity_guid: currencyGuid,
        commodity_scu: 100,
        parent_guid: parentGuid,
        non_std_scu: 0,
        hidden: 0,
        placeholder: isLast ? 0 : 1,
        code: '',
        description: '',
      },
    });
    parentGuid = newGuid;
  }

  return parentGuid;
}
