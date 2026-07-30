import type { JSX } from 'react';

import { BrandMark, type BrandMarkSize } from '@/components/brand/BrandMark';
import { product } from '@/lib/product';

interface BrandLockupProps {
  size: BrandMarkSize;
  compact?: boolean;
}

export function BrandLockup({ size, compact = false }: BrandLockupProps): JSX.Element {
  return (
    <span
      style={{
        alignItems: 'center',
        display: 'inline-flex',
        gap: compact ? 8 : 12,
      }}
    >
      <BrandMark size={size} label={product.brand} />
      <span
        style={{
          alignItems: compact ? 'center' : 'flex-start',
          display: 'inline-flex',
          flexDirection: compact ? 'row' : 'column',
          lineHeight: 1.1,
        }}
      >
        <span style={{ fontWeight: 700 }}>{product.name}</span>
        {!compact && product.descriptor && (
          <span style={{ color: 'var(--foreground-secondary)', fontSize: '0.75em' }}>
            {product.descriptor}
          </span>
        )}
      </span>
    </span>
  );
}
