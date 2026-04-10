import Layout from "@/components/Layout";
import { Providers } from "@/app/providers";
import { BookProvider } from "@/contexts/BookContext";
import { OnboardingGuard } from "@/components/OnboardingGuard";

export default async function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <Providers>
            <BookProvider>
                <OnboardingGuard>
                    <Layout>{children}</Layout>
                </OnboardingGuard>
            </BookProvider>
        </Providers>
    );
}
