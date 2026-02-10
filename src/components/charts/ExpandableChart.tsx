'use client';

import { useState, createContext, ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';

export const ExpandedContext = createContext(false);

interface ExpandableChartProps {
  title: string;
  children: ReactNode;
}

export default function ExpandableChart({ title, children }: ExpandableChartProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative group h-full">
      {/* Normal view - not rendered when expanded */}
      {!expanded && (
        <div className="h-full">
          <ExpandedContext.Provider value={false}>
            {children}
          </ExpandedContext.Provider>
        </div>
      )}

      {/* Expand button - visible on hover */}
      <button
        onClick={() => setExpanded(true)}
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-surface/80 backdrop-blur-sm border border-border opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-hover z-10"
        title="Expand chart"
      >
        {/* Expand SVG icon */}
        <svg className="w-4 h-4 text-foreground-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </button>

      {/* Fullscreen modal */}
      {expanded && (
        <Modal isOpen={expanded} onClose={() => setExpanded(false)} title={title} size="fullscreen">
          <ExpandedContext.Provider value={true}>
            <div className="w-full h-full min-h-[70vh] p-4">
              {children}
            </div>
          </ExpandedContext.Provider>
        </Modal>
      )}
    </div>
  );
}
