'use client';

import '@/app/print.css';

/**
 * Injects the global @media print stylesheet (src/app/print.css).
 *
 * Renders nothing — importing the CSS is the whole job. Mount once inside
 * the main layout, e.g. in src/app/(main)/layout.tsx:
 *
 *   <Providers>
 *     <PrintStyles />
 *     ...
 *   </Providers>
 */
export function PrintStyles() {
    return null;
}

export default PrintStyles;
