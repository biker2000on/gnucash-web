// src/app/api/settings/ai/route.ts

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAiConfigForDisplay, saveAiConfig } from '@/lib/ai-config';

export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user } = roleResult;

    const config = await getAiConfigForDisplay(user.id);
    return NextResponse.json(config || { provider: 'none', base_url: null, has_api_key: false, api_key_valid: true, model: null, enabled: false });
  } catch (error) {
    console.error('AI config error:', error);
    return NextResponse.json({ error: 'Failed to get AI config' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user } = roleResult;

    const body = await request.json();
    const { provider, base_url, api_key, model, enabled } = body;

    await saveAiConfig(user.id, {
      provider: provider || 'none',
      base_url: base_url || null,
      api_key: api_key || null,
      model: model || null,
      enabled: enabled ?? false,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('AI config save error:', error);
    return NextResponse.json({ error: 'Failed to save AI config' }, { status: 500 });
  }
}
