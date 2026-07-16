import { makePersonalCommitRoute } from '@/lib/import/personal-route';

/** POST /api/import-export/mint/commit — import a mint CSV into the active book. */
export const POST = makePersonalCommitRoute('mint');
