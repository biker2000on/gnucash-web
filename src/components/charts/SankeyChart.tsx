'use client';

import { useRef, useState, useEffect, useMemo } from 'react';
import {
  sankey,
  sankeyLinkHorizontal,
  sankeyJustify,
  SankeyGraph,
  SankeyNode as D3SankeyNode,
  SankeyLink as D3SankeyLink,
} from 'd3-sankey';
import { formatCurrency } from '@/lib/format';

interface SankeyNode {
  name: string;
}

interface SankeyLink {
  source: number;
  target: number;
  value: number;
}

interface SankeyChartProps {
  nodes: SankeyNode[];
  links: SankeyLink[];
  width?: number;
  height?: number;
}

const COLORS = [
  '#34d399',
  '#22d3ee',
  '#818cf8',
  '#f472b6',
  '#fb923c',
  '#a3e635',
  '#2dd4bf',
  '#c084fc',
  '#f87171',
  '#fbbf24',
  '#60a5fa',
  '#e879f9',
];

const NODE_WIDTH = 12;
const NODE_PADDING = 16;

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  content: string;
}

export default function SankeyChart({
  nodes,
  links,
  width: propWidth,
  height: propHeight,
}: SankeyChartProps) {
  const minHeight = Math.max(propHeight ?? 600, nodes.length * 25);
  const defaultHeight = minHeight;
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: propWidth || 800, height: defaultHeight });
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    content: '',
  });
  const [hoveredLink, setHoveredLink] = useState<number | null>(null);

  // Measure container dimensions using ResizeObserver
  useEffect(() => {
    if (!containerRef.current || propWidth) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({
          width,
          height: propHeight === undefined ? Math.max(height, 300) : propHeight,
        });
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [propWidth, propHeight]);

  // Compute sankey layout
  const sankeyData = useMemo(() => {
    const sankeyGenerator = sankey<SankeyNode, SankeyLink>()
      .nodeWidth(NODE_WIDTH)
      .nodePadding(NODE_PADDING)
      .extent([
        [20, 20],
        [dimensions.width - 20, dimensions.height - 20],
      ])
      .nodeAlign(sankeyJustify);

    const graph: SankeyGraph<SankeyNode, SankeyLink> = {
      nodes: nodes.map((d) => ({ ...d })),
      links: links.map((d) => ({ ...d })),
    };

    return sankeyGenerator(graph);
  }, [nodes, links, dimensions]);

  const linkPath = sankeyLinkHorizontal();

  const getNodeColor = (index: number) => COLORS[index % COLORS.length];

  const handleNodeMouseEnter = (
    node: D3SankeyNode<SankeyNode, SankeyLink>,
    event: React.MouseEvent
  ) => {
    const value = node.value || 0;
    setTooltip({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      content: `${node.name}: ${formatCurrency(value)}`,
    });
  };

  const handleLinkMouseEnter = (
    link: D3SankeyLink<SankeyNode, SankeyLink>,
    index: number,
    event: React.MouseEvent
  ) => {
    setHoveredLink(index);
    const sourceNode = typeof link.source === 'object' ? link.source as D3SankeyNode<SankeyNode, SankeyLink> : null;
    const targetNode = typeof link.target === 'object' ? link.target as D3SankeyNode<SankeyNode, SankeyLink> : null;
    const sourceName = sourceNode?.name ?? '';
    const targetName = targetNode?.name ?? '';
    setTooltip({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      content: `${sourceName} → ${targetName}: ${formatCurrency(link.value)}`,
    });
  };

  const handleMouseLeave = () => {
    setTooltip({ visible: false, x: 0, y: 0, content: '' });
    setHoveredLink(null);
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: propHeight === undefined ? '100%' : undefined }}>
      <svg width={dimensions.width} height={dimensions.height}>
        <defs>
          {sankeyData.links.map((link, i) => {
            const sourceIndex = sankeyData.nodes.indexOf(link.source as D3SankeyNode<SankeyNode, SankeyLink>);
            const targetIndex = sankeyData.nodes.indexOf(link.target as D3SankeyNode<SankeyNode, SankeyLink>);
            const sourceColor = getNodeColor(sourceIndex);
            const targetColor = getNodeColor(targetIndex);

            return (
              <linearGradient key={i} id={`gradient-${i}`} gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor={sourceColor} />
                <stop offset="100%" stopColor={targetColor} />
              </linearGradient>
            );
          })}
        </defs>

        {/* Render links */}
        <g>
          {sankeyData.links.map((link, i) => (
            <path
              key={i}
              d={linkPath(link) || ''}
              fill="none"
              stroke={`url(#gradient-${i})`}
              strokeWidth={Math.max(1, link.width || 0)}
              opacity={hoveredLink === i ? 0.6 : 0.3}
              style={{ cursor: 'pointer', transition: 'opacity 0.2s' }}
              onMouseEnter={(e) => handleLinkMouseEnter(link, i, e)}
              onMouseLeave={handleMouseLeave}
            />
          ))}
        </g>

        {/* Render nodes */}
        <g>
          {sankeyData.nodes.map((node, i) => (
            <g key={i}>
              <rect
                x={node.x0}
                y={node.y0}
                width={node.x1! - node.x0!}
                height={node.y1! - node.y0!}
                fill={getNodeColor(i)}
                stroke="var(--border)"
                strokeWidth={1}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => handleNodeMouseEnter(node, e)}
                onMouseLeave={handleMouseLeave}
              />
              <text
                x={node.x0! < dimensions.width / 2 ? node.x1! + 6 : node.x0! - 6}
                y={(node.y0! + node.y1!) / 2}
                dy="0.35em"
                textAnchor={node.x0! < dimensions.width / 2 ? 'start' : 'end'}
                fontSize={12}
                fill="var(--foreground)"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {node.name}
              </text>
            </g>
          ))}
        </g>
      </svg>

      {/* Tooltip */}
      {tooltip.visible && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x + 10,
            top: tooltip.y + 10,
            background: 'var(--background)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            padding: '8px 12px',
            fontSize: '12px',
            color: 'var(--foreground)',
            pointerEvents: 'none',
            zIndex: 1000,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
          }}
        >
          {tooltip.content}
        </div>
      )}
    </div>
  );
}
