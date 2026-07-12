import Layout from "@/components/Layout";
import { Providers } from "@/app/providers";
import { BookProvider } from "@/contexts/BookContext";
import { OnboardingGuard } from "@/components/OnboardingGuard";
import { PrintStyles } from "@/components/PrintStyles";

// All authenticated pages read the session cookie and load live data, and the
// sidebar reads the URL query (useSearchParams) for active-nav highlighting, so
// this segment is rendered on demand rather than statically prerendered.
export const dynamic = 'force-dynamic';

export default async function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <Providers>
            <PrintStyles />
            <BookProvider>
                <OnboardingGuard>
                    <Layout>{children}</Layout>
                </OnboardingGuard>
            </BookProvider>
        </Providers>
    );
}
