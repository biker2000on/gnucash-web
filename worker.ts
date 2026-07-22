/**
 * GnuCash Web Background Worker
 *
 * Processes BullMQ jobs and manages internal refresh schedules.
 * Schedules are book-based: each book with refresh enabled gets its own timer.
 * Exposes HTTP health endpoint on WORKER_HEALTH_PORT (default 9090).
 */

import { Worker, Job } from 'bullmq';
import http from 'http';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

function createWorkerPrisma() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

// --- Internal schedule state ---
interface ScheduleEntry {
  bookGuid: string;
  refreshTime: string; // HH:MM in UTC
  timer: ReturnType<typeof setTimeout> | null;
}

const schedules = new Map<string, ScheduleEntry>(); // keyed by bookGuid
let workerReady = false;

// --- Job progress labels (for the job-progress bus) ---
const JOB_LABELS: Record<string, string> = {
  'refresh-prices': 'Price refresh',
  'backfill-indices': 'Index backfill',
  'audit-price-history': 'Price history audit',
  'sync-simplefin': 'SimpleFin sync',
  'ocr-receipt': 'Receipt OCR',
  'regenerate-thumbnails': 'Thumbnail regeneration',
  'extract-payslip': 'Payslip extraction',
  'extract-statement': 'Statement extraction',
  'run-backups': 'Backup run',
  'check-price-alerts': 'Price alert check',
  'poll-email-ingest': 'Email ingest poll',
  'run-report-schedules': 'Report schedules',
  'run-insights': 'Insights run',
};

// --- SimpleFin interval schedules (independent of the daily price refresh) ---
interface SimpleFinTimerEntry {
  initial: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
}
const simplefinTimers = new Map<number, SimpleFinTimerEntry>(); // keyed by connection id
// Per-connection overlap guard shared by the interval ticks AND the queued
// sync-simplefin handler — two concurrent syncs of one connection would
// double-import (the dedup snapshot is per-run and the meta table has no
// unique constraint on simplefin_transaction_id).
const simplefinSyncInFlight = new Set<number>();

async function runScheduledSimpleFinSync(connectionId: number, bookGuid: string, userId: number) {
  if (simplefinSyncInFlight.has(connectionId)) {
    console.log(`Scheduled SimpleFin sync skipped (connection ${connectionId} already syncing)`);
    return;
  }
  simplefinSyncInFlight.add(connectionId);
  console.log(`[${new Date().toISOString()}] Scheduled SimpleFin sync for connection ${connectionId}`);
  try {
    const { syncSimpleFin } = await import('./src/lib/services/simplefin-sync.service');
    const { jobProgressEmitter } = await import('./src/lib/job-progress');
    const emit = jobProgressEmitter({
      jobId: `scheduled-sf-${connectionId}-${Date.now()}`,
      kind: 'sync-simplefin',
      bookGuid,
      userId,
      source: 'scheduled',
      label: 'SimpleFin sync',
    });
    await emit.running();
    const result = await syncSimpleFin(connectionId, bookGuid, {
      source: 'scheduled',
      onProgress: (p) => void emit.progress(p),
    });
    if (result.status === 'success') {
      await emit.completed({
        status: result.status,
        transactionsImported: result.transactionsImported,
        transactionsSkipped: result.transactionsSkipped,
        investmentTransactionsImported: result.investmentTransactionsImported,
        accountsProcessed: result.accountsProcessed,
        manualReconciliation: result.transactionsMatched.manualReconciliation,
        transferDedup: result.transactionsMatched.transferDedup,
        warnings: result.warnings.length,
      });
    } else {
      await emit.failed(result.errors[0]?.error ?? `Sync ${result.status}`);
    }
    console.log(
      `[${new Date().toISOString()}] Scheduled SimpleFin sync (conn ${connectionId}): ${result.status}, ${result.transactionsImported} imported`,
    );
  } catch (err) {
    console.error(`Scheduled SimpleFin sync failed for connection ${connectionId}:`, err);
  } finally {
    simplefinSyncInFlight.delete(connectionId);
  }
}

function clearSimpleFinTimers() {
  for (const entry of simplefinTimers.values()) {
    if (entry.initial) clearTimeout(entry.initial);
    if (entry.interval) clearInterval(entry.interval);
  }
  simplefinTimers.clear();
}

// Single-flight chain: concurrent rebuild requests (worker concurrency is 3,
// and the settings page can fire two schedule-changed signals back to back)
// must not interleave clear/build and leak orphaned intervals.
let simplefinRebuildChain: Promise<void> = Promise.resolve();

function recoverSimpleFinSchedules(): Promise<void> {
  simplefinRebuildChain = simplefinRebuildChain.then(() => rebuildSimpleFinSchedules());
  return simplefinRebuildChain;
}

/**
 * (Re)build timers for every sync-enabled SimpleFin connection whose owner
 * opted into scheduled sync. Cadence comes from the owner's
 * `simplefin_sync_interval_hours` preference (default 2h). Replaces the old
 * once-a-day piggyback on the price-refresh schedule. The first tick is
 * phase-preserving: it fires at last_successful_sync + interval (min 1
 * minute), so rebuilds and worker restarts don't perpetually defer the sync.
 */
async function rebuildSimpleFinSchedules() {
  clearSimpleFinTimers();

  try {
    const prisma = createWorkerPrisma();
    try {
      const connections = await prisma.gnucash_web_simplefin_connections.findMany({
        where: { sync_enabled: true },
        select: { id: true, book_guid: true, user_id: true, last_successful_sync_at: true },
      });
      const { getPreference } = await import('./src/lib/user-preferences');
      for (const conn of connections) {
        const optedIn = await getPreference<string>(conn.user_id, 'simplefin_sync_with_refresh', 'false');
        if (optedIn !== 'true') continue;
        const intervalRaw = await getPreference<string>(conn.user_id, 'simplefin_sync_interval_hours', '2');
        const intervalHours = Math.max(1, Math.min(24, parseInt(intervalRaw, 10) || 2));
        const intervalMs = intervalHours * 60 * 60 * 1000;

        const lastSync = conn.last_successful_sync_at?.getTime() ?? 0;
        const initialDelay = Math.max(60_000, Math.min(intervalMs, lastSync + intervalMs - Date.now()));

        const entry: SimpleFinTimerEntry = { initial: null, interval: null };
        entry.initial = setTimeout(() => {
          entry.initial = null;
          void runScheduledSimpleFinSync(conn.id, conn.book_guid, conn.user_id);
          entry.interval = setInterval(
            () => void runScheduledSimpleFinSync(conn.id, conn.book_guid, conn.user_id),
            intervalMs,
          );
        }, initialDelay);
        simplefinTimers.set(conn.id, entry);
        console.log(
          `SimpleFin schedule set: connection ${conn.id} every ${intervalHours}h, first run in ${Math.round(initialDelay / 60000)}m (book ${conn.book_guid})`,
        );
      }
      console.log(`Recovered ${simplefinTimers.size} SimpleFin schedule(s)`);
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.error('Failed to recover SimpleFin schedules:', err);
  }
}

// --- Health check server ---
function startHealthServer(port: number) {
  const server = http.createServer((_req, res) => {
    if (workerReady) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', schedules: schedules.size }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'starting' }));
    }
  });
  server.listen(port, () => {
    console.log(`Health check listening on port ${port}`);
  });
  return server;
}

// --- Schedule management ---
async function runRefreshForBook(bookGuid: string) {
  console.log(`[${new Date().toISOString()}] Scheduled refresh for book ${bookGuid}`);
  try {
    const { handleRefreshPrices } = await import('./src/lib/queue/jobs/refresh-prices');
    const fakeJob = { id: `scheduled-${Date.now()}`, name: 'refresh-prices', data: { bookGuid } } as Job;
    await handleRefreshPrices(fakeJob);
    console.log(`[${new Date().toISOString()}] Scheduled refresh completed for book ${bookGuid}`);
    // Fresh prices in hand — evaluate price alerts
    try {
      const { handleCheckPriceAlerts } = await import('./src/lib/queue/jobs/check-price-alerts');
      await handleCheckPriceAlerts({ id: `post-refresh-alerts-${Date.now()}`, name: 'check-price-alerts', data: {} } as Job);
    } catch (err) {
      console.error('Price alert check failed:', err);
    }
  } catch (err) {
    console.error(`Scheduled refresh failed for book ${bookGuid}:`, err);
  }
}

/**
 * Calculate milliseconds until the next occurrence of a given HH:MM (UTC).
 * If the time has already passed today, schedules for tomorrow.
 */
function msUntilNext(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hours, minutes, 0, 0);

  // If the target time has already passed today, schedule for tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - now.getTime();
}

function setSchedule(bookGuid: string, refreshTime: string) {
  clearSchedule(bookGuid);

  function scheduleNext() {
    const ms = msUntilNext(refreshTime);
    const nextRun = new Date(Date.now() + ms);
    console.log(`Next refresh for book ${bookGuid} at ${nextRun.toISOString()} (${refreshTime} UTC)`);

    const timer = setTimeout(async () => {
      await runRefreshForBook(bookGuid);
      // Reschedule for the next day
      scheduleNext();
    }, ms);

    schedules.set(bookGuid, { bookGuid, refreshTime, timer });
  }

  scheduleNext();
  console.log(`Schedule set: book ${bookGuid}, daily at ${refreshTime} UTC`);
}

/** Generic daily schedule — runs a callback at a given UTC time, repeats daily. */
const genericTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setScheduleGeneric(name: string, timeUtc: string, callback: () => Promise<void>) {
  const existing = genericTimers.get(name);
  if (existing) clearTimeout(existing);

  function scheduleNext() {
    const ms = msUntilNext(timeUtc);
    const nextRun = new Date(Date.now() + ms);
    console.log(`[schedule] ${name} next run at ${nextRun.toISOString()} (${timeUtc} UTC)`);

    const timer = setTimeout(async () => {
      await callback();
      scheduleNext();
    }, ms);

    genericTimers.set(name, timer);
  }
  scheduleNext();
}

function clearSchedule(bookGuid: string) {
  const existing = schedules.get(bookGuid);
  if (existing?.timer) {
    clearTimeout(existing.timer);
    schedules.delete(bookGuid);
    console.log(`Schedule cleared: book ${bookGuid}`);
  }
}

/**
 * On startup, query DB for all users with refresh_enabled=true
 * and set up schedules keyed by their book.
 */
async function recoverSchedules() {
  try {
    const prisma = createWorkerPrisma();

    try {
      // Find all users with refresh_enabled = true
      const enabledPrefs = await prisma.gnucash_web_user_preferences.findMany({
        where: { preference_key: 'refresh_enabled', preference_value: 'true' },
        select: { user_id: true },
      });

      for (const pref of enabledPrefs) {
        const timePref = await prisma.gnucash_web_user_preferences.findUnique({
          where: {
            user_id_preference_key: {
              user_id: pref.user_id,
              preference_key: 'refresh_time',
            },
          },
          select: { preference_value: true },
        });

        const refreshTime = timePref
          ? JSON.parse(timePref.preference_value) || '21:00'
          : '21:00';

        // Find books this user has access to (via user_books or all books for admin)
        const firstBook = await prisma.books.findFirst({
          select: { guid: true },
        });

        if (firstBook && !schedules.has(firstBook.guid)) {
          setSchedule(firstBook.guid, refreshTime);
        }
      }

      console.log(`Recovered ${schedules.size} schedule(s) from DB`);
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.error('Failed to recover schedules from DB:', err);
  }
}

// --- Main ---
async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('REDIS_URL environment variable is required');
    process.exit(1);
  }

  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
  };

  const healthPort = parseInt(process.env.WORKER_HEALTH_PORT || '9090', 10);

  console.log('Starting GnuCash Web worker...');
  console.log(`Connecting to Redis at ${url.hostname}:${url.port || 6379}`);

  // Recover schedules from DB before processing jobs
  await recoverSchedules();
  await recoverSimpleFinSchedules();

  const worker = new Worker('gnucash-jobs', async (job: Job) => {
    console.log(`[${new Date().toISOString()}] Processing job: ${job.name} (${job.id})`);
    const startTime = Date.now();

    // Job-progress bus: every job whose payload carries a bookGuid publishes
    // running/completed/failed so the browser can follow along. Jobs without
    // a bookGuid (internal crons) publish nothing.
    const jobData = (job.data ?? {}) as Record<string, unknown>;
    const { jobProgressEmitter } = await import('./src/lib/job-progress');
    const emit =
      typeof jobData.bookGuid === 'string'
        ? jobProgressEmitter({
            jobId: String(job.id),
            kind: job.name,
            bookGuid: jobData.bookGuid,
            userId: typeof jobData.userId === 'number' ? jobData.userId : undefined,
            source: jobData.source === 'manual' ? 'manual' : 'scheduled',
            label: JOB_LABELS[job.name] ?? job.name,
          })
        : null;
    let jobSummary: Record<string, unknown> | undefined;
    await emit?.running();

    try {
      switch (job.name) {
        case 'refresh-prices': {
          const { handleRefreshPrices } = await import('./src/lib/queue/jobs/refresh-prices');
          await handleRefreshPrices(job);
          break;
        }
        case 'backfill-indices': {
          const { backfillIndexPrices } = await import('./src/lib/market-index-service');
          const results = await backfillIndexPrices();
          console.log(`Backfill results:`, results);
          break;
        }
        case 'audit-price-history': {
          const { handleAuditPriceHistory } = await import('./src/lib/queue/jobs/audit-price-history');
          await handleAuditPriceHistory(job);
          break;
        }
        case 'sync-simplefin': {
          const { connectionId, bookGuid, source } = job.data as {
            connectionId: number;
            bookGuid: string;
            userId?: number;
            source?: 'manual' | 'scheduled' | 'refresh' | 'unknown';
          };
          if (simplefinSyncInFlight.has(connectionId)) {
            jobSummary = { status: 'skipped', reason: 'A sync for this connection is already running' };
            console.log(`SimpleFin sync job skipped (connection ${connectionId} already syncing)`);
            break;
          }
          simplefinSyncInFlight.add(connectionId);
          const { syncSimpleFin } = await import('./src/lib/services/simplefin-sync.service');
          let syncResult;
          try {
            syncResult = await syncSimpleFin(connectionId, bookGuid, {
              notifyOnSuccess: source === 'manual',
              source: source || 'unknown',
              onProgress: (p) => {
                void emit?.progress(p);
                if (p.percent !== undefined) void job.updateProgress(p.percent);
              },
            });
          } finally {
            simplefinSyncInFlight.delete(connectionId);
          }
          jobSummary = {
            status: syncResult.status,
            transactionsImported: syncResult.transactionsImported,
            transactionsSkipped: syncResult.transactionsSkipped,
            investmentTransactionsImported: syncResult.investmentTransactionsImported,
            accountsProcessed: syncResult.accountsProcessed,
            manualReconciliation: syncResult.transactionsMatched.manualReconciliation,
            transferDedup: syncResult.transactionsMatched.transferDedup,
            warnings: syncResult.warnings.length,
            errors: syncResult.errors.length,
          };
          console.log(`SimpleFin sync: ${syncResult.status}, ${syncResult.transactionsImported} imported, ${syncResult.transactionsSkipped} skipped, ${syncResult.investmentTransactionsImported} investment txns`);
          if (syncResult.warnings.length > 0) {
            console.warn(`SimpleFin sync warnings:`, syncResult.warnings);
          }
          if (syncResult.errors.length > 0) {
            console.error(`SimpleFin sync errors:`, syncResult.errors);
          }
          if (syncResult.status !== 'success') {
            // Surface the failure on the progress bus, then let the normal
            // return path stand (the service already persisted status +
            // notification).
            await emit?.failed(syncResult.errors[0]?.error ?? `Sync ${syncResult.status}`);
          }
          break;
        }
        case 'simplefin-schedule-changed': {
          await recoverSimpleFinSchedules();
          break;
        }
        case 'schedule-changed': {
          const { bookGuid, enabled, refreshTime } = job.data as {
            userId?: number; // deprecated, kept for backward compat
            bookGuid?: string;
            enabled: boolean;
            refreshTime: string;
          };

          // Resolve bookGuid: use provided value, or look up from DB
          let resolvedBookGuid = bookGuid;
          if (!resolvedBookGuid) {
            const prisma = createWorkerPrisma();
            try {
              const firstBook = await prisma.books.findFirst({ select: { guid: true } });
              resolvedBookGuid = firstBook?.guid;
            } finally {
              await prisma.$disconnect();
            }
          }

          if (resolvedBookGuid) {
            if (enabled) {
              setSchedule(resolvedBookGuid, refreshTime || '21:00');
            } else {
              clearSchedule(resolvedBookGuid);
            }
          }
          break;
        }
        case 'ocr-receipt': {
          const { handleOcrReceipt } = await import('./src/lib/queue/jobs/ocr-receipt');
          await handleOcrReceipt(job);
          break;
        }
        case 'regenerate-thumbnails': {
          const { handleRegenerateThumbnails } = await import('./src/lib/queue/jobs/regenerate-thumbnails');
          const thumbResult = await handleRegenerateThumbnails(job);
          jobSummary = { ...thumbResult };
          console.log(`Thumbnail regeneration: ${thumbResult.regenerated} regenerated, ${thumbResult.skipped} skipped, ${thumbResult.failed} failed`);
          break;
        }
        case 'extract-payslip': {
          const { handleExtractPayslip } = await import('./src/lib/queue/jobs/extract-payslip');
          await handleExtractPayslip(job);
          break;
        }
        case 'extract-statement': {
          const { handleExtractStatement } = await import('./src/lib/queue/jobs/extract-statement');
          await handleExtractStatement(job);
          break;
        }
        case 'check-limit-coverage': {
          const { handleCheckLimitCoverage } = await import('./src/lib/queue/jobs/check-limit-coverage');
          await handleCheckLimitCoverage(job);
          break;
        }
        case 'send-email': {
          const { handleSendEmail } = await import('./src/lib/queue/jobs/send-email');
          await handleSendEmail(job);
          break;
        }
        case 'run-backups': {
          const { handleRunBackups } = await import('./src/lib/queue/jobs/run-backups');
          await handleRunBackups(job);
          break;
        }
        case 'backup-settings-changed': {
          await scheduleBackups();
          break;
        }
        case 'check-price-alerts': {
          const { handleCheckPriceAlerts } = await import('./src/lib/queue/jobs/check-price-alerts');
          await handleCheckPriceAlerts(job);
          break;
        }
        case 'poll-email-ingest': {
          const { handlePollEmailIngest } = await import('./src/lib/queue/jobs/poll-email-ingest');
          await handlePollEmailIngest(job);
          break;
        }
        case 'run-report-schedules': {
          const { handleRunReportSchedules } = await import('./src/lib/queue/jobs/run-report-schedules');
          await handleRunReportSchedules(job);
          break;
        }
        case 'run-insights': {
          const { handleRunInsights } = await import('./src/lib/queue/jobs/run-insights');
          await handleRunInsights(job);
          break;
        }
        case 'compliance-reminders': {
          const { handleComplianceReminders } = await import('./src/lib/queue/jobs/compliance-reminders');
          await handleComplianceReminders(job);
          break;
        }
        case 'dunning': {
          const { handleDunning } = await import('./src/lib/queue/jobs/dunning');
          await handleDunning(job);
          break;
        }
        case 'funding-rules': {
          const { handleFundingRules } = await import('./src/lib/queue/jobs/funding-rules');
          await handleFundingRules(job);
          break;
        }
        case 'renewal-reminders': {
          const { handleRenewalReminders } = await import('./src/lib/queue/jobs/renewal-reminders');
          await handleRenewalReminders(job);
          break;
        }
        default:
          console.warn(`Unknown job type: ${job.name}`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${new Date().toISOString()}] Job ${job.name} (${job.id}) completed in ${elapsed}s`);
      // Non-success sync results already emitted 'failed' above ('skipped'
      // still completes with its reason).
      const alreadyFailed =
        typeof jobSummary?.status === 'string' &&
        jobSummary.status !== 'success' &&
        jobSummary.status !== 'skipped';
      if (!alreadyFailed) await emit?.completed(jobSummary);
      // Return the summary so BullMQ's returnvalue carries the outcome — the
      // /api/jobs/[id] polling fallback reads status from it.
      return jobSummary ?? null;
    } catch (error) {
      console.error(`Job ${job.name} (${job.id}) failed:`, error);
      await emit?.failed(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, {
    connection,
    concurrency: 3,
    lockDuration: 300000, // 5 minute lock (acts as job timeout)
  });

  worker.on('completed', () => {
    // Already logged above
  });

  worker.on('failed', (job, err) => {
    console.error(`[${new Date().toISOString()}] Job ${job?.name} (${job?.id}) FAILED:`, err.message);
  });

  // Schedule nightly thumbnail regeneration at 03:00 UTC
  setScheduleGeneric('thumbnail-regen', '03:00', async () => {
    console.log(`[${new Date().toISOString()}] Running nightly thumbnail regeneration`);
    try {
      const { handleRegenerateThumbnails } = await import('./src/lib/queue/jobs/regenerate-thumbnails');
      const fakeJob = { id: `nightly-thumbs-${Date.now()}`, name: 'regenerate-thumbnails', data: {}, updateProgress: async () => {} } as unknown as Job;
      const result = await handleRegenerateThumbnails(fakeJob);
      console.log(`[${new Date().toISOString()}] Nightly thumbnails: ${result.regenerated} regenerated, ${result.skipped} skipped`);
    } catch (err) {
      console.error('Nightly thumbnail regeneration failed:', err);
    }
  });

  // Scheduled book backups — frequency, hour, and retention are configurable
  // in Settings (gnucash_web_backup_settings); re-scheduled on save via the
  // backup-settings-changed job. Runs at HH:30 of the configured UTC hour;
  // weekly = Sundays, monthly = the 1st.
  const scheduleBackups = async () => {
    try {
      const { getBackupSettings, isBackupDue } = await import('./src/lib/backup');
      const settings = await getBackupSettings();
      const time = `${String(settings.hourUtc).padStart(2, '0')}:30`;
      setScheduleGeneric('scheduled-backups', time, async () => {
        const current = await getBackupSettings();
        if (!isBackupDue(current.frequency, new Date())) return;
        console.log(`[${new Date().toISOString()}] Running scheduled book backups (${current.frequency})`);
        try {
          const { handleRunBackups } = await import('./src/lib/queue/jobs/run-backups');
          const fakeJob = { id: `scheduled-backups-${Date.now()}`, name: 'run-backups', data: {} } as Job;
          await handleRunBackups(fakeJob);
        } catch (err) {
          console.error('Scheduled backups failed:', err);
        }
      });
    } catch (err) {
      console.error('Failed to schedule backups:', err);
    }
  };
  await scheduleBackups();

  // Daily report-schedule delivery at 06:00 UTC (idempotent per period)
  setScheduleGeneric('report-schedules', '06:00', async () => {
    console.log(`[${new Date().toISOString()}] Running due report schedules`);
    try {
      const { handleRunReportSchedules } = await import('./src/lib/queue/jobs/run-report-schedules');
      const fakeJob = { id: `daily-report-schedules-${Date.now()}`, name: 'run-report-schedules', data: {} } as Job;
      await handleRunReportSchedules(fakeJob);
    } catch (err) {
      console.error('Report schedules run failed:', err);
    }
  });

  // Poll the email-ingest mailbox every 15 minutes (no-op unless INGEST_IMAP_* is set)
  const pollIngest = async () => {
    try {
      const { isEmailIngestConfigured, pollEmailIngest } = await import('./src/lib/email-ingest');
      if (!isEmailIngestConfigured()) return;
      const result = await pollEmailIngest();
      if (result.checked > 0) {
        console.log(`[${new Date().toISOString()}] Email ingest: ${result.checked} checked, ${result.ingested} ingested, ${result.skipped} skipped, ${result.errors} errors`);
      }
    } catch (err) {
      console.error('Email ingest poll failed:', err);
    }
  };
  setInterval(() => { void pollIngest(); }, 15 * 60 * 1000);
  void pollIngest();

  // Daily proactive-insights scan at 06:00 UTC
  setScheduleGeneric('daily-insights', '06:00', async () => {
    console.log(`[${new Date().toISOString()}] Running daily insights scan`);
    try {
      const { handleRunInsights } = await import('./src/lib/queue/jobs/run-insights');
      const fakeJob = { id: `daily-insights-${Date.now()}`, name: 'run-insights', data: {} } as Job;
      await handleRunInsights(fakeJob);
    } catch (err) {
      console.error('Daily insights scan failed:', err);
    }
  });

  // Daily compliance-deadline reminders at 06:15 UTC (deduped per
  // user/book/item/period via notification source ids, so re-runs are safe).
  setScheduleGeneric('compliance-reminders', '06:15', async () => {
    console.log(`[${new Date().toISOString()}] Running compliance-deadline reminders`);
    try {
      const { handleComplianceReminders } = await import('./src/lib/queue/jobs/compliance-reminders');
      const fakeJob = { id: `daily-compliance-${Date.now()}`, name: 'compliance-reminders', data: {} } as Job;
      await handleComplianceReminders(fakeJob);
    } catch (err) {
      console.error('Compliance reminders run failed:', err);
    }
  });

  // Daily dunning run at 07:30 UTC (payment reminders for books with dunning
  // enabled; deduped per invoice/level via gnucash_web_dunning_log).
  setScheduleGeneric('dunning', '07:30', async () => {
    console.log(`[${new Date().toISOString()}] Running daily dunning (payment reminders)`);
    try {
      const { handleDunning } = await import('./src/lib/queue/jobs/dunning');
      const fakeJob = { id: `daily-dunning-${Date.now()}`, name: 'dunning', data: {} } as Job;
      await handleDunning(fakeJob);
    } catch (err) {
      console.error('Dunning run failed:', err);
    }
  });

  // Budget auto-funding sweep every 30 minutes: match recent deposits
  // against active funding rules and create envelope sweep transfers.
  // Idempotent — each sweep txn carries num='autofund:<ruleId>:<txGuid>',
  // so re-scanning the rolling window never double-applies.
  const runFundingSweep = async () => {
    try {
      const { handleFundingRules } = await import('./src/lib/queue/jobs/funding-rules');
      const fakeJob = { id: `sweep-funding-${Date.now()}`, name: 'funding-rules', data: {} } as Job;
      await handleFundingRules(fakeJob);
    } catch (err) {
      console.error('Funding-rules sweep failed:', err);
    }
  };
  setInterval(() => { void runFundingSweep(); }, 30 * 60 * 1000);
  void runFundingSweep();

  // Daily renewal reminders at 06:45 UTC (deduped per user/renewal/cycle via
  // notification source ids, so re-runs are safe).
  setScheduleGeneric('renewal-reminders', '06:45', async () => {
    console.log(`[${new Date().toISOString()}] Running renewal reminders`);
    try {
      const { handleRenewalReminders } = await import('./src/lib/queue/jobs/renewal-reminders');
      const fakeJob = { id: `daily-renewals-${Date.now()}`, name: 'renewal-reminders', data: {} } as Job;
      await handleRenewalReminders(fakeJob);
    } catch (err) {
      console.error('Renewal reminders run failed:', err);
    }
  });

  // Weekly IRS contribution-limit coverage check (Mondays 05:00 UTC).
  // setScheduleGeneric fires daily, so gate on the weekday inside the callback.
  const runLimitCoverage = async (trigger: string) => {
    try {
      const { handleCheckLimitCoverage } = await import('./src/lib/queue/jobs/check-limit-coverage');
      const fakeJob = { id: `${trigger}-limit-coverage-${Date.now()}`, name: 'check-limit-coverage', data: {} } as Job;
      await handleCheckLimitCoverage(fakeJob);
    } catch (err) {
      console.error(`Limit coverage check (${trigger}) failed:`, err);
    }
  };
  setScheduleGeneric('limit-coverage', '05:00', async () => {
    if (new Date().getUTCDay() !== 1) return; // only act on Mondays
    console.log(`[${new Date().toISOString()}] Running weekly contribution-limit coverage check`);
    await runLimitCoverage('weekly');
  });
  // Also run once at startup so missing coverage surfaces promptly
  // (deduped against unread notifications, so restarts don't spam).
  void runLimitCoverage('startup');

  workerReady = true;
  const healthServer = startHealthServer(healthPort);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down worker...');
    for (const [bookGuid] of schedules) {
      clearSchedule(bookGuid);
    }
    healthServer.close();
    await worker.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('Worker started, waiting for jobs...');
}

main().catch((err) => {
  console.error('Worker startup failed:', err);
  process.exit(1);
});
