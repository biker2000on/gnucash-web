import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

/**
 * @openapi
 * /api/splits/bulk/move:
 *   post:
 *     description: Bulk move splits from one account to another.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - splitGuids
 *               - targetAccountGuid
 *             properties:
 *               splitGuids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of split GUIDs to move
 *               targetAccountGuid:
 *                 type: string
 *                 description: Target account GUID to move splits to
 *     responses:
 *       200:
 *         description: Splits moved successfully.
 *       400:
 *         description: Invalid request or currency mismatch.
 *       404:
 *         description: Target account or splits not found.
 *       500:
 *         description: Server error.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const { splitGuids, targetAccountGuid } = body;

        // Validation
        if (!splitGuids || !Array.isArray(splitGuids) || splitGuids.length === 0) {
            return NextResponse.json(
                { error: 'splitGuids array is required' },
                { status: 400 }
            );
        }
        if (!targetAccountGuid || typeof targetAccountGuid !== 'string') {
            return NextResponse.json(
                { error: 'targetAccountGuid is required' },
                { status: 400 }
            );
        }

        // Verify target account exists
        const targetAccount = await prisma.accounts.findUnique({
            where: { guid: targetAccountGuid },
            select: { guid: true, commodity_guid: true },
        });
        if (!targetAccount) {
            return NextResponse.json(
                { error: 'Target account not found' },
                { status: 404 }
            );
        }

        // Verify all splits exist and have the same commodity_guid as target
        const splits = await prisma.splits.findMany({
            where: { guid: { in: splitGuids } },
            include: { account: { select: { commodity_guid: true } } },
        });

        if (splits.length !== splitGuids.length) {
            return NextResponse.json(
                { error: 'Some splits not found' },
                { status: 404 }
            );
        }

        const incompatible = splits.filter(
            s => s.account?.commodity_guid !== targetAccount.commodity_guid
        );
        if (incompatible.length > 0) {
            return NextResponse.json(
                { error: 'Cannot move splits across different currencies' },
                { status: 400 }
            );
        }

        // Perform the bulk update
        const result = await prisma.splits.updateMany({
            where: { guid: { in: splitGuids } },
            data: { account_guid: targetAccountGuid },
        });

        return NextResponse.json({
            success: true,
            updated: result.count,
        });
    } catch (error) {
        console.error('Failed to bulk move splits:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
