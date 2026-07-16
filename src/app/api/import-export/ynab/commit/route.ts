import { makePersonalCommitRoute } from '@/lib/import/personal-route';

/** POST /api/import-export/ynab/commit — import a ynab CSV into the active book. */
export const POST = makePersonalCommitRoute('ynab');
