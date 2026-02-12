import { InvestmentDataProvider } from '@/contexts/InvestmentDataContext';

export default function InvestmentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <InvestmentDataProvider>
      {children}
    </InvestmentDataProvider>
  );
}
