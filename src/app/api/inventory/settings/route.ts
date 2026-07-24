import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import ToolConfigService from '@/lib/services/tool-config.service';

/**
 * Book-scoped inventory settings, stored via ToolConfigService
 * (tool_type 'inventory_settings', config shape { enabledForHousehold }).
 * One row per (user, book); created on first PUT.
 */

const TOOL_TYPE = 'inventory_settings';

interface InventorySettings {
  enabledForHousehold: boolean;
}

function parseSettings(config: unknown): InventorySettings {
  const c = (config ?? {}) as Record<string, unknown>;
  return { enabledForHousehold: c.enabledForHousehold === true };
}

/**
 * GET /api/inventory/settings
 * Response: { enabledForHousehold: boolean } (defaults to false when unset)
 */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const configs = await ToolConfigService.listByUser(user.id, bookGuid, TOOL_TYPE);
    return NextResponse.json(parseSettings(configs[0]?.config));
  } catch (error) {
    console.error('Error loading inventory settings:', error);
    return NextResponse.json({ error: 'Failed to load inventory settings' }, { status: 500 });
  }
}

/**
 * PUT /api/inventory/settings
 * Body: { enabledForHousehold: boolean }
 * Response: { enabledForHousehold: boolean }
 */
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const body = await request.json().catch(() => null);
    if (!body || typeof body.enabledForHousehold !== 'boolean') {
      return NextResponse.json(
        { error: 'enabledForHousehold (boolean) is required' },
        { status: 400 },
      );
    }
    const config = { enabledForHousehold: body.enabledForHousehold };

    await ToolConfigService.upsertUserSingleton(user.id, bookGuid, {
      toolType: TOOL_TYPE,
      name: 'Inventory Settings',
      config,
    });
    return NextResponse.json(config);
  } catch (error) {
    console.error('Error saving inventory settings:', error);
    return NextResponse.json({ error: 'Failed to save inventory settings' }, { status: 500 });
  }
}
