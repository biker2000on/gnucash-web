#!/bin/sh
set -e

# Ensure Prisma-managed tables exist
npx prisma db push --skip-generate

# Execute the original command
exec "$@"
