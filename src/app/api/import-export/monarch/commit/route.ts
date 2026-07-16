import { makePersonalCommitRoute } from '@/lib/import/personal-route';

/** POST /api/import-export/monarch/commit — import a monarch CSV into the active book. */
export const POST = makePersonalCommitRoute('monarch');
