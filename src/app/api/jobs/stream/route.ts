import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { jobProgressChannels } from '@/lib/job-progress';
import { getRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * GET /api/jobs/stream — SSE relay for the job-progress bus.
 *
 * Subscribes to the active book's and the user's job-progress channels and
 * forwards each published event as an SSE `job-progress` frame. Same shape
 * as /api/notifications/stream (heartbeat, connected frame, abort cleanup).
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

      // De-dup: an event published to both the user and book channel would
      // arrive twice on this stream — forward each jobId+status+ts once.
      const seen = new Set<string>();
      subscriber.on('message', (_channel, message) => {
        try {
          const event = JSON.parse(message) as { jobId?: string; status?: string; ts?: string };
          const key = `${event.jobId}|${event.status}|${event.ts}`;
          if (event.jobId && seen.has(key)) return;
          if (event.jobId) {
            seen.add(key);
            if (seen.size > 500) seen.clear();
          }
          enqueue('job-progress', event);
        } catch {
          enqueue('error', { message: 'Invalid job-progress payload' });
        }
      });

      subscriber.on('error', (error) => {
        enqueue('error', { message: error.message });
      });

      try {
        await subscriber.subscribe(...jobProgressChannels(user.id, bookGuid));
      } catch (error) {
        enqueue('error', {
          message: error instanceof Error ? error.message : 'Job progress stream unavailable',
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
