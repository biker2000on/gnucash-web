import Layout from "@/components/Layout";

export default function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return <Layout>{children}</Layout>;
}
