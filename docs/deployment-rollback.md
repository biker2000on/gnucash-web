# Deployment and Rollback

Production images are published with the full Git commit SHA. The TrueNAS
Dockhand stack reads `IMAGE_REPOSITORY` and `IMAGE_TAG` from its regular
environment and applies the same image to the web and worker services. New
releases use `ghcr.io/biker2000on/gnucash-web-app`; releases predating the
2026-08-05 package-access migration remain in the legacy
`ghcr.io/biker2000on/gnucash-web` package.

## How a deploy reaches production

A push to `main` runs `.github/workflows/deploy.yml`: tests and lint gate the
build, the image is pushed to GHCR, and only then does the workflow advance the
**`deploy` branch** to that commit. Dockhand watches `deploy` (not `main`) and
syncs it every five minutes; when the branch moves it pulls the new image and
recreates the stack. The workflow's last step polls
`https://cash.adventureintandem.com/api/health` until `revision` matches the
pushed commit, so a deploy that never lands turns the build red instead of
passing silently. Expect production to update within roughly 5-10 minutes.

Two details are deliberate and worth preserving:

- **The branch advances only after the image exists.** Dockhand triggers on a
  commit change, so watching `main` would race the build and deploy the
  *previous* image — then record the commit as done and never retry.
- **The deploy runs in Dockhand's background scheduler, not in an HTTP
  request.** The earlier design POSTed a webhook that ran the deploy inside the
  request; the pull and recreate exceed Cloudflare's 100-second limit, so the
  dropped connection killed the deploy mid-flight while the retry reported
  success (the commit had already synced). Deploys silently never reached
  production. Do not reintroduce a request-scoped deploy trigger.

If a deploy fails, Dockhand has already recorded the commit and will not retry
it. Deploy by hand on the TrueNAS host, using Dockhand's own command:

```bash
cd /mnt/docker/volumes/dockhand/stacks/Truenas/gnucash-web-prod && docker compose -p gnucash-web-prod -f docker-compose.prod.yml --env-file .env.dockhand up -d --remove-orphans --force-recreate
```

## Before deployment

1. Record the currently healthy image SHA from the running web and worker
   containers.
2. Confirm the PostgreSQL backup completed and is restorable.
3. Keep the prior SHA until the new deployment passes both health checks and a
   login smoke test.

## Roll back to the previous image

1. In Dockhand, open the GnuCash Web stack and set `IMAGE_TAG` to the full
   previously healthy commit SHA. Do not use `latest` during a rollback. When
   rolling back to a release older than the 2026-08-05 package migration, also
   set `IMAGE_REPOSITORY=ghcr.io/biker2000on/gnucash-web`; otherwise leave it
   unset so the compose default selects the repository-owned package.
2. Deploy/recreate the stack and wait for both the web and worker containers to
   report healthy.
3. Verify `/api/health`, login, account loading, and the worker health endpoint.
4. Inspect web and worker logs for database-migration or queue errors.

If the release included a database change, prefer a forward application fix.
Startup migrations are recorded in `gnucash_web_schema_meta`, and rows removed
or normalized by the audited migrations are retained in
`gnucash_web_migration_backups`. Restore PostgreSQL only when a forward fix is
unsafe, using the pre-deployment backup and an approved maintenance window.

While `IMAGE_TAG` is pinned, every subsequent push to `main` still advances the
`deploy` branch and triggers a redeploy, and that redeploy reapplies the pinned
old SHA. New commits will look like they built and shipped while production
keeps running the rollback image — though the workflow's verification step now
catches this, because `/api/health` keeps reporting the rollback revision and
the build goes red. `IMAGE_TAG` must be cleared or moved forward before any new
deployment takes effect.

After the cause is corrected, deploy a new immutable SHA and repeat the health
checks. Move `IMAGE_TAG` away from the rollback SHA only after that verification.
