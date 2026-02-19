'use client';

import { CreateBookWizard } from '@/components/CreateBookWizard';
import { useBooks } from '@/contexts/BookContext';
import { useRouter } from 'next/navigation';

export default function OnboardingPage() {
  const { refreshBooks, switchBook } = useBooks();
  const router = useRouter();

  const handleBookCreated = async (bookGuid: string) => {
    await refreshBooks();
    await switchBook(bookGuid);
    router.push('/accounts');
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <CreateBookWizard onBookCreated={handleBookCreated} isOnboarding={true} />
    </div>
  );
}
