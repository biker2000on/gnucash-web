#!/bin/sh
set -e

# Ensure Prisma-managed tables exist
npx prisma db push

# Execute the original command
exec "$@"
