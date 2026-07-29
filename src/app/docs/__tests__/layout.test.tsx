import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import DocsLayout from '@/app/docs/layout';

afterEach(() => {
  cleanup();
});

describe('DocsLayout', () => {
  it('renders the responsive Folio brand lockup in the docs header', () => {
    render(
      <DocsLayout>
        <p>Documentation content</p>
      </DocsLayout>
    );

    const homeLink = screen.getByRole('link', {
      name: /Folio/i,
    });

    expect(homeLink).toHaveAttribute('href', '/');
    expect(screen.getByTestId('folio-stack-mark')).toBeInTheDocument();
    expect(screen.queryByText(/GnuCash/)).not.toBeInTheDocument();
  });
});
