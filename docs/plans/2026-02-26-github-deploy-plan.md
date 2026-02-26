# GitHub Actions Deploy to TrueNAS Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically build and push a Docker image to ghcr.io on push to main, with Watchtower on TrueNAS auto-pulling updates.

**Architecture:** GitHub Actions builds a single Docker image (used by both app and worker with different CMD), pushes to ghcr.io with `latest` + SHA tags. Watchtower on TrueNAS polls ghcr.io every 5 minutes and restarts containers when `latest` changes.

**Tech Stack:** GitHub Actions, Docker Buildx, ghcr.io, Watchtower, Docker Compose

**Repo:** `biker2000on/gnucash-web` → image: `ghcr.io/biker2000on/gnucash-web`

---

### Task 1: Create the GitHub Actions workflow directory

**Files:**
- Create: `.github/workflows/deploy.yml`

**Step 1: Create the workflow file**

```yaml
name: Build and Push Docker Image

on:
  push:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest
            type=sha,prefix=

      - name: Build and push Docker image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

**Step 2: Verify the YAML is valid**

Run: `npx yaml-lint .github/workflows/deploy.yml 2>/dev/null || python -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))" 2>/dev/null || echo "Verify manually"`

**Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add GitHub Actions workflow to build and push Docker image to ghcr.io"
```

---

### Task 2: Update Dockerfile to support worker mode

The current Dockerfile only copies the Next.js standalone output to the runner stage. The worker needs `worker.ts`, source files (for dynamic imports), `tsx`, and runtime dependencies. We overlay the full `node_modules` from the deps stage on top of the standalone output.

**Files:**
- Modify: `Dockerfile`

**Step 1: Add worker support to the runner stage**

After the existing `COPY --from=builder` lines and before `USER nextjs`, add:

```dockerfile
# Worker support: copy worker entry, source files, and full node_modules
# (overlays standalone's minimal node_modules with full set for tsx/bullmq)
COPY --from=builder --chown=nextjs:nodejs /app/worker.ts ./
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
```

The full Dockerfile runner stage should look like:

```dockerfile
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

RUN mkdir .next
RUN chown nextjs:nodejs .next

# Next.js standalone output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Worker support: source files and full node_modules for tsx/bullmq
COPY --from=builder --chown=nextjs:nodejs /app/worker.ts ./
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "server.js"]
```

**Step 2: Test the Docker build locally**

Run: `docker build -t gnucash-web:test .`
Expected: Build completes successfully.

**Step 3: Test app mode**

Run: `docker run --rm -e DATABASE_URL=postgresql://x:x@localhost/x -e NEXTAUTH_SECRET=test -e REDIS_URL=redis://localhost:6379 gnucash-web:test node server.js &`
Expected: Next.js starts (will fail to connect to DB, but the process should start).
Clean up: `docker stop $(docker ps -q --filter ancestor=gnucash-web:test)`

**Step 4: Test worker mode**

Run: `docker run --rm -e REDIS_URL=redis://localhost:6379 gnucash-web:test npx tsx worker.ts &`
Expected: Worker starts and prints "Starting GnuCash Web worker..." (will fail to connect to Redis, but tsx resolves and the process starts).
Clean up: `docker stop $(docker ps -q --filter ancestor=gnucash-web:test)`

**Step 5: Commit**

```bash
git add Dockerfile
git commit -m "build: add worker support to Docker image for single-image deploy"
```

---

### Task 3: Create production Docker Compose for TrueNAS

The existing `docker-compose.yml` builds from source (for local dev). Create a separate production compose file that pulls from ghcr.io and includes Watchtower.

**Files:**
- Create: `docker-compose.prod.yml`

**Step 1: Create the production compose file**

```yaml
# GnuCash Web - Production Docker Compose (TrueNAS)
#
# Uses pre-built images from ghcr.io with Watchtower auto-updates.
#
# Required: Create a .env file with:
#   DATABASE_URL=postgresql://user:password@host:port/database
#   NEXTAUTH_SECRET=<generate with: openssl rand -base64 32>
#   NEXTAUTH_URL=http://<truenas-ip>:3000
#   WATCHTOWER_REPO_USER=<github-username>
#   WATCHTOWER_REPO_PASS=<github-pat-with-read:packages>
#
# Usage:
#   docker compose -f docker-compose.prod.yml up -d
#   docker compose -f docker-compose.prod.yml logs -f

services:
  app:
    image: ghcr.io/biker2000on/gnucash-web:latest
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://redis:6379
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - NEXTAUTH_URL=${NEXTAUTH_URL:-http://localhost:3000}
    depends_on:
      redis:
        condition: service_started
    restart: unless-stopped
    labels:
      - "com.centurylinklabs.watchtower.enable=true"

  worker:
    image: ghcr.io/biker2000on/gnucash-web:latest
    command: ["npx", "tsx", "worker.ts"]
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://redis:6379
    depends_on:
      redis:
        condition: service_started
    restart: unless-stopped
    labels:
      - "com.centurylinklabs.watchtower.enable=true"

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    restart: unless-stopped

  watchtower:
    image: containrrr/watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_POLL_INTERVAL: 300
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_CLEANUP: "true"
      REPO_USER: ${WATCHTOWER_REPO_USER}
      REPO_PASS: ${WATCHTOWER_REPO_PASS}
    restart: unless-stopped

volumes:
  redis-data:
```

**Step 2: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "deploy: add production Docker Compose with Watchtower for TrueNAS"
```

---

### Task 4: Update .env.example with production variables

**Files:**
- Modify: `.env.example`

**Step 1: Add Watchtower variables to .env.example**

Append to the existing `.env.example`:

```
# Watchtower (production only - for auto-updating containers from ghcr.io)
# WATCHTOWER_REPO_USER=your-github-username
# WATCHTOWER_REPO_PASS=ghp_your-personal-access-token-with-read-packages
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add Watchtower env vars to .env.example"
```

---

### Task 5: Push to main and verify end-to-end

This task is manual verification after merging.

**Step 1: Push or merge to main**

Merge the feature branch to main (or push directly if on main).

**Step 2: Verify GitHub Actions**

Go to: `https://github.com/biker2000on/gnucash-web/actions`
Expected: "Build and Push Docker Image" workflow is running/completed.

**Step 3: Verify the image exists on ghcr.io**

Run: `gh api user/packages/container/gnucash-web/versions --jq '.[0].metadata.container.tags'`
Expected: Shows `["latest", "<sha>"]`

**Step 4: Set up TrueNAS**

1. Copy `docker-compose.prod.yml` to your TrueNAS instance
2. Create `.env` alongside it with:
   - `DATABASE_URL` pointing to your PostgreSQL
   - `NEXTAUTH_SECRET` (generate with `openssl rand -base64 32`)
   - `NEXTAUTH_URL` (e.g., `http://192.168.4.132:3000`)
   - `WATCHTOWER_REPO_USER` = your GitHub username
   - `WATCHTOWER_REPO_PASS` = a GitHub PAT with `read:packages` scope
3. Run: `docker compose -f docker-compose.prod.yml up -d`
4. Verify: `docker compose -f docker-compose.prod.yml logs -f`

**Step 5: Test auto-deploy**

1. Make a trivial change on main and push
2. Wait 5 minutes
3. Check Watchtower logs: `docker compose -f docker-compose.prod.yml logs watchtower`
4. Expected: Watchtower reports pulling new image and restarting containers

---

### Summary of Changes

| File | Action | Purpose |
|------|--------|---------|
| `.github/workflows/deploy.yml` | Create | CI workflow: build + push to ghcr.io |
| `Dockerfile` | Modify | Add worker.ts, src, node_modules to runner stage |
| `docker-compose.prod.yml` | Create | Production compose with ghcr.io images + Watchtower |
| `.env.example` | Modify | Add Watchtower env var documentation |
