# Deployment Rollback

Production images are published with the full Git commit SHA. The TrueNAS
Dockhand stack reads `IMAGE_REPOSITORY` and `IMAGE_TAG` from its regular
environment and applies the same image to the web and worker services. New
releases use `ghcr.io/biker2000on/gnucash-web-app`; releases predating the
2026-08-05 package-access migration remain in the legacy
`ghcr.io/biker2000on/gnucash-web` package.

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

After the cause is corrected, deploy a new immutable SHA and repeat the health
checks. Move `IMAGE_TAG` away from the rollback SHA only after that verification.
