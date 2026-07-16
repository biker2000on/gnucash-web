import { makePersonalPreviewRoute } from '@/lib/import/personal-route';

/** POST /api/import-export/ynab/preview — parse + plan a ynab CSV import (no writes). */
export const POST = makePersonalPreviewRoute('ynab');
