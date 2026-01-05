import { Pool, PoolConfig } from 'pg';

const poolConfig: PoolConfig = {
    // GnuCash DB connection details are handled by the MCP server, 
    // but for the app we need standard env vars.
    connectionString: process.env.DATABASE_URL,
};

const pool = new Pool(poolConfig);

export const query = (text: string, params?: any[]) => pool.query(text, params);

/**
 * Converts GnuCash split values (integer + denominator) to a decimal string.
 * @param num The numerator (bigint/number)
 * @param denom The denominator (bigint/number)
 * @returns A string representation of the decimal value.
 */
export function toDecimal(num: number | string | bigint, denom: number | string | bigint): string {
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
