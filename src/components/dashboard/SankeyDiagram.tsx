'use client';

import dynamic from 'next/dynamic';

const SankeyChart = dynamic(() => import('@/components/charts/SankeyChart'), { ssr: false });

interface SankeyNode {
    name: string;
}

interface SankeyLink {
    source: number;
    target: number;
    value: number;
}

interface SankeyDiagramProps {
    nodes: SankeyNode[];
    links: SankeyLink[];
    loading: boolean;
}

function ChartSkeleton() {
    return (
        <div className="bg-surface border border-border rounded-xl p-6 animate-pulse">
            <div className="h-5 w-48 bg-background-secondary rounded mb-6" />
            <div className="h-[500px] bg-background-secondary rounded" />
        </div>
    );
}

export default function SankeyDiagram({ nodes, links, loading }: SankeyDiagramProps) {
    if (loading) return <ChartSkeleton />;

    if (!nodes || nodes.length === 0 || !links || links.length === 0) {
        return (
            <div className="bg-surface border border-border rounded-xl p-6">
                <h3 className="text-lg font-semibold text-foreground mb-4">Income Flow</h3>
                <div className="h-[500px] flex items-center justify-center">
                    <p className="text-foreground-muted text-sm">No flow data available for this period.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-surface border border-border rounded-xl p-6">
            <h3 className="text-lg font-semibold text-foreground mb-4">Income Flow</h3>
            <SankeyChart nodes={nodes} links={links} height={500} />
        </div>
    );
}
