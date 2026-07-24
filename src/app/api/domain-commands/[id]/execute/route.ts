import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { executeDomainCommand, DomainCommandError } from '@/lib/domain-commands';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    const command = await executeDomainCommand({
      id,
      bookGuid: auth.bookGuid,
      userId: auth.user.id,
    });
    return NextResponse.json({ command });
  } catch (error) {
    if (error instanceof DomainCommandError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.code === 'not_found' ? 404 : 409 },
      );
    }
    console.error('Error executing domain command:', error);
    return NextResponse.json({ error: 'Failed to execute command' }, { status: 500 });
  }
}
