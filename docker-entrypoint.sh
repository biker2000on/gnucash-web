#!/bin/sh
set -e

# db-init.js bootstraps an empty database from bootstrap.sql (generated at
# image-build time by `prisma migrate diff --from-empty`) and applies
# idempotent schema sync on existing databases. The prisma CLI is not part
# of the runtime image.
# A non-zero exit means the schema is half-migrated (missing views, missing
# unique indexes). Starting the app anyway would serve traffic against it and
# silently lose the idempotency guarantees the import paths depend on, so fail
# the container and let the orchestrator restart/alert instead.
# `set -e` above already aborts on failure; this makes the intent explicit.
if ! node db-init.js; then
    echo "FATAL: db-init failed - refusing to start the application on a half-migrated schema" >&2
    exit 1
fi

# Execute the original command
exec "$@"
