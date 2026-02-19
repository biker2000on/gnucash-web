import { NextResponse } from 'next/server';
import { getApiDocs } from '@/lib/swagger';
import { requireRole } from '@/lib/auth';

export async function GET() {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const spec = getApiDocs();
    return NextResponse.json(spec);
}
