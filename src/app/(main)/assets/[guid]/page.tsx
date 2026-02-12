'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AssetDetailView } from '@/components/assets/AssetDetailView';

export default function AssetDetailPage() {
  const params = useParams();
  const guid = params.guid as string;

  return (
    <div className="space-y-4">
      {/* Back link */}
      <Link
        href="/assets"
        className="inline-flex items-center text-sm text-foreground-secondary hover:text-foreground transition-colors"
      >
        <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to Fixed Assets
      </Link>

      <AssetDetailView accountGuid={guid} />
    </div>
  );
}
