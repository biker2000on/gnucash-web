import { FamilyBankingChildView } from '@/components/resilience/P3FeaturePages';

export default async function Page({ params }: { params: Promise<{ childId: string }> }) {
  return <FamilyBankingChildView childId={(await params).childId} />;
}
