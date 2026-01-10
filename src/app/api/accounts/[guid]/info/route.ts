import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { guid } = await params;

        const res = await query(
            `SELECT
                a.name,
                ah.fullname,
                ah.guid1, ah.guid2, ah.guid3, ah.guid4, ah.guid5, ah.guid6,
                ah.level1, ah.level2, ah.level3, ah.level4, ah.level5, ah.level6,
                ah.depth
            FROM accounts a
            LEFT JOIN account_hierarchy ah ON a.guid = ah.guid
            WHERE a.guid = $1`,
            [guid]
        );

        if (res.rows.length === 0) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        return NextResponse.json(res.rows[0]);
    } catch (error) {
        console.error('Error fetching account info:', error);
        return NextResponse.json({ error: 'Failed to fetch account info' }, { status: 500 });
    }
}
