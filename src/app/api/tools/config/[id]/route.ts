import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { ToolConfigService, UpdateToolConfigSchema } from '@/lib/services/tool-config.service';

/**
 * GET /api/tools/config/[id]
 * Get a single tool configuration by ID
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const bookGuid = await getActiveBookGuid();
    const { id } = await params;
    const configId = parseInt(id, 10);

    if (isNaN(configId)) {
      return NextResponse.json({ error: 'Invalid configuration ID' }, { status: 400 });
    }

    const config = await ToolConfigService.getById(configId, user.id, bookGuid);
    if (!config) {
      return NextResponse.json({ error: 'Configuration not found' }, { status: 404 });
    }

    return NextResponse.json(config);
  } catch (error) {
    console.error('Error fetching tool configuration:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tool configuration' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/tools/config/[id]
 * Update an existing tool configuration
 * Body: { name?: string, accountGuid?: string, config?: object }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const bookGuid = await getActiveBookGuid();
    const { id } = await params;
    const configId = parseInt(id, 10);

    if (isNaN(configId)) {
      return NextResponse.json({ error: 'Invalid configuration ID' }, { status: 400 });
    }

    const body = await request.json();

    // Validate with Zod
    const validated = UpdateToolConfigSchema.parse(body);

    const config = await ToolConfigService.update(configId, user.id, bookGuid, validated);
    if (!config) {
      return NextResponse.json({ error: 'Configuration not found' }, { status: 404 });
    }

    return NextResponse.json(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update tool configuration';
    console.error('Error updating tool configuration:', error);

    // Zod validation errors return 400
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * DELETE /api/tools/config/[id]
 * Delete a tool configuration
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const bookGuid = await getActiveBookGuid();
    const { id } = await params;
    const configId = parseInt(id, 10);

    if (isNaN(configId)) {
      return NextResponse.json({ error: 'Invalid configuration ID' }, { status: 400 });
    }

    const deleted = await ToolConfigService.delete(configId, user.id, bookGuid);
    if (!deleted) {
      return NextResponse.json({ error: 'Configuration not found' }, { status: 404 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error('Error deleting tool configuration:', error);
    return NextResponse.json(
      { error: 'Failed to delete tool configuration' },
      { status: 500 }
    );
  }
}
