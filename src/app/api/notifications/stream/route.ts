import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getNotificationChannels } from '@/lib/notifications';
import { getRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;

  const { user, bookGuid } = roleResult;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const redis = getRedis();
      const subscriber = redis?.duplicate();

      function enqueue(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          closed = true;
        }
      }

      const heartbeat = setInterval(() => {
        enqueue('heartbeat', { at: new Date().toISOString() });
      }, 25000);

      async function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (subscriber) {
          try {
            await subscriber.unsubscribe();
          } catch {
            // Ignore cleanup errors for a closing stream.
          }
          subscriber.disconnect();
        }
        try {
          controller.close();
        } catch {
          // The client may already have gone away.
        }
      }

      request.signal.addEventListener('abort', () => {
        void close();
      });

      enqueue('connected', {
        redis: !!subscriber,
        at: new Date().toISOString(),
      });

      if (!subscriber) return;

      subscriber.on('message', (_channel, message) => {
        try {
          enqueue('notification', JSON.parse(message));
        } catch {
          enqueue('error', { message: 'Invalid notification payload' });
        }
      });

      subscriber.on('error', (error) => {
        enqueue('error', { message: error.message });
      });

      try {
        await subscriber.subscribe(...getNotificationChannels(user.id, bookGuid));
      } catch (error) {
        enqueue('error', {
          message: error instanceof Error ? error.message : 'Notification stream unavailable',
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
