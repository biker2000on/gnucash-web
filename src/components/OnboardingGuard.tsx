'use client';

import { useEffect, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useBooks } from '@/contexts/BookContext';

export function OnboardingGuard({ children }: { children: ReactNode }) {
  const { hasNoBooks, loading } = useBooks();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && hasNoBooks && pathname !== '/onboarding') {
      router.push('/onboarding');
    }
  }, [hasNoBooks, loading, pathname, router]);

  return <>{children}</>;
}
