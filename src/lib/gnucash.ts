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
import { isTopLevelPrismaClient } from './book-lock';
import { acquireAccountNameLock } from './account-lock-order';

type PrismaTxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Find or create a GnuCash account by colon-delimited path.
 * Creates missing intermediate accounts as placeholders.
 *
 * The per-(parent, name) serializer is a TRANSACTION-scoped advisory lock, so
 * this opens its own transaction whenever it was not handed one (no `tx`, or a
 * top-level client such as the `prisma` singleton — the email bill-capture path
 * passes neither). Running the lock in autocommit would release it before the
 * re-check, which is a no-op dressed up as a guard; `acquireNamedXactLock`
 * now rejects that outright, so the wrapper here is what keeps those callers
 * working AND locked.
 */
export async function findOrCreateAccount(
  path: string,
  bookRootGuid: string,
  currencyGuid: string,
  tx?: PrismaTxClient,
  order?: LockOrderBase,
): Promise<string> {
  const { guid } = await findOrCreateAccountDetailed(path, bookRootGuid, currencyGuid, tx, order);
  return guid;
}

/** What {@link findOrCreateAccountDetailed} resolved, and what it inserted. */
export interface FindOrCreateAccountResult {
  /** The leaf account at `path`. */
  guid: string;
  /**
   * The accounts this call INSERTED, root-to-leaf. Excludes both segments that
   * already existed and segments ADOPTED under the name lock — rows a
   * concurrent transaction committed inside the check-then-create window.
   *
   * Callers that post-process the new segments (setting a real account type,
   * say) must restrict themselves to these guids. An adopted row belongs to
   * another transaction, and locking it here would mean taking a ROW lock
   * while this walk still holds the sibling-name locks of every segment it
   * created — the reverse of `AccountService.update`'s order, and a deadlock.
   * See `SiblingKeyAdoptedError` in src/lib/book-lock.ts.
   */
  createdGuids: string[];
}

/**
 * {@link findOrCreateAccount}, additionally reporting which segments it
 * inserted. Same locking, same transaction handling.
 */
export async function findOrCreateAccountDetailed(
  path: string,
  bookRootGuid: string,
  currencyGuid: string,
  tx?: PrismaTxClient,
  order?: LockOrderBase,
): Promise<FindOrCreateAccountResult> {
  const client = (tx ?? prisma) as PrismaTxClient;
  if (isTopLevelPrismaClient(client)) {
    return (client as unknown as typeof prisma).$transaction(inner =>
      findOrCreateAccountWithin(inner, path, bookRootGuid, currencyGuid, order),
    );
  }
  return findOrCreateAccountWithin(client, path, bookRootGuid, currencyGuid, order);
}

/**
 * Where a walk that starts BELOW the book root sits in the canonical
 * acquisition order (src/lib/account-lock-order.ts).
 *
 * `bookRootGuid` here is only an anchor for the walk, not necessarily the book
 * root: the QIF importer walks paths under a user-chosen parent. The order,
 * though, has to be expressed against the real book root, or two holders
 * approaching the same key from different anchors sort it differently and the
 * shared order stops being shared. Callers that walk from somewhere other than
 * the root pass the real root here, plus the path prefix that leads to their
 * anchor.
 */
export interface LockOrderBase {
  bookRootGuid: string;
  prefix: readonly string[];
  /**
   * Id of a site in `UNORDERED_CLAIM_SITES` (src/lib/account-lock-order.ts)
   * that is known to claim siblings out of order. Downgrades the ordering
   * violation from a throw to a logged error. Never set this for new code.
   */
  unorderedSite?: string;
}

/** The path walk itself, always running inside a transaction in production. */
async function findOrCreateAccountWithin(
  db: PrismaTxClient,
  path: string,
  bookRootGuid: string,
  currencyGuid: string,
  order: LockOrderBase = { bookRootGuid, prefix: [] },
): Promise<FindOrCreateAccountResult> {
  const segments = path.split(':');
  const createdGuids: string[] = [];
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
      // `db` is always transactional here (see findOrCreateAccount); only
      // in-memory test doubles without $queryRaw skip the lock, and they say
      // so by returning false rather than pretending to have locked.
      //
      // The walk descends, so the segments it claims are already in canonical
      // order: `bookRootGuid` plus a strictly growing prefix of `segments` is
      // increasing at every step (src/lib/account-lock-order.ts). Passing that
      // prefix as the order is not bookkeeping — it is what lets a caller
      // holding OTHER account keys be checked against this walk.
      const locked = await acquireAccountNameLock(
        db,
        parentGuid,
        segment,
        {
          bookRootGuid: order.bookRootGuid,
          path: [...order.prefix, ...segments.slice(0, i + 1)],
        },
        order.unorderedSite,
      );
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
    createdGuids.push(newGuid);
    parentGuid = newGuid;
  }

  return { guid: parentGuid, createdGuids };
}
