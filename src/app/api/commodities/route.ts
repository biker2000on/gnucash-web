import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

/**
 * @openapi
 * /api/commodities:
 *   get:
 *     description: Returns a list of commodities (currencies, stocks, etc.).
 *     parameters:
 *       - name: type
 *         in: query
 *         description: Filter by namespace (CURRENCY, STOCK, etc.)
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A list of commodities.
 */
export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const type = searchParams.get('type');

        let commodityQuery = `
            SELECT guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz
            FROM commodities
        `;
        const params: string[] = [];

        if (type) {
            commodityQuery += ' WHERE namespace = $1';
            params.push(type);
        }

        commodityQuery += ' ORDER BY namespace, mnemonic';

        const { rows } = await query(commodityQuery, params);
        return NextResponse.json(rows);
    } catch (error) {
        console.error('Error fetching commodities:', error);
        return NextResponse.json({ error: 'Failed to fetch commodities' }, { status: 500 });
    }
}
