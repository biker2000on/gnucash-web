import type { MetadataRoute } from 'next';
import { product } from '@/lib/product';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: product.brand,
    short_name: product.shortName,
    description: product.description,
    scope: '/',
    start_url: '/',
    display: 'standalone',
    background_color: '#0c1322',
    theme_color: '#0c1322',
    categories: ['finance'],
    icons: [
      {
        src: '/icons/folio-stack-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/folio-stack-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/folio-stack-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/favicon.ico',
        sizes: '32x32',
        type: 'image/x-icon',
        purpose: 'any',
      },
    ],
    screenshots: [
      {
        src: '/screenshots/folio-mobile.png',
        sizes: '1080x1920',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'Folio for GnuCash on mobile',
      },
      {
        src: '/screenshots/folio-desktop.png',
        sizes: '1920x1080',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Folio for GnuCash on desktop',
      },
    ],
  };
}
