/**
 * GnuCash Utility Functions
 *
 * This module provides utility functions for working with GnuCash data:
 * - Fraction-to-decimal conversion
 * - Decimal-to-fraction conversion
 * - GUID generation
 */

/**
 * Converts GnuCash fraction values (numerator/denominator) to a decimal string.
 * Handles negative values and zero denominators safely.
 *
 * @param num - The numerator (BigInt, number, or string)
 * @param denom - The denominator (BigInt, number, or string)
 * @returns A string representation of the decimal value
 *
 * @example
 * toDecimal(150n, 100n) // Returns "1.50"
 * toDecimal(-50n, 100n) // Returns "-0.50"
 */
export function toDecimal(num: bigint | number | string, denom: bigint | number | string): string {
  const n = BigInt(num);
  const d = BigInt(denom);

  if (d === 0n) return "0";

  const isNegative = n < 0n;
  const absoluteN = isNegative ? -n : n;

  const integerPart = absoluteN / d;
  const remainder = absoluteN % d;

  if (remainder === 0n) {
    return (isNegative ? "-" : "") + integerPart.toString();
  }

  // Pad the remainder to match the scale of the denominator
  // GnuCash denominators are usually powers of 10 (e.g., 100, 1000)
  let fractionStr = remainder.toString();
  const precision = d.toString().length - 1;
  fractionStr = fractionStr.padStart(precision, '0');

  return (isNegative ? "-" : "") + integerPart.toString() + "." + fractionStr;
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
