# CLOUD-DEV — Cloud Development Environment Setup

## Architecture

```
┌─────────────────────────────────────┐
│  Railway: Web Service               │
│  node server.js                     │
│  Express API + React SPA            │
│  Ghost Logic runs inline (no queue) │
│  curate.22immigrant.com             │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Turso: Cloud SQLite                │
│  Single source of truth             │
│  Shared by all environments         │
└─────────────────────────────────────┘

External APIs: Photoroom, Gemini, Claude, Cloudinary
```

## Why This Setup

- **Railway is already deployed** — Dockerfile, railway.toml, and custom domain exist
- **Turso is already provisioned** — cloud SQLite with existing data
- **No Redis needed** — Ghost Logic runs inline via `await processCandidate()` when `REDIS_URL` is absent
- **No separate worker needed** — alistream.js (scraper) is optional for curation workflow
- **One service, one process** — Express serves API + React SPA + runs Ghost Logic in-process
- **Every git push = auto-deploy** — no manual server restarts

## Migration Steps

### Step 1: Commit all local work

```bash
git add -A
git commit -m "canonical state machine, Ghost Logic pipeline, Photo Suite, inline processing"
```

### Step 2: Verify Railway env vars

In Railway dashboard (https://railway.app), ensure these are set on the **web service**:

**Required for curation:**
```
ANTHROPIC_API_KEY=sk-ant-...          # Claude (Stage 3 + product gate)
PHOTOROOM_API_KEY=sk_pr_...           # Stage 1 extraction
REMOVEBG_API_KEY=...                  # Stage 1 fallback
GEMINI_API_KEY=AIza...                # Stage 2 compositing
CLOUDINARY_URL=cloudinary://...       # Processed image hosting
TURSO_DATABASE_URL=libsql://...       # Cloud database
TURSO_AUTH_TOKEN=eyJ...               # Turso auth
PORT=3000                             # Server port
```

**Remove or leave unset:**
```
REDIS_URL        ← REMOVE THIS from Railway env vars
```

Removing `REDIS_URL` makes Ghost Logic run inline (direct `await`) instead of
enqueueing to a BullMQ queue with no listener. This is the same deterministic
path that Block 5B implemented for local dev.

**Optional (not needed for curation):**
```
SHOPIFY_API_KEY=...                   # Only for publishing
SHOPIFY_ACCESS_TOKEN=...
SHOPIFY_STORE_URL=...
CJ_API_KEY=...                        # Only for CJ integration
CJ_API_EMAIL=...
```

### Step 3: Push to GitHub

```bash
git push origin main
```

Railway auto-deploys from the GitHub repo. Build takes ~2-3 minutes.

### Step 4: Verify deployment

```bash
# Health check (Railway domain)
curl https://tender-luck-production-3a77.up.railway.app/api/health

# Counts
curl https://tender-luck-production-3a77.up.railway.app/api/counts

# Open in browser
open https://tender-luck-production-3a77.up.railway.app

# Once custom domain is configured:
# curl https://curate.22immigrant.com/api/health
```

### Step 5: Sync local data to Turso (optional)

If the local SQLite has newer/better data than Turso:

```bash
# Export local data
sqlite3 data.db .dump > data-export.sql

# Import to Turso (review the SQL first — skip CREATE TABLE statements)
turso db shell immigrant-store < data-export.sql
```

Or use the existing migration script:
```bash
node migrate-to-turso.js
```

## Co-Work Workflow

1. **Co-Work edits code** in the mounted workspace folder
2. **Co-Work commits + pushes** via Bash tool: `git add -A && git commit -m "..." && git push`
3. **Railway auto-deploys** (~2-3 min)
4. **Co-Work browses** curate.22immigrant.com via Chrome extension to verify
5. **Co-Work checks API** via JS console or fetch

No manual server restarts. No local Node.js process. No native module issues.

## Image Handling on Railway

- **Processed images**: Cloudinary CDN — works everywhere
- **Unprocessed images**: AliExpress CDN URLs — may be hotlink-blocked
- **Local `images/` directory**: does NOT exist on Railway (ephemeral filesystem)
- `imgUrl.js` falls back to CDN `image_url` when `image_path` file is missing
- Unprocessed items may show broken images — this is acceptable for cloud dev

## Alistream Worker (separate, optional)

The AliExpress scraper (`alistream.js`) runs as a separate Railway service with
`Dockerfile.worker`. It requires Playwright/Chromium. It is NOT needed for the
curation workflow — only for ingesting new items from AliExpress.

To enable: deploy as a second Railway service with the same env vars + `HEADLESS=1`.

## Cost

| Service | Cost |
|---------|------|
| Railway web service | ~$5/month (Hobby plan) |
| Turso database | Free tier (500M rows, 9GB) |
| Cloudinary | Free tier (25 credits/month) |
| API costs (Anthropic + Gemini + Photoroom) | ~$5-15/month |
| **Total** | **~$10-20/month** |
