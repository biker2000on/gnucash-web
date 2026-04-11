#!/bin/sh
set -e

# Run the prisma CLI out of the /opt/prisma-cli side-car. NODE_PATH lets
# prisma.config.ts resolve `dotenv` and `prisma/config` out of the side-car
# even though we run from /app so the schema and config paths resolve.
NODE_PATH=/opt/prisma-cli/node_modules node /opt/prisma-cli/node_modules/prisma/build/index.js db push \
  || echo "Warning: prisma db push failed, continuing anyway"

node db-init.js || echo "Warning: db-init failed, continuing anyway"

# Execute the original command
exec "$@"
