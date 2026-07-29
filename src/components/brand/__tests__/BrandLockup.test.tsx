import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BrandLockup } from '@/components/brand/BrandLockup';

afterEach(() => {
  cleanup();
});

describe('BrandLockup', () => {
  it('renders the full accessible Folio lockup', () => {
    render(<BrandLockup size={32} />);

    expect(screen.getByText('Folio')).toBeInTheDocument();
    expect(screen.getByText('for GnuCash')).toBeInTheDocument();
    expect(screen.getByLabelText('Folio for GnuCash')).toBeInTheDocument();
  });
});

describe('primary product surfaces', () => {
  const ownedProductionSurfaces = [
    'src/components/Layout.tsx',
    'src/components/LoginForm.tsx',
    'src/app/(main)/dashboard/page.tsx',
    'src/components/CreateBookWizard.tsx',
    'src/contexts/PWAInstallContext.tsx',
    'src/app/(marketing)/layout.tsx',
    'src/app/(marketing)/page.tsx',
    'src/app/(marketing)/features/page.tsx',
    'src/app/(marketing)/features/[slug]/page.tsx',
    'src/app/share/[token]/page.tsx',
    'src/app/share/invoice/[token]/page.tsx',
  ] as const;

  it.each([
    ['Layout', 'src/components/Layout.tsx'],
    ['LoginForm', 'src/components/LoginForm.tsx'],
    ['marketing layout', 'src/app/(marketing)/layout.tsx'],
  ])('uses shared identity in %s', (_surface, path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toMatch(/import\s+\{[^}]*\b(?:product|BrandLockup)\b[^}]*\}\s+from/);
    expect(source).not.toContain('GnuCash Web');
  });

  it.each([
    ['feature catalog', 'src/app/(marketing)/features/page.tsx'],
    ['feature detail', 'src/app/(marketing)/features/[slug]/page.tsx'],
    ['shared report', 'src/app/share/[token]/page.tsx'],
    ['shared invoice', 'src/app/share/invoice/[token]/page.tsx'],
  ])('uses the full product brand in the %s metadata title', (_surface, path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toMatch(/title:\s*`[^`]*\$\{product\.brand\}[^`]*`/);
  });

  it.each(ownedProductionSurfaces)('contains no retired product label in %s', (path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain('GnuCash Web');
  });

  it('keeps the primary application shell gradient-free', () => {
    const source = readFileSync('src/components/Layout.tsx', 'utf8');

    expect(source).not.toMatch(/gradient\(/);
  });
});
