/**
 * Connection policy for the job-progress SSE stream (finding 8): the stream is
 * opened on demand, never unconditionally from the authenticated shell.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { JobProgressProvider, useJobProgress } from '@/contexts/JobProgressContext';

const instances: { url: string; close: ReturnType<typeof vi.fn> }[] = [];

class FakeEventSource {
  close = vi.fn();
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    instances.push({ url, close: this.close });
  }
  addEventListener() {}
}

let captured: ReturnType<typeof useJobProgress> | null = null;

function Probe() {
  captured = useJobProgress();
  return null;
}

describe('JobProgressProvider connection policy', () => {
  beforeEach(() => {
    instances.length = 0;
    captured = null;
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens no EventSource just for being mounted', () => {
    render(
      <JobProgressProvider>
        <Probe />
      </JobProgressProvider>,
    );

    expect(instances).toHaveLength(0);
  });

  it('opens the stream when a job is tracked, and only once', () => {
    render(
      <JobProgressProvider>
        <Probe />
      </JobProgressProvider>,
    );

    act(() => {
      captured!.trackJob('job-1', 'Scrub all lots');
    });
    expect(instances.map((i) => i.url)).toEqual(['/api/jobs/stream']);

    act(() => {
      captured!.trackJob('job-2', 'Price refresh');
      captured!.connect();
    });
    expect(instances).toHaveLength(1);
  });

  it('opens the stream when a page explicitly calls connect()', () => {
    render(
      <JobProgressProvider>
        <Probe />
      </JobProgressProvider>,
    );

    act(() => {
      captured!.connect();
    });

    expect(instances.map((i) => i.url)).toEqual(['/api/jobs/stream']);
  });

  it('closes the stream on unmount', () => {
    const view = render(
      <JobProgressProvider>
        <Probe />
      </JobProgressProvider>,
    );

    act(() => {
      captured!.connect();
    });
    view.unmount();

    expect(instances[0].close).toHaveBeenCalled();
  });

  it('no longer exports a shell component that connects on mount', async () => {
    const mod = await import('@/contexts/JobProgressContext');
    expect('JobProgressStream' in mod).toBe(false);

    const layout = readFileSync(
      resolve(process.cwd(), 'src/components/Layout.tsx'),
      'utf8',
    );
    expect(layout).not.toContain('JobProgressStream');
  });

  it('keeps the reconnect backoff wired to the stream error handler', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/contexts/JobProgressContext.tsx'),
      'utf8',
    );
    expect(source).toContain('source.onerror');
    expect(source).toContain('setTimeout(() => connectRef.current(), 15000)');
  });
});
