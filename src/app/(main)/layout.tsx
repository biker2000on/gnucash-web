import Layout from "@/components/Layout";
import { initializeDatabase } from "@/lib/db-init";

export default async function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    // Initialize database schema (create views if they don't exist)
    await initializeDatabase();

    return <Layout>{children}</Layout>;
}
