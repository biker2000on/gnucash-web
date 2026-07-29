import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  createDomainCommand,
  listDomainCommands,
  DomainCommandError,
  type DomainCommandType,
} from '@/lib/domain-commands';

const COMMAND_TYPES = new Set<DomainCommandType>([
  'scheduled.create',
  'scheduled.update',
  'reimbursement.approve',
  'reimbursement.reject',
  'close.prepare',
]);

export async function GET() {
  try {
    const auth = await requireRole('readonly');
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json({
      commands: await listDomainCommands({
        bookGuid: auth.bookGuid,
        userId: auth.user.id,
      }),
    });
  } catch (error) {
    console.error('Error listing domain commands:', error);
    return NextResponse.json({ error: 'Failed to list command history' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole('edit');
    if (auth instanceof NextResponse) return auth;
    const body = await request.json().catch(() => null) as {
      commandType?: unknown;
      input?: unknown;
    } | null;
    if (!body || typeof body.commandType !== 'string' || !COMMAND_TYPES.has(body.commandType as DomainCommandType)) {
      return NextResponse.json({ error: 'Unsupported command type' }, { status: 400 });
    }
    if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) {
      return NextResponse.json({ error: 'Command input must be an object' }, { status: 400 });
    }
    const command = await createDomainCommand({
      bookGuid: auth.bookGuid,
      userId: auth.user.id,
      commandType: body.commandType as DomainCommandType,
      commandInput: body.input as Record<string, unknown>,
    });
    return NextResponse.json({ command }, { status: 201 });
  } catch (error) {
    if (error instanceof DomainCommandError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'state' ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    console.error('Error previewing domain command:', error);
    return NextResponse.json({ error: 'Failed to preview command' }, { status: 500 });
  }
}
