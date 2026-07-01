'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

interface NotificationItem {
  id: number;
  type: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

function IconBell({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.17V11a6 6 0 10-12 0v3.17a2 2 0 01-.6 1.43L4 17h5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17a3 3 0 006 0" />
    </svg>
  );
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return 'Just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function severityClass(severity: NotificationItem['severity']) {
  switch (severity) {
    case 'success':
      return 'bg-success/10 text-success border-success/20';
    case 'warning':
      return 'bg-warning/10 text-warning border-warning/20';
    case 'error':
      return 'bg-error/10 text-error border-error/20';
    default:
      return 'bg-primary/10 text-primary border-primary/20';
  }
}

export function NotificationBell() {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);

  async function loadNotifications() {
    try {
      const res = await fetch('/api/notifications?limit=20');
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadNotifications();
    const interval = window.setInterval(loadNotifications, 30000);
    const events = new EventSource('/api/notifications/stream');

    events.addEventListener('notification', (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type?: string;
          notification?: NotificationItem;
        };
        if (!data.notification) return;

        setNotifications(prev => {
          if (prev.some(item => item.id === data.notification!.id)) return prev;
          return [data.notification!, ...prev].slice(0, 20);
        });
        if (!data.notification.readAt) {
          setUnreadCount(count => count + 1);
        }
      } catch {
        // Ignore malformed stream events; polling will recover the feed.
      }
    });

    events.addEventListener('error', () => {
      void loadNotifications();
    });

    return () => {
      window.clearInterval(interval);
      events.close();
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function markAllRead() {
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    setNotifications(prev => prev.map(item => ({
      ...item,
      readAt: item.readAt || new Date().toISOString(),
    })));
    setUnreadCount(0);
  }

  async function markRead(id: number) {
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setNotifications(prev => prev.map(item => (
      item.id === id ? { ...item, readAt: item.readAt || new Date().toISOString() } : item
    )));
    setUnreadCount(count => Math.max(0, count - 1));
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        className="relative p-2 rounded-lg text-foreground-secondary hover:bg-surface-hover hover:text-foreground transition-colors"
        aria-label="Notifications"
        aria-expanded={isOpen}
      >
        <IconBell />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-error text-error-foreground text-[11px] font-semibold flex items-center justify-center border border-input-bg">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-[min(24rem,calc(100vw-2rem))] bg-background-secondary border border-border rounded-lg shadow-lg overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-foreground font-semibold">Notifications</p>
              <p className="text-xs text-foreground-muted">{unreadCount} unread</p>
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs text-primary hover:text-primary-hover font-medium"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && (
              <div className="p-4 space-y-3">
                <div className="h-4 w-2/3 rounded bg-background-tertiary animate-pulse" />
                <div className="h-4 w-full rounded bg-background-tertiary animate-pulse" />
              </div>
            )}

            {!loading && notifications.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-foreground-secondary">No notifications</p>
              </div>
            )}

            {!loading && notifications.map(item => {
              const content = (
                <div
                  className={`w-full px-4 py-3 text-left border-b border-border last:border-b-0 hover:bg-surface-hover transition-colors ${item.readAt ? '' : 'bg-primary/5'}`}
                  onClick={() => {
                    if (!item.readAt) void markRead(item.id);
                    setIsOpen(false);
                  }}
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${severityClass(item.severity)}`}>
                      {item.severity}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-foreground">{item.title}</p>
                        <span className="text-xs text-foreground-muted whitespace-nowrap">
                          {formatRelativeTime(item.createdAt)}
                        </span>
                      </div>
                      {item.message && (
                        <p className="mt-1 text-xs text-foreground-secondary line-clamp-3 whitespace-pre-line">
                          {item.message}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );

              if (item.href) {
                return (
                  <Link key={item.id} href={item.href}>
                    {content}
                  </Link>
                );
              }

              return (
                <button key={item.id} type="button" className="w-full">
                  {content}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
