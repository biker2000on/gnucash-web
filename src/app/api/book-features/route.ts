// src/app/api/book-features/route.ts
//
// Feature modules for the active book. GET returns the resolved state
// (entity-type defaults + admin overrides) for nav/hub gating and the
// settings card; PUT (admin) sets or clears per-module overrides.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { getEntityProfile } from '@/lib/services/entity.service';
import {
  getBookFeatureOverrides,
  setBookFeatureOverride,
} from '@/lib/services/book-features.service';
import {
  BOOK_FEATURE_DEFAULTS,
  BOOK_FEATURE_KEYS,
  BOOK_FEATURE_MODULES,
  resolveBookFeatures,
  type BookFeatureKey,
} from '@/lib/book-features';

export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookGuid = await getActiveBookGuid();
    const [profile, overrides] = await Promise.all([
      getEntityProfile(bookGuid, roleResult.user.id),
      getBookFeatureOverrides(bookGuid),
    ]);
    const defaults = BOOK_FEATURE_DEFAULTS[profile.entityType] ?? BOOK_FEATURE_DEFAULTS.household;
    const resolved = resolveBookFeatures(profile.entityType, overrides);

    return NextResponse.json({
      entityType: profile.entityType,
      features: resolved,
      modules: BOOK_FEATURE_MODULES.map(m => ({
        ...m,
        enabled: resolved[m.key],
        default: defaults[m.key],
        overridden: overrides[m.key] !== undefined,
      })),
    });
  } catch (error) {
    console.error('Error fetching book features:', error);
    return NextResponse.json({ error: 'Failed to fetch book features' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const features = body?.features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) {
      return NextResponse.json(
        { error: 'features must be an object of { moduleKey: boolean | null }' },
        { status: 400 }
      );
    }
    for (const [key, value] of Object.entries(features)) {
      if (!(BOOK_FEATURE_KEYS as string[]).includes(key)) {
        return NextResponse.json({ error: `Unknown feature module: ${key}` }, { status: 400 });
      }
      if (value !== null && typeof value !== 'boolean') {
        return NextResponse.json(
          { error: `Value for ${key} must be true, false, or null (reset to default)` },
          { status: 400 }
        );
      }
    }

    const bookGuid = await getActiveBookGuid();
    for (const [key, value] of Object.entries(features)) {
      await setBookFeatureOverride(bookGuid, key as BookFeatureKey, value as boolean | null);
    }

    // Return the fresh resolved state (same shape as GET)
    const [profile, overrides] = await Promise.all([
      getEntityProfile(bookGuid, roleResult.user.id),
      getBookFeatureOverrides(bookGuid),
    ]);
    const defaults = BOOK_FEATURE_DEFAULTS[profile.entityType] ?? BOOK_FEATURE_DEFAULTS.household;
    const resolved = resolveBookFeatures(profile.entityType, overrides);
    return NextResponse.json({
      entityType: profile.entityType,
      features: resolved,
      modules: BOOK_FEATURE_MODULES.map(m => ({
        ...m,
        enabled: resolved[m.key],
        default: defaults[m.key],
        overridden: overrides[m.key] !== undefined,
      })),
    });
  } catch (error) {
    console.error('Error saving book features:', error);
    return NextResponse.json({ error: 'Failed to save book features' }, { status: 500 });
  }
}
