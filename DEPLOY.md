# DEPLOY — Railway + Turso Cloud Deployment

## Architecture

```
┌─────────────────────────────────┐
│  Railway: Web Service           │
│  server.js + React client       │
│  curate.22immigrant.com         │
├─────────────────────────────────┤
│  Railway: Worker Service        │
│  alistream.js (24/7 continuous) │
│  Headless Playwright + Chromium │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Turso: Cloud SQLite            │
│  All candidates, swipe data     │
│  Shared by both services        │
└─────────────────────────────────┘
```

## Step 1: Set up Turso Database

1. Sign up at https://turso.tech
2. Install the CLI:
   ```bash
   brew install tursodatabase/tap/turso
   turso auth login
   ```
3. Create the database:
   ```bash
   turso db create immigrant-store
   ```
4. Get the connection URL and token:
   ```bash
   turso db show immigrant-store --url
   turso db tokens create immigrant-store
   ```
5. Save these — you'll need them:
   ```
   TURSO_DATABASE_URL=libsql://immigrant-store-YOUR_ORG.turso.io
   TURSO_AUTH_TOKEN=eyJ...
   ```

## Step 2: Migrate Existing Data to Turso

Run locally with your Turso credentials:

```bash
export TURSO_DATABASE_URL=libsql://immigrant-store-YOUR_ORG.turso.io
export TURSO_AUTH_TOKEN=eyJ...
node db.js  # Creates tables in Turso
```

To copy existing local data, use the Turso CLI:

```bash
turso db shell immigrant-store < data.sql
```

Or export from local SQLite:
```bash
sqlite3 data.db .dump > data.sql
# Edit data.sql to remove CREATE TABLE statements (already created)
turso db shell immigrant-store < data.sql
```

## Step 3: Deploy to Railway

1. Install Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   ```

2. Create a new project:
   ```bash
   railway init
   ```

3. **Deploy Web Service** (server.js + React UI):
   ```bash
   railway up
   ```

4. **Set environment variables** in Railway dashboard:
   ```
   TURSO_DATABASE_URL=libsql://immigrant-store-YOUR_ORG.turso.io
   TURSO_AUTH_TOKEN=eyJ...
   ANTHROPIC_API_KEY=sk-ant-...
   SHOPIFY_API_KEY=shpss_...
   SHOPIFY_ACCESS_TOKEN=shpat_...
   SHOPIFY_STORE_URL=22immigrant.myshopify.com
   CJ_API_KEY=CJ...
   CJ_API_EMAIL=josh@mitlacotton.com
   REMOVEBG_API_KEY=...
   PORT=3000
   ```

5. **Create Worker Service** for alistream.js:
   - In Railway dashboard, click "New Service" in the same project
   - Select "Deploy from GitHub" or "Docker Image"
   - Set the Dockerfile path to `Dockerfile.worker`
   - Or set the start command to: `node alistream.js`
   - Add the same environment variables (especially Turso + Anthropic)
   - Add: `HEADLESS=1` and `RAILWAY_ENVIRONMENT=production`

## Step 4: Custom Domain — curate.22immigrant.com

1. In Railway dashboard, go to your web service
2. Click Settings > Domains > Custom Domain
3. Enter: `curate.22immigrant.com`
4. Railway will show you a CNAME target, something like:
   ```
   curate-22immigrant-com.up.railway.app
   ```

5. In **Namecheap** DNS settings for 22immigrant.com:
   ```
   Type:  CNAME
   Host:  curate
   Value: curate-22immigrant-com.up.railway.app
   TTL:   Automatic
   ```

6. Wait 5-10 minutes for DNS propagation
7. Railway will automatically provision SSL

## Step 5: Verify

- Web UI: https://curate.22immigrant.com
- API: https://curate.22immigrant.com/api/stats
- Worker: Check Railway logs for alistream.js cycle output

## Monitoring

- Railway dashboard shows logs for both services
- Worker logs show cycle progress, products added/filtered
- `/api/stats` endpoint for queue health check

## Cost Estimate

| Service | Cost |
|---------|------|
| Railway web (server.js) | ~$5/month (Hobby plan) |
| Railway worker (alistream.js) | ~$5/month |
| Turso database | Free tier (500 cities, 9GB) |
| Anthropic API (vision checks) | ~$5-15/month depending on volume |
| Total | ~$15-25/month |
