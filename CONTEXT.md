# CONTEXT — IMMIGRANT Store

## What this project is

IMMIGRANT is a luxury streetwear brand sold via Shopify dropshipping. This codebase is the full automation system: product sourcing from AliExpress, AI-powered curation, image processing, Shopify publishing, and storefront.

## Current state: DEPLOYED — Railway + Turso

Phase 1 (taste profiling) and Phase 2 (sourcing, curation, publishing) are complete and deployed to the cloud. The system runs 24/7 without a local Mac.

**Live infrastructure:**
- **Web app:** Railway (server.js + React client)
- **Worker:** Railway (alistream.js — continuous AliExpress scraping)
- **Database:** Turso cloud SQLite — 665 candidates migrated
- **Domain:** curate.22immigrant.com (DNS propagating)
- **Shopify:** 22immigrant.myshopify.com with DSers linked
- **Fulfillment:** DSers installed for AliExpress order fulfillment

### Phase 1 — Taste Profiling (COMPLETE)
- 122 AliExpress orders scraped, 76 clothing items analyzed by Claude vision
- Taste profile: minimal aesthetic (33%), oversized silhouettes, cotton/denim, neutral palette
- Profile drives search keywords and scoring rubric

### Phase 2 — Sourcing, Curation & Publishing (COMPLETE)

**Product Sourcing:**
- `alistream.js` — continuous 24/7 AliExpress product stream running on Railway
  - 6 cycle strategies: Homepage, Men's categories, Women's categories, Unisex search, Taste profile keywords, Accessories (jewelry/belts)
  - 3-layer junk filter: title keywords → red banner pixel detection → Claude vision product check
  - Claude vision gender detection (mens/womens/unisex) on every product
  - Multi-format image URL fallback (.jpg, .webp, .png, strip avif/size suffixes)
  - 30-60s random delay between cycles
- `cj.js` — CJ Dropshipping API sourcer (keyword search from taste profile)
- `scraper.js` — AliExpress order history scraper (CDP) + suggested mode

**Curation Flow: SWIPE → MY PICKS → EDIT SUITE → LIVE**

- **SWIPE tab** — one card at a time, Y/N keys or swipe gestures
  - Gender filter buttons (ALL / M / W / U)
  - Tappable gender badge (M/W/U) + category badge (TOP/BTM/OUT/FTW/JWL/BLT/ACC)
  - Undo (Z key, up to 10 steps)
  - Live queue count updates every 5s as alistream adds products
  - Batches of 100

- **MY PICKS tab** — masonry grid of approved products
  - Status dots: grey (saved), sand (edited), black (live)
  - "Start Editing (N unedited)" button
  - Click any card to open in Edit Suite

- **EDIT SUITE** — full-screen per-product editor (launched from My Picks)
  - Queue / Skipped internal tabs with progress bar
  - **Photo editor:** Remove BG (remove.bg API), Auto-enhance (6-step Sharp.js pipeline: warm tone, contrast, desaturate, sharpen, crop 800x1000), before/after comparison, revert to original
  - **Name:** Claude vision auto-generates 2-3 word minimal names + creative color names. Cormorant Garamond display. Regenerate button. Saves on blur.
  - **Description:** Claude auto-generates in brand voice (Celine/Acne Studios/A.P.C. style, 1-3 sentences, no marketing language). Regenerate button. Character count.
  - **Details:** Category dropdown (7 options), gender M/W/U toggle, price field with cost calc, editable color names, size toggles XS-XL
  - **Actions:** Skip for Now (saves + moves to skipped) | Publish to Shopify (immediate, auto-advances)
  - Skipped tab: grid with Resume / Remove buttons

- **LIVE tab** — all published products
  - Green live dot, price, "View on store" link
  - Unpublish button (pulls from Shopify, resets to editing)

**Publishing:**
- `publisher.js` — Shopify Admin REST API, brand-voice descriptions, variant setup
- 18 auto-created Shopify collections: New In, Men/Women-Tops/Bottoms/Outerwear/Footwear, Mens/Womens/Unisex-Jewelry/Belts, Unisex, Accessories, Archive
- Products auto-assigned to correct collections by gender + category
- `monitor.js` — dead listing detector (checks CJ stock, auto-unpublishes)

**Storefront:**
- Shopify Liquid theme (`theme/`) — Farfetch-inspired, IMMIGRANT branded
- Cormorant Garamond Light product names, Helvetica Neue UI
- Full-width hero, clean product grid, hover reveals second image
- Nav: NEW IN / MEN (dropdown) / WOMEN (dropdown) / UNISEX / ACCESSORIES (dropdown: Jewelry M/W/U, Belts M/W/U)
- Mobile first, minimal navigation

**Cloud Infrastructure:**
- Database: `@libsql/client` — Turso cloud (`libsql://immigrant-store-joshrabi.aws-eu-west-1.turso.io`) in production, local `file:data.db` in development
- alistream.js: headless Playwright on Railway, CDP fallback locally
- Dockerfiles: `Dockerfile` (web), `Dockerfile.worker` (alistream)
- `railway.toml` for deployment config
- Image URLs: local path on dev, AliExpress CDN fallback on cloud (via `imgUrl.js` helper)
- Mobile-optimized: PWA viewport, safe-area insets, large touch targets

### Known issues
- DNS for curate.22immigrant.com still propagating — test on Railway URL tomorrow
- Need to verify full swipe → edit → publish flow on Railway
- Image enhancement (Sharp.js) may need platform-specific binary on Railway

### What's next
- Test full flow end-to-end on Railway deployment
- Instagram content automation (Phase 3/4)
- Shopify theme deployment via `shopify theme push`

## Taste profile findings

Based on 76 clothing items (non-clothing filtered out):

**Dominant aesthetic: MINIMAL (33%)**, followed by other (25%), streetwear (20%), utility (18%), tailored (4%)

**Top colors:** White (#FFFFFF), light grey (#F5F5F5), beige (#F5F5DC), black (#1a1a1a / #000000)

**Top silhouettes:** Oversized (27x), relaxed (19x), fitted (6x), slim (5x)

**Top materials:** Cotton (29x), denim (8x), nylon (7x), leather (5x)

## How to run

```bash
# Local development
npm install && cd client && npm install && npx vite build && cd ..
cp .env.example .env  # Add all API keys

node db.js              # Initialize database
node server.js          # Start API server (http://localhost:3000)
node alistream.js       # Continuous product stream (separate terminal)

# Cloud deployment — see DEPLOY.md
# Railway (web + worker) + Turso (cloud SQLite)
# Domain: curate.22immigrant.com
```

## Key files

```
# Database
db.js                — @libsql/client (Turso cloud + local SQLite)
migrate-to-turso.js  — Migration script (local → Turso)

# Product sourcing
alistream.js         — Continuous AliExpress stream (6 strategies, 3 filters, gender detection)
scraper.js           — AliExpress order history scraper
cj.js                — CJ Dropshipping API sourcer

# Processing
scorer.js            — Taste profile scoring engine
namer.js             — AI brand name generator
pricer.js            — Category-aware pricing engine
images.js            — Image processor (remove.bg + sharp)
cleanup.js           — Candidate cleanup (re-filter existing data)

# Server & UI
server.js            — Express API (20+ endpoints)
client/              — React + Vite (SWIPE / MY PICKS / EDIT SUITE / LIVE)
client/src/imgUrl.js — Image URL helper (local path → CDN fallback)

# Publishing
publisher.js         — Shopify product publisher (18 collections)
monitor.js           — Dead listing monitor

# Theme
theme/               — Shopify Liquid storefront theme

# Deployment
Dockerfile           — Railway web service
Dockerfile.worker    — Railway alistream worker
railway.toml         — Railway build config
DEPLOY.md            — Step-by-step deployment guide

# Shared libs
lib/taste.js         — Taste profile loader + search keywords
lib/image-utils.js   — Image download, format detection, multi-URL fallback
```

## Database (Turso cloud)

- `orders` — 122 scraped AliExpress orders
- `candidates` — 665 products with scores, names, prices, images, gender, category, edit state, Shopify IDs
- `taste_profile` — aggregated style analysis (9 key-value pairs)
- `swipe_decisions` — 108 approve/reject decisions
- `image_processing` — per-image flags, processed paths, visibility

## Environment variables

```
ANTHROPIC_API_KEY          — Claude vision + text generation
TURSO_DATABASE_URL         — Turso cloud SQLite
TURSO_AUTH_TOKEN            — Turso auth
SHOPIFY_API_KEY            — Shopify API
SHOPIFY_ACCESS_TOKEN       — Shopify Admin access
SHOPIFY_STORE_URL          — 22immigrant.myshopify.com
CJ_API_KEY                 — CJ Dropshipping
CJ_API_EMAIL               — CJ account email
REMOVEBG_API_KEY           — remove.bg background removal
PORT                       — Server port (default 3000)
RAILWAY_ENVIRONMENT        — Set by Railway (triggers cloud mode)
```
