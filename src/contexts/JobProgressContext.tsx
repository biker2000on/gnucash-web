'use client';

/**
 * Job-progress client bus.
 *
 * One EventSource to /api/jobs/stream per app instance relays server-side
 * job progress (SimpleFin sync, price refresh, scrub-all, …). Components
 * kick off work, get a jobId from the API, and call trackJob(jobId, label) —
 * tracked jobs render as floating progress cards and finish with a toast.
 * Every received event is also re-dispatched as a `job-progress` window
 * CustomEvent so pages (e.g. the connections page) can consume untracked
 * events, matching the repo's CustomEvent bus convention.
 *
 * Resilience: a 7s poll of /api/jobs/[id] backstops tracked queue jobs when
 * the SSE stream drops (inline-* synthetic ids have no queue entry and rely
 * on SSE alone).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useToast } from '@/contexts/ToastContext';

export interface JobProgressEventPayload {
  jobId: string;
  kind: string;
  bookGuid: string;
  userId?: number;
  source: 'manual' | 'scheduled';
  status: 'running' | 'progress' | 'completed' | 'failed';
  label: string;
  message?: string;
  current?: number;
  total?: number;
  percent?: number;
  summary?: Record<string, unknown>;
  error?: string;
  ts: string;
}

export interface TrackedJob {
  jobId: string;
  label: string;
  status: 'pending' | 'running' | 'progress' | 'completed' | 'failed';
  message?: string;
  percent?: number;
  startedAt: number;
}

interface JobProgressContextType {
  jobs: TrackedJob[];
  /** Start following a job the user just kicked off. */
  trackJob: (jobId: string, label: string) => void;
  /** Open the SSE stream (idempotent). Called from the authenticated shell. */
  connect: () => void;
}

const JobProgressContext = createContext<JobProgressContextType | undefined>(undefined);

/** Human summary line for a completed job. */
export function formatJobSummary(
  kind: string,
  label: string,
  summary?: Record<string, unknown>,
): string {
  const n = (k: string) => (typeof summary?.[k] === 'number' ? (summary[k] as number) : null);
  if (kind === 'sync-simplefin') {
    const parts = [`${n('transactionsImported') ?? 0} imported`];
    const inv = n('investmentTransactionsImported');
    if (inv) parts.push(`${inv} investment`);
    const skipped = n('transactionsSkipped');
    if (skipped) parts.push(`${skipped} skipped`);
    const matched = (n('manualReconciliation') ?? 0) + (n('transferDedup') ?? 0);
    if (matched) parts.push(`${matched} matched`);
    const warnings = n('warnings');
    if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
    return `SimpleFin sync complete: ${parts.join(', ')}`;
  }
  if (kind === 'scrub-all-lots') {
    return `Scrub complete: ${n('accounts') ?? 0} accounts, ${n('lotsCreated') ?? 0} lots, ${n('gainsTransactions') ?? 0} gains transactions`;
  }
  if (kind === 'backfill-indices') {
    return `Index backfill complete: ${n('totalStored') ?? 0} prices stored`;
  }
  if (kind === 'regenerate-thumbnails') {
    return `Thumbnails complete: ${n('regenerated') ?? 0} regenerated, ${n('failed') ?? 0} failed`;
  }
  return `${label} complete`;
}

export function JobProgressProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const jobsRef = useRef<TrackedJob[]>([]);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Session user id, learned from the stream's `connected` frame — used to
  // scope auto-tracking to the user's own jobs on shared-book channels.
  const userIdRef = useRef<number | undefined>(undefined);

  const finishJob = useCallback(
    (jobId: string, ok: boolean, text: string) => {
      // Inline jobs' pages already show their own success toast/result panel
      // from the HTTP response — don't double-notify.
      if (!jobId.startsWith('inline-')) {
        if (ok) toast.success(text);
        else toast.error(text);
      }
      // Let the card show its terminal state briefly, then drop it.
      setTimeout(() => {
        setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
      }, 1500);
    },
    [toast],
  );

  const handleEvent = useCallback(
    (event: JobProgressEventPayload) => {
      // Fan out to any page-level listeners (repo CustomEvent convention).
      window.dispatchEvent(new CustomEvent('job-progress', { detail: event }));

      let tracked = jobsRef.current.find((j) => j.jobId === event.jobId);
      // Duplicate terminal events (SSE + in-flight poll response) must not
      // re-toast: ignore anything for a job already in a terminal state.
      if (tracked && (tracked.status === 'completed' || tracked.status === 'failed')) return;
      // Auto-track manual jobs announced on the bus (covers inline work whose
      // jobId only arrives with the final response, and buttons that don't
      // call trackJob explicitly). Scheduled/background jobs stay card-free,
      // and other users' jobs on a shared book don't grow cards here.
      const isMine = event.userId === undefined || event.userId === userIdRef.current;
      if (!tracked && isMine && event.source === 'manual' && (event.status === 'running' || event.status === 'progress')) {
        tracked = {
          jobId: event.jobId,
          label: event.label,
          status: event.status,
          message: event.message,
          percent: event.percent,
          startedAt: Date.now(),
        };
        const newJob = tracked;
        setJobs((prev) =>
          prev.some((j) => j.jobId === newJob.jobId) ? prev : [...prev, newJob],
        );
      }
      if (!tracked) return;
      if (event.status === 'completed') {
        setJobs((prev) =>
          prev.map((j) =>
            j.jobId === event.jobId ? { ...j, status: 'completed', percent: 100 } : j,
          ),
        );
        finishJob(event.jobId, true, formatJobSummary(event.kind, tracked.label, event.summary));
      } else if (event.status === 'failed') {
        setJobs((prev) =>
          prev.map((j) => (j.jobId === event.jobId ? { ...j, status: 'failed' } : j)),
        );
        finishJob(event.jobId, false, `${tracked.label} failed: ${event.error ?? 'unknown error'}`);
      } else {
        setJobs((prev) =>
          prev.map((j) =>
            j.jobId === event.jobId
              ? {
                  ...j,
                  status: event.status,
                  message: event.message ?? j.message,
                  percent: event.percent ?? j.percent,
                }
              : j,
          ),
        );
      }
    },
    [finishJob],
  );
  const handleEventRef = useRef(handleEvent);
  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);
  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    if (sourceRef.current) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/jobs/stream');
    sourceRef.current = source;
    source.addEventListener('job-progress', (e) => {
      try {
        handleEventRef.current(JSON.parse((e as MessageEvent).data));
      } catch {
        // Malformed frame — ignore.
      }
    });
    source.addEventListener('connected', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (typeof data.userId === 'number') userIdRef.current = data.userId;
      } catch {
        // Malformed frame — ignore.
      }
    });
    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(() => connectRef.current(), 15000);
    };
  }, []);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const trackJob = useCallback(
    (jobId: string, label: string) => {
      if (!jobId) return;
      setJobs((prev) =>
        prev.some((j) => j.jobId === jobId)
          ? prev
          : [...prev, { jobId, label, status: 'pending', startedAt: Date.now() }],
      );
      connect();
    },
    [connect],
  );

  // Polling backstop for tracked QUEUE jobs (inline-* ids have no queue row).
  useEffect(() => {
    const active = jobs.filter(
      (j) =>
        (j.status === 'pending' || j.status === 'running' || j.status === 'progress') &&
        !j.jobId.startsWith('inline-') &&
        !j.jobId.startsWith('scheduled-'),
    );
    if (active.length === 0) return;
    const interval = setInterval(async () => {
      for (const job of active) {
        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(job.jobId)}`);
          if (!res.ok) continue;
          const data = await res.json();
          const rv = (data.returnvalue as Record<string, unknown> | null) ?? undefined;
          // A job that "completed" with a non-success status (e.g. a sync
          // that failed without throwing) is a failure to the user.
          const rvFailed =
            typeof rv?.status === 'string' && rv.status !== 'success' && rv.status !== 'skipped';
          if (data.state === 'completed' && rvFailed) {
            handleEventRef.current({
              jobId: job.jobId,
              kind: data.name ?? 'job',
              bookGuid: '',
              source: 'manual',
              status: 'failed',
              label: job.label,
              error: String(rv?.reason ?? rv?.status ?? 'Job did not succeed'),
              ts: new Date().toISOString(),
            });
          } else if (data.state === 'completed') {
            handleEventRef.current({
              jobId: job.jobId,
              kind: data.name ?? 'job',
              bookGuid: '',
              source: 'manual',
              status: 'completed',
              label: job.label,
              summary: rv,
              ts: new Date().toISOString(),
            });
          } else if (data.state === 'failed') {
            handleEventRef.current({
              jobId: job.jobId,
              kind: data.name ?? 'job',
              bookGuid: '',
              source: 'manual',
              status: 'failed',
              label: job.label,
              error: data.failedReason ?? 'Job failed',
              ts: new Date().toISOString(),
            });
          } else if (typeof data.progress === 'number' && data.progress > 0) {
            handleEventRef.current({
              jobId: job.jobId,
              kind: data.name ?? 'job',
              bookGuid: '',
              source: 'manual',
              status: 'progress',
              label: job.label,
              percent: data.progress,
              ts: new Date().toISOString(),
            });
          }
        } catch {
          // Poll failures are silent — SSE remains the primary channel.
        }
      }
    }, 7000);
    return () => clearInterval(interval);
  }, [jobs]);

  // Stale-job sweep: anything still non-terminal after 15 minutes is dropped
  // with a neutral note (worker lock/timeout is 5 minutes).
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      for (const job of jobsRef.current) {
        if (
          (job.status === 'pending' || job.status === 'running' || job.status === 'progress') &&
          now - job.startedAt > 15 * 60 * 1000
        ) {
          setJobs((prev) => prev.filter((j) => j.jobId !== job.jobId));
          toast.info(`${job.label}: no longer receiving updates — check the notification bell for the result.`);
        }
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [toast]);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, []);

  const value = useMemo(() => ({ jobs, trackJob, connect }), [jobs, trackJob, connect]);

  return <JobProgressContext.Provider value={value}>{children}</JobProgressContext.Provider>;
}

export function useJobProgress() {
  const context = useContext(JobProgressContext);
  if (!context) {
    throw new Error('useJobProgress must be used within a JobProgressProvider');
  }
  return context;
}

/** Mounted inside the authenticated shell — opens the SSE stream. */
export function JobProgressStream() {
  const { connect } = useJobProgress();
  useEffect(() => {
    connect();
  }, [connect]);
  return null;
}

/** Floating progress cards for jobs the user kicked off this session. */
export function JobProgressToasts() {
  const { jobs } = useJobProgress();
  const visible = jobs.filter((j) => j.status !== 'completed' && j.status !== 'failed');
  if (visible.length === 0) return null;
  return (
    <div className="fixed bottom-20 right-4 z-50 space-y-2 w-80 max-w-[calc(100vw-2rem)]">
      {visible.map((job) => (
        <div
          key={job.jobId}
          className="rounded-lg border border-border bg-surface shadow-lg p-3 space-y-2"
        >
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin shrink-0" />
            <span className="text-sm font-medium text-foreground truncate">{job.label}</span>
            {job.percent !== undefined && (
              <span className="ml-auto text-xs font-mono text-foreground-secondary">
                {Math.round(job.percent)}%
              </span>
            )}
          </div>
          {job.message && (
            <p className="text-xs text-foreground-muted truncate" title={job.message}>
              {job.message}
            </p>
          )}
          <div className="h-1.5 rounded-full bg-background-tertiary overflow-hidden">
            {job.percent !== undefined ? (
              <div
                className="h-full bg-primary rounded-full transition-all duration-500"
                style={{ width: `${Math.max(2, Math.min(100, job.percent))}%` }}
              />
            ) : (
              <div className="h-full w-1/3 bg-primary/60 rounded-full animate-pulse" />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
