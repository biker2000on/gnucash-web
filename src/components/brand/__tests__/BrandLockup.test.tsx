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
  it.each([
    ['Layout', 'src/components/Layout.tsx'],
    ['LoginForm', 'src/components/LoginForm.tsx'],
    ['marketing layout', 'src/app/(marketing)/layout.tsx'],
  ])('uses shared identity in %s', (_surface, path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toMatch(/import\s+\{[^}]*\b(?:product|BrandLockup)\b[^}]*\}\s+from/);
    expect(source).not.toContain('GnuCash Web');
  });

  it('keeps the primary application shell gradient-free', () => {
    const source = readFileSync('src/components/Layout.tsx', 'utf8');

    expect(source).not.toMatch(/gradient\(/);
  });
});
