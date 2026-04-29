'use client';

import { ReactNode, TouchEvent, useRef, useState } from 'react';

interface Props {
    disabled: boolean;
    onCommit: () => void;
    children: ReactNode;
    className?: string;
}

const COMMIT_THRESHOLD_RATIO = 0.30;
const AXIS_LOCK_PX = 10;
const SWIPE_FLAG_PX = 8;

type Axis = 'unknown' | 'horizontal' | 'vertical';

export function SwipeableTransactionCard({ disabled, onCommit, children, className = '' }: Props) {
    const [dx, setDx] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [cardWidth, setCardWidth] = useState(0);

    const startXRef = useRef(0);
    const startYRef = useRef(0);
    const axisRef = useRef<Axis>('unknown');
    const wasSwipeRef = useRef(false);
    const cardWidthRef = useRef(0);
    const containerRef = useRef<HTMLDivElement | null>(null);

    if (disabled) {
        return <div className={className}>{children}</div>;
    }

    const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
        const t = e.touches[0];
        startXRef.current = t.clientX;
        startYRef.current = t.clientY;
        axisRef.current = 'unknown';
        wasSwipeRef.current = false;
        const width = containerRef.current?.getBoundingClientRect().width ?? 0;
        cardWidthRef.current = width;
        setCardWidth(width);
        setDx(0);
        setIsDragging(true);
    };

    const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
        const t = e.touches[0];
        const rawDx = t.clientX - startXRef.current;
        const rawDy = t.clientY - startYRef.current;

        if (axisRef.current === 'unknown') {
            const absDx = Math.abs(rawDx);
            const absDy = Math.abs(rawDy);
            if (absDx > AXIS_LOCK_PX && absDx > absDy) {
                axisRef.current = 'horizontal';
            } else if (absDy > AXIS_LOCK_PX && absDy > absDx) {
                axisRef.current = 'vertical';
                return;
            } else {
                return;
            }
        }

        if (axisRef.current === 'vertical') return;

        const capped = Math.max(0, Math.min(rawDx, cardWidthRef.current));
        if (capped > SWIPE_FLAG_PX) wasSwipeRef.current = true;
        setDx(capped);
    };

    const onTouchEnd = () => {
        const width = cardWidthRef.current;
        const threshold = width * COMMIT_THRESHOLD_RATIO;
        if (axisRef.current === 'horizontal' && dx >= threshold && threshold > 0) {
            onCommit();
        }
        setDx(0);
        setIsDragging(false);
    };

    const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
        if (wasSwipeRef.current) {
            e.stopPropagation();
            e.preventDefault();
            wasSwipeRef.current = false;
        }
    };

    const threshold = cardWidth * COMMIT_THRESHOLD_RATIO;
    const panelOpacity = threshold > 0 ? Math.min(1, dx / threshold) : 0;

    return (
        <div ref={containerRef} className={`relative overflow-hidden ${className}`}>
            <div
                className="absolute inset-y-0 left-0 flex items-center px-6 bg-emerald-600 text-white pointer-events-none"
                style={{ width: '100%', opacity: panelOpacity }}
                aria-hidden="true"
            >
                <svg className="w-5 h-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.42 0z" clipRule="evenodd" />
                </svg>
                <span className="text-sm font-medium">Review</span>
            </div>
            <div
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onTouchCancel={onTouchEnd}
                onClickCapture={onClickCapture}
                style={{
                    transform: `translateX(${dx}px)`,
                    transition: isDragging ? 'none' : 'transform 200ms ease-out',
                    touchAction: 'pan-y',
                }}
            >
                {children}
            </div>
        </div>
    );
}
