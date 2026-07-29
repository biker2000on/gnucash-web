import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BrandLockup } from '@/components/brand/BrandLockup';
import { BrandMark } from '@/components/brand/BrandMark';

afterEach(() => {
  cleanup();
});

describe('BrandMark', () => {
  it.each([16, 24] as const)('renders the Micro mark at %ipx', (size) => {
    render(<BrandMark size={size} label="Folio" />);

    expect(screen.getByTestId('folio-micro-mark')).toBeInTheDocument();
    expect(screen.queryByTestId('folio-stack-mark')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Folio')).toHaveAttribute('role', 'img');
  });

  it.each([32, 64] as const)('renders the Stack mark at %ipx', (size) => {
    render(<BrandMark size={size} label="Folio" />);

    expect(screen.getByTestId('folio-stack-mark')).toBeInTheDocument();
    expect(screen.queryByTestId('folio-micro-mark')).not.toBeInTheDocument();
  });

  it('selects marks from rendered size instead of viewport width', () => {
    window.innerWidth = 320;
    const { rerender } = render(<BrandMark size={32} />);
    expect(screen.getByTestId('folio-stack-mark')).toBeInTheDocument();

    window.innerWidth = 1920;
    rerender(<BrandMark size={24} />);
    expect(screen.getByTestId('folio-micro-mark')).toBeInTheDocument();
  });

  it('hides an unlabeled mark from assistive technology', () => {
    render(<BrandMark size={16} />);

    expect(screen.getByTestId('folio-micro-mark')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('rejects an unsupported compact rendered size', () => {
    expect(() => render(<BrandMark size={20 as 16} />)).toThrow(
      'Unsupported Folio mark size: 20',
    );
  });
});

describe('BrandLockup', () => {
  it('labels the mark with the shared brand and shows the full visible lockup', () => {
    render(<BrandLockup size={32} />);

    expect(screen.getByLabelText('Folio for GnuCash')).toBeInTheDocument();
    expect(screen.getByText('Folio')).toBeInTheDocument();
    expect(screen.getByText('for GnuCash')).toBeInTheDocument();
  });

  it('omits the visible descriptor in compact mode', () => {
    render(<BrandLockup size={24} compact />);

    expect(screen.getByLabelText('Folio for GnuCash')).toBeInTheDocument();
    expect(screen.getByText('Folio')).toBeInTheDocument();
    expect(screen.queryByText('for GnuCash')).not.toBeInTheDocument();
  });
});
