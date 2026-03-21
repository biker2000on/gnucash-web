'use client';

import { ReactNode } from 'react';

export interface CardField {
  label: string;
  value: ReactNode;
  className?: string;
}

interface MobileCardProps {
  fields: CardField[];
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}

export function MobileCard({ fields, onClick, className = '', children }: MobileCardProps) {
  return (
    <div
      onClick={onClick}
      className={`p-4 border-b border-border ${onClick ? 'cursor-pointer active:bg-surface-hover' : ''} ${className}`}
    >
      {fields.map((field, i) => (
        <div key={i} className={`flex justify-between items-baseline py-0.5 ${field.className || ''}`}>
          <span className="text-xs text-foreground-muted uppercase tracking-wider">{field.label}</span>
          <span className="text-sm text-foreground text-right">{field.value}</span>
        </div>
      ))}
      {children}
    </div>
  );
}
