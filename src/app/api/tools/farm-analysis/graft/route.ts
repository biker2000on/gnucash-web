import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { addTemplateAccounts } from '@/lib/default-book';
import { getFarmAccountTemplate } from '@/lib/book-templates';
import { invalidateBookAccountGuidsCache } from '@/lib/book-scope';

/** Add the Schedule F chart to the active book without changing existing rows. */
export async function POST() {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const result = await addTemplateAccounts(
      roleResult.bookGuid,
      getFarmAccountTemplate(),
    );
    invalidateBookAccountGuidsCache();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add farm accounts';
    const conflict = message.startsWith('Cannot add ');
    console.error('Error grafting farm account template:', error);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
