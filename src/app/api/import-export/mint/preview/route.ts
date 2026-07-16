import { makePersonalPreviewRoute } from '@/lib/import/personal-route';

/** POST /api/import-export/mint/preview — parse + plan a mint CSV import (no writes). */
export const POST = makePersonalPreviewRoute('mint');
