#!/bin/sh
set -e

# Ensure Prisma-managed tables exist
npx prisma db push --accept-data-loss

# Execute the original command
exec "$@"
