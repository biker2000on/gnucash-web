#!/bin/sh
set -e

# Ensure Prisma-managed tables exist
npx prisma db push || echo "Warning: prisma db push failed, continuing anyway"
npx tsx scripts/db-init-entrypoint.ts || echo "Warning: db-init failed, continuing anyway"

# Execute the original command
exec "$@"
