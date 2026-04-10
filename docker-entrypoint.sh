#!/bin/sh
set -e

# Ensure Prisma-managed tables exist (run in background so app starts immediately)
npx prisma db push &

# Execute the original command
exec "$@"
