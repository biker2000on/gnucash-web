import { Providers } from "@/app/providers";
import { BookProvider } from "@/contexts/BookContext";

// Pop-out pane windows: authenticated app routes with the shared client
// providers but no sidebar/topbar chrome, so a pane can live alone on a
// second monitor. Session-backed like every (main) route.
export const dynamic = 'force-dynamic';

export default function PopoutLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <Providers>
            <BookProvider>
                <div className="min-h-screen bg-background text-foreground">
                    {children}
                </div>
            </BookProvider>
        </Providers>
    );
}
