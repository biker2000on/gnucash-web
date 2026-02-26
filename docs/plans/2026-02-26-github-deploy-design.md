# GitHub Actions Deploy to TrueNAS Design

**Date:** 2026-02-26
**Status:** Approved

## Goal

Automatically deploy updated Docker containers to a TrueNAS Scale instance when code is merged/pushed to the `main` branch.

## Architecture

```
Push to main → GitHub Actions → Build & push to ghcr.io → Watchtower on TrueNAS polls & restarts
```

### Components

1. **GitHub Actions workflow** — builds Docker image, pushes to ghcr.io
2. **ghcr.io (GitHub Container Registry)** — hosts the image
3. **Watchtower** — runs on TrueNAS, polls ghcr.io every 5 min, auto-updates containers

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Container registry | ghcr.io | Free, integrated with GitHub Actions, GITHUB_TOKEN auth |
| TrueNAS container runtime | Docker Compose | Already configured, straightforward |
| Deploy trigger | Watchtower (polling) | No network tunneling needed, minimal maintenance, simple for personal app |
| Image strategy | Single image, different CMD | One build, one push; worker overrides CMD in compose |
| Tagging | `latest` + git SHA | Watchtower watches `latest`; SHA provides traceability and rollback capability |

## GitHub Actions Workflow

**File:** `.github/workflows/deploy.yml`
**Trigger:** Push to `main` branch

Steps:
1. Checkout code
2. Set up Docker Buildx
3. Login to ghcr.io using built-in `GITHUB_TOKEN`
4. Build and push image tagged as:
   - `ghcr.io/<owner>/gnucash-web:latest`
   - `ghcr.io/<owner>/gnucash-web:<git-sha>`
5. Uses GitHub Actions cache for Docker layer caching

No deploy step — Watchtower handles the pull.

## TrueNAS Docker Compose Changes

### Image references

Switch `app` and `worker` from local `build: .` to:
```yaml
image: ghcr.io/<owner>/gnucash-web:latest
```

### Watchtower service

```yaml
watchtower:
  image: containrrr/watchtower
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
  environment:
    WATCHTOWER_POLL_INTERVAL: 300
    WATCHTOWER_LABEL_ENABLE: "true"
    REPO_USER: ${WATCHTOWER_REPO_USER}
    REPO_PASS: ${WATCHTOWER_REPO_PASS}
  restart: unless-stopped
```

### Container labels

Add to `app` and `worker` services:
```yaml
labels:
  - "com.centurylinklabs.watchtower.enable=true"
```

## Secrets & Environment Variables

### GitHub side
- `GITHUB_TOKEN` — built-in, no configuration needed

### TrueNAS side (`.env` file)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Auth session key |
| `NEXTAUTH_URL` | Public app URL |
| `REDIS_URL` | Set to `redis://redis:6379` in compose |
| `WATCHTOWER_REPO_USER` | GitHub username |
| `WATCHTOWER_REPO_PASS` | GitHub PAT with `read:packages` scope |

## End-to-End Flow

1. Developer pushes/merges to `main`
2. GitHub Actions builds the Docker image
3. Image pushed to ghcr.io with `latest` and SHA tags
4. Watchtower on TrueNAS detects new `latest` within 5 minutes
5. Watchtower pulls new image, restarts app and worker containers
6. Redis container untouched (not from ghcr.io)

## What's NOT Included

- No multi-platform builds (single TrueNAS target)
- No staging environment
- No automated rollback (manual: `docker compose pull` a specific SHA tag)
- No Slack/Discord notifications
- No health checks in compose (can add later)
- No PR build-only step (can add later)

## Files Created/Modified

| File | Action |
|------|--------|
| `.github/workflows/deploy.yml` | **Create** — CI workflow |
| `docker-compose.yml` | **Modify** — add Watchtower, switch to `image:`, add labels |
| TrueNAS `.env` | **Create** (on TrueNAS) — environment variables and Watchtower PAT |
