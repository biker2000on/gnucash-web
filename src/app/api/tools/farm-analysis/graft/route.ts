import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { addTemplateAccounts } from '@/lib/default-book';
import { getFarmAccountTemplate } from '@/lib/book-templates';
import { invalidateBookAccountGuidsCache } from '@/lib/book-scope';
import { afterLedgerWrite } from '@/lib/data-events';
import { isSiblingKeyAdopted, siblingKeyAdoptedResponse } from '@/lib/sibling-key-adopted-response';

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
    afterLedgerWrite(roleResult.bookGuid, 'accounts', { action: 'create' });
    return NextResponse.json(result);
  } catch (error) {
    // A concurrent creator won the key and the graft exhausted its retries.
    // Transient: the user should see "try again", not a server error.
    if (isSiblingKeyAdopted(error)) {
      return siblingKeyAdoptedResponse(error);
    }
    const message = error instanceof Error ? error.message : 'Failed to add farm accounts';
    const conflict = message.startsWith('Cannot add ');
    console.error('Error grafting farm account template:', error);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
