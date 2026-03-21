# Worker Reliability & Nightly Refresh Fix

**Date:** 2026-03-03
**Branch:** fix/worker-reliability

## Problem Statement

Three confirmed bugs in the background worker system:

1. **Nightly refresh never fires after restart.** `scheduleRefreshPrices()` is only called when the user toggles the Settings UI checkbox. No code re-establishes the BullMQ repeatable job on app/Redis restart, so the schedule is silently lost even though the user preference says "enabled."

2. **Price refresh doesn't reach current date.** `fetchAndStorePrices()` uses `getYesterday()` (yesterday at midnight UTC) as the hard ceiling for `period2` in Yahoo Finance's `chart()` API. When the last stored date is close to yesterday, the narrow window plus exclusive end-date behavior and weekend/holiday gaps means Yahoo returns no data. Result: 0 new prices stored.

3. **Scheduled jobs have no user context.** `scheduleRefreshPrices()` creates repeatable jobs with empty `data: {}`. The worker's `handleRefreshPrices` needs `userId` and `bookGuid` for SimpleFin sync. Scheduled runs never trigger SimpleFin sync.

## Design

### Section 1: Worker-Side Scheduling

Move scheduling authority from the app process to the worker process.

**Current flow:**
- App UI toggle -> `scheduleRefreshPrices()` -> BullMQ repeatable job in Redis
- Worker blindly processes whatever appears in queue
- No startup recovery

**New flow:**
- Worker startup: query DB for all users with `refresh_enabled=true` and their `refresh_interval_hours`
- Worker uses `node-cron` or `setInterval` to schedule price refresh internally
- Worker stores user context (userId, bookGuid) for SimpleFin sync
- App UI toggle: enqueues `schedule-changed` signal job with `{ userId, enabled, intervalHours }`
- Worker receives signal and reconfigures its internal scheduler
- One-off "run now" jobs continue using BullMQ `enqueueJob` unchanged

**Changes to `queues.ts`:**
- Replace `scheduleRefreshPrices()` and `unscheduleRefreshPrices()` with `enqueueJob('schedule-changed', { userId, enabled, intervalHours })`
- Keep `enqueueJob()` for one-off jobs

**Changes to `worker.ts`:**
- On startup: read user preferences from DB, start internal cron schedules
- Handle `schedule-changed` job type: update internal cron based on payload
- When cron fires: execute `handleRefreshPrices` with userId/bookGuid context

### Section 2: Fix Price Refresh Date Range

**Root cause:** `getYesterday()` caps `period2` at yesterday midnight UTC. Yahoo's `chart()` API may use exclusive end dates, and weekends/holidays create gaps where nothing is returned.

**Fix:**
- Use `new Date()` (current time) as `period2` instead of yesterday
- Yahoo Finance's `chart()` endpoint only returns completed daily closes — no risk of intraday data
- Deduplication against existing stored dates (already implemented) prevents duplicates
- Remove `getYesterday()` ceiling from:
  - `fetchAndStorePrices()` in `yahoo-price-service.ts`
  - `detectAndFillGaps()` in `yahoo-price-service.ts`
  - `fetchIndexPrices()` in `market-index-service.ts`
- Keep yesterday calculation only for first-time backfill start date (3 months back)

### Section 3: Worker Reliability Improvements

**A. Job-level timeouts:**
- Add 5-minute timeout to worker job options
- BullMQ marks timed-out jobs as failed automatically

**B. Worker health check:**
- Add HTTP health endpoint using Node's `http` module
- Returns 200 if worker is running, 503 if stalled
- Add `healthcheck` to worker service in `docker-compose.yml`

**C. Redis singleton race condition:**
- `connectionFailed` flag in `redis.ts` can race between retry callback and new instance creation
- Fix: use module-level promise for initialization

**D. Remove cache-aggregations placeholder:**
- `handleCacheAggregations` is a no-op
- Remove job type from worker switch and delete handler file
- Re-add if cache pre-warming is implemented later

**E. Scheduled job user context:**
- Worker-side scheduling (Section 1) naturally solves this
- Cron handler has userId/bookGuid from DB query at startup

## Files Changed

| File | Change |
|------|--------|
| `worker.ts` | Add startup schedule recovery, `schedule-changed` handler, health endpoint, job timeout, remove cache-aggregations |
| `src/lib/queue/queues.ts` | Replace `scheduleRefreshPrices`/`unscheduleRefreshPrices` with `schedule-changed` signal |
| `src/lib/yahoo-price-service.ts` | Replace `getYesterday()` ceiling with `new Date()` for period2 |
| `src/lib/market-index-service.ts` | Same date range fix for `fetchIndexPrices()` |
| `src/lib/redis.ts` | Fix singleton race condition |
| `src/app/api/settings/schedules/route.ts` | Use `schedule-changed` signal instead of direct scheduling |
| `src/lib/queue/jobs/cache-aggregations.ts` | Delete |
| `docker-compose.yml` | Add worker healthcheck |

## Non-Goals

- Investment quantity bug (dollars vs shares) — separate issue, separate PR
- Real-time quotes — design rule says historical closes only
- Multi-user scheduling — single-user app, defer if needed later
