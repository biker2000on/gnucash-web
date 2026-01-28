import Layout from "@/components/Layout";
import { initializeDatabase } from "@/lib/db-init";
import { Providers } from "@/app/providers";

export default async function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    // Initialize database schema (create views if they don't exist)
    await initializeDatabase();

    return (
        <Providers>
            <Layout>{children}</Layout>
        </Providers>
    );
}
