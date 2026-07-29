import type { JSX } from 'react';

export type BrandMarkSize = 16 | 24 | 32 | 40 | 48 | 64 | 128 | 192 | 512;

interface BrandMarkProps {
  size: BrandMarkSize;
  label?: string;
}

const sharedSvgProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 64 64',
  focusable: false,
} as const;

export function BrandMark({ size, label }: BrandMarkProps): JSX.Element {
  if (size !== 16 && size !== 24 && size < 32) {
    throw new Error(`Unsupported Folio mark size: ${size}`);
  }

  const accessibilityProps = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': true };
  const variant = size >= 32 ? 'stack' : 'micro';

  if (variant === 'micro') {
    return (
      <svg
        {...sharedSvgProps}
        {...accessibilityProps}
        data-testid="folio-micro-mark"
        width={size}
        height={size}
      >
        <rect width="64" height="64" fill="#0c1322" />
        <rect x="12" y="8" width="40" height="48" rx="4" fill="#2dd4bf" />
        <path d="M22 18h24v8H30v8h13v8H30v12h-8z" fill="#0c1322" />
      </svg>
    );
  }

  return (
    <svg
      {...sharedSvgProps}
      {...accessibilityProps}
      data-testid="folio-stack-mark"
      width={size}
      height={size}
    >
      <rect width="64" height="64" fill="#0c1322" />
      <rect x="10" y="8" width="38" height="44" rx="4" fill="#176f78" />
      <rect x="16" y="12" width="38" height="44" rx="4" fill="#2dd4bf" />
      <path d="M26 22h22v7H33v7h12v7H33v11h-7z" fill="#0c1322" />
    </svg>
  );
}
