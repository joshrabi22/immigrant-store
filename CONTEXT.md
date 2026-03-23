# CONTEXT — IMMIGRANT Store

## What this project is

IMMIGRANT is a luxury streetwear brand sold via Shopify dropshipping. This codebase is the backend automation system that powers product sourcing, curation, publishing, and content generation.

## Current state: Phase 2 COMPLETE — Cloud-ready

Phase 1 (taste profiling) and Phase 2 (sourcing, curation, publishing) are complete. System is cloud-deployable to Railway + Turso.

### Phase 1 — Taste Profiling (COMPLETE)
- 122 AliExpress orders scraped, 76 clothing items analyzed by Claude vision
- Taste profile: minimal aesthetic, oversized silhouettes, cotton/denim, neutral palette

### Phase 2 — Sourcing, Curation & Publishing (COMPLETE)

**Product Sourcing:**
- AliExpress suggested products scraper (`node scraper.js suggested`)
- CJ Dropshipping API sourcer (`node cj.js`) — keyword search from taste profile
- Past orders seeded into candidates (`node seed-orders.js`)

**Scoring & Curation:**
- Scorer (`node scorer.js`) — Claude vision analysis scored against taste profile on 5 dimensions (aesthetic 30%, color 20%, silhouette 20%, material 15%, style tags 15%). 7+ enters swipe queue.
- Swipe UI (React + Vite) — SWIPE / MY PICKS / LAUNCH tabs
- Namer (`namer.js`) — Claude vision generates 2-3 word brand names, creative color names, size mapping
- Pricer (`pricer.js`) — category-aware pricing bands, 2.5x floor, luxury score adjustment, round to 8 or 0
- Image processor (`images.js`) — remove.bg background removal, sharp normalization to 800x1000, auto-flagging

**Publishing:**
- Shopify publisher (`publisher.js`) — creates products via Admin REST API, brand-voice descriptions, variant setup
- Dead listing monitor (`monitor.js`) — checks CJ product availability, auto-unpublishes dead items

**Storefront:**
- Shopify Liquid theme (`theme/`) — Farfetch-inspired, IMMIGRANT branded, Cormorant Garamond + Helvetica Neue

**Gender + Category Structure:**
- All candidates have `gender` (mens/womens/unisex) and `detected_category` (tops/bottoms/outerwear/footwear/jewelry/belts/accessories)
- alistream.js assigns gender via Claude vision during ingestion; namer.js detects category
- Swipe UI: gender filter buttons (ALL/M/W/U), tappable gender badge + category badge on each card
- 18 Shopify collections: New In, Men/Women-Tops/Bottoms/Outerwear/Footwear, Mens/Womens/Unisex-Jewelry, Mens/Womens/Unisex-Belts, Unisex, Accessories, Archive
- alistream.js has 6 cycle strategies including dedicated jewelry/belt accessory searches
- Theme nav: NEW IN / MEN (dropdown) / WOMEN (dropdown) / UNISEX / ACCESSORIES (dropdown: Jewelry M/W/U, Belts M/W/U, All)

**Cloud Infrastructure:**
- Database: @libsql/client supporting both local SQLite (`file:data.db`) and Turso cloud (`libsql://...turso.io`)
- alistream.js: runs headless Playwright (no local Chrome needed) — detects Railway environment automatically
- Dockerfiles for Railway: `Dockerfile` (web service) and `Dockerfile.worker` (alistream worker)
- Mobile-optimized swipe UI: large touch targets, PWA viewport, safe-area support

### What's not built yet
- Instagram content automation (Phase 4)

## Taste profile findings

Based on 76 clothing items (non-clothing filtered out):

**Dominant aesthetic: MINIMAL (33%)**, followed by other (25%), streetwear (20%), utility (18%), tailored (4%)

**Top colors:** White (#FFFFFF), light grey (#F5F5F5), beige (#F5F5DC), black (#1a1a1a / #000000)

**Top silhouettes:** Oversized (27x), relaxed (19x), fitted (6x), slim (5x)

**Top materials:** Cotton (29x), denim (8x), nylon (7x), leather (5x)

## How to run

```bash
# Setup
npm install
cd client && npm install && npx vite build && cd ..
cp .env.example .env  # Add all API keys

# Phase 1
node db.js                  # Initialize database
./start-chrome.sh           # Launch Chrome with remote debugging
node scraper.js             # Scrape AliExpress orders
node taste-builder.js       # Build taste profile

# Phase 2 — Sourcing
node seed-orders.js         # Seed past orders into candidates
node cj.js                  # Source from CJ Dropshipping
node scraper.js suggested   # Source from AliExpress recommendations

# Phase 2 — Curation
node server.js              # Start API server (http://localhost:3000)
node alistream.js           # Continuous product stream (separate terminal)

# Phase 2 — Publishing
node publisher.js           # Publish all approved products to Shopify
node monitor.js             # Check for dead listings (daily cron)

# Cloud deployment — see DEPLOY.md
# Railway (web + worker) + Turso (cloud SQLite)
```

## Key files

```
# Phase 1
db.js              — Database schema + connection
scraper.js         — AliExpress CDP scraper (orders + suggested mode)
taste-builder.js   — Claude vision taste analysis
start-chrome.sh    — Chrome launcher for CDP

# Phase 2 — Sourcing
cj.js              — CJ Dropshipping product sourcer
seed-orders.js     — Seeds past orders into candidates

# Phase 2 — Scoring & Processing
scorer.js          — Taste profile scoring engine
namer.js           — IMMIGRANT brand name generator
pricer.js          — Category-aware pricing engine
images.js          — Image processor (remove.bg + sharp)

# Phase 2 — Server & UI
server.js          — Express API server
client/            — React + Vite swipe UI

# Phase 2 — Publishing
publisher.js       — Shopify product publisher
monitor.js         — Dead listing monitor

# Phase 2 — Theme
theme/             — Shopify Liquid storefront theme

# Shared
lib/taste.js       — Shared taste profile loader
lib/image-utils.js — Shared image helpers
```

## Database tables

- `orders` — 122 scraped AliExpress orders
- `candidates` — products from all sources, with scores, names, prices, images
- `taste_profile` — aggregated style analysis
- `swipe_decisions` — approve/reject history
- `image_processing` — per-image flags, processed paths, visibility

## Dependencies

- `better-sqlite3` — SQLite driver
- `playwright` — Browser automation (CDP)
- `@anthropic-ai/sdk` — Claude API for vision/text
- `express` + `cors` — API server
- `sharp` — Image processing
- `dotenv` — Environment variables
- `react` + `vite` — Swipe UI (in client/)
