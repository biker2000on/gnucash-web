#!/bin/sh
set -e

# db-init.js bootstraps an empty database from bootstrap.sql (generated at
# image-build time by `prisma migrate diff --from-empty`) and applies
# idempotent schema sync on existing databases. The prisma CLI is not part
# of the runtime image.
node db-init.js || echo "Warning: db-init failed, continuing anyway"

# Execute the original command
exec "$@"
