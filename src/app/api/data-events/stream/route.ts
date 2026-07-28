import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { dataChangeChannel } from '@/lib/data-events';
import { getRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * GET /api/data-events/stream — SSE relay for the data-change bus.
 *
 * Subscribes to the active book's data-change channel and forwards each
 * published event as an SSE `data-change` frame. Same shape as
 * /api/notifications/stream (heartbeat, connected frame, abort cleanup).
 */
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
          // Client went away without an abort — tear everything down so the
          // heartbeat interval and Redis subscriber don't leak.
          void close();
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
        userId: user.id,
        at: new Date().toISOString(),
      });

      if (!subscriber) return;

      subscriber.on('message', (_channel, message) => {
        try {
          enqueue('data-change', JSON.parse(message));
        } catch {
          enqueue('error', { message: 'Invalid data-change payload' });
        }
      });

      subscriber.on('error', (error) => {
        enqueue('error', { message: error.message });
      });

      try {
        await subscriber.subscribe(dataChangeChannel(bookGuid));
      } catch (error) {
        enqueue('error', {
          message: error instanceof Error ? error.message : 'Data-change stream unavailable',
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
