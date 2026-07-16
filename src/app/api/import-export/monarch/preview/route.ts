import { makePersonalPreviewRoute } from '@/lib/import/personal-route';

/** POST /api/import-export/monarch/preview — parse + plan a monarch CSV import (no writes). */
export const POST = makePersonalPreviewRoute('monarch');
