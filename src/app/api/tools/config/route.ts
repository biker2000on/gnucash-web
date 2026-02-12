import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { ToolConfigService, CreateToolConfigSchema } from '@/lib/services/tool-config.service';

/**
 * GET /api/tools/config
 * List all tool configurations for the current user in the active book
 * Optional query param: ?toolType=mortgage to filter by tool type
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const bookGuid = await getActiveBookGuid();
    const { searchParams } = new URL(request.url);
    const toolType = searchParams.get('toolType') || undefined;

    const configs = await ToolConfigService.listByUser(user.id, bookGuid, toolType);
    return NextResponse.json(configs);
  } catch (error) {
    console.error('Error listing tool configurations:', error);
    return NextResponse.json(
      { error: 'Failed to list tool configurations' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tools/config
 * Create a new tool configuration
 * Body: { toolType: string, name: string, accountGuid?: string, config?: object }
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const bookGuid = await getActiveBookGuid();
    const body = await request.json();

    // Validate with Zod
    const validated = CreateToolConfigSchema.parse(body);

    const config = await ToolConfigService.create(user.id, bookGuid, validated);
    return NextResponse.json(config, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create tool configuration';
    console.error('Error creating tool configuration:', error);

    // Zod validation errors return 400
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
