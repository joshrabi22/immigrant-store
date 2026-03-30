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
  - Full gallery + SKU variant map scraping (imagePathList, skuPropertyImagePath, skuPropIds → sizes)
  - 30-60s random delay between cycles
- `cj.js` — CJ Dropshipping API sourcer (keyword search from taste profile)
- `scraper.js` — AliExpress order history scraper (CDP) + suggested mode

**Curation Flow: SWIPE → MY PICKS → GHOST LOGIC → PHOTO SUITE → LAUNCH → LIVE**

- **SWIPE tab** — Tinder-style Y/N cards with gender filter (M/W/U), undo (Z), category badges
  - Approve auto-triggers Ghost Logic (BullMQ queue)

- **MY PICKS tab** — FoundCo-style 3-column grid (40px gap, 4:5 aspect)
  - ✦ Ghost Edit button on every card → opens Deep Edit drawer for single item
  - Checkboxes for multi-select + "batch process selected" button
  - "start photo suite" button for full swipe review
  - Green "AI" badge on processed items. Items with `processing_status='processing'` hidden.
  - × remove button on every card

- **Deep Edit Drawer** — bottom sheet (Framer Motion + AnimatePresence)
  - @dnd-kit sortable photo gallery grid (drag to reorder, first = hero)
  - × delete button on every thumbnail (persists to Turso)
  - ⑂ purple SKU Split button (two-tap: tap 1 = arm green, tap 2 = execute, auto-disarm 3s)
    - Creates child listing with variant_specifics JSON for fulfillment routing
    - Removes split image from parent gallery in both UI and Turso
    - Green toast: "split into new listing"
  - "Fetch Gallery" button when gallery empty (rescrapes AliExpress product page)
  - "Process Curated Gallery" button → queues Ghost Logic, item disappears from Picks
  - Name editor (Cormorant Garamond, lowercase), auto-regen description, price with roundTo80, category dropdown

- **Ghost Logic Pipeline** (auto or manual, background worker)
  - Stage 1: Extraction (Photoroom / remove.bg → Cloudinary upload)
  - Stage 2: Compositing (Gemini 3 Flash — studio lighting, contact shadow, #F5F2ED)
  - Stage 3: Naming (Claude — 2-word lowercase, bone/slate/moss palette + 1-sentence description)
  - Results → Turso: processed_image_url, edited_name, edited_description, processing_status='ready'

- **Photo Suite** — Framer Motion card stack (only items where processing_status='ready')
  - Swipe right → launch bucket, swipe left → reject, tap → Deep Edit
  - Peek cards, swipe indicators, stats counter

- **Launch Bucket** — FoundCo grid, "publish all to shopify" button, individual publish on hover, progress bar
  - Published items get grey "LIVE" badge, move to Live tab

- **LIVE tab** — published products grid with "view on store" + unpublish

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

**Turso compatibility fixes (2026-03-24):**
- Removed all PRAGMA statements from db.js (Turso HTTP returns 400)
- Removed `datetime('now')` defaults (not supported over Turso wire protocol)
- Removed ALTER TABLE column migrations — all columns defined upfront in CREATE TABLE
- Added early-exit: if tables exist, skip schema creation entirely
- `better-sqlite3`, `sharp`, `playwright` moved to optionalDependencies (native modules crash Railway builds)
- Server starts BEFORE database connects — healthcheck `/api/stats` returns 200 with zeros while DB initializes
- `/api/health` endpoint for debugging — always returns 200 with `dbReady` status

### Deployment status (2026-03-24)
- **Railway web service:** LIVE — server starts, healthcheck passes, Turso connected, 665 candidates confirmed
- **Railway worker (alistream.js):** Running 24/7, headless Playwright
- **Turso database:** Connected with fresh credentials, 665 candidates (495 new, 29 approved, 141 rejected)
- **curate.22immigrant.com:** DNS configured at Namecheap, still propagating
- **All env vars:** Set correctly in Railway (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, ANTHROPIC_API_KEY, SHOPIFY_*, CJ_*, REMOVEBG_API_KEY)
- **DSers:** Installed and linked to Shopify for AliExpress fulfillment

**Ghost Logic Pipeline (activated 2026-03-24):**
- 3-stage image processing: Extraction (Photoroom/remove.bg) → Compositing (Gemini 3 Flash) → Naming/Copy (Claude)
- All processed images uploaded to Cloudinary CDN (`server/lib/cloudinary.js`)
- Auto-triggered on swipe approve — BullMQ queues job, worker processes async
- Direct mode for testing: `node server/workers/ghostLogicWorker.js --direct <id>`
- Claude generates 2-word lowercase names (bone/slate/moss palette) + 1-sentence unbothered descriptions
- Results saved to Turso: `processed_image_url`, `edited_name`, `edited_description`, `processing_status`

**Photo Suite (replaces Edit Suite):**
- Tinder-style card stack (Framer Motion) for reviewing Ghost Logic processed items
- Swipe right → launch bucket, swipe left → reject, tap → Deep Edit drawer
- Deep Edit: @dnd-kit sortable photo grid, name editor (Cormorant Garamond), auto-regen description, price with roundTo80, category dropdown
- Launch Bucket: 3-column FoundCo grid (40px gap, 4:5 aspect, hover scale 1.02x), publish all to Shopify

**UI Design (FoundCo aesthetic):**
- Header: IMMIGRANT logo (Cormorant Garamond, 1.8rem, letter-spacing 0.4em) + nav (SWIPE/PICKS/LAUNCH/LIVE at 11px)
- Product grids: 3 columns, 40px gap, 4:5 portrait, left-aligned name + price below image
- Names: Cormorant Garamond 300, 1.1rem, lowercase
- Prices: Helvetica Neue 400, 0.9rem, #6B6B6B
- Hover: subtle 1.02x scale, action buttons revealed on hover only

### Deployment status (2026-03-24)
- **Railway web service:** LIVE
- **Railway worker:** LIVE (alistream.js 24/7)
- **Turso database:** 665 candidates, fresh read-write token
- **Cloudinary:** Needs CLOUDINARY_URL in .env
- **curate.22immigrant.com:** DNS configured

### What's next
- Add CLOUDINARY_URL + GEMINI_API_KEY to activate full Ghost Logic pipeline
- Test end-to-end: swipe → Ghost Logic → Photo Suite → Launch Bucket → Shopify
- Instagram content automation
- Shopify theme push

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
namer.js             — AI brand name generator (2-3 words, lowercase, bone/slate/moss palette)
pricer.js            — Category-aware pricing engine
images.js            — Ghost Logic image pipeline (Photoroom → Gemini → Claid.ai)
cleanup.js           — Candidate cleanup (re-filter existing data)

# Ghost Logic pipeline
server/workers/ghostLogicWorker.js — 3-stage pipeline (extraction → compositing → naming)
server/lib/cloudinary.js           — Cloudinary upload helper

# Server & UI
server.js            — Express API (30+ endpoints, Photo Suite, Launch Bucket, Ghost Logic queue)
client/              — React + Vite + Framer Motion + dnd-kit
client/src/imgUrl.js — Image URL helper (CDN-first, local fallback)
client/src/components/PhotoSuite.jsx    — Tinder-style card review (Framer Motion)
client/src/components/DeepEditDrawer.jsx — Bottom sheet editor (dnd-kit sortable photos)
client/src/components/LaunchBucket.jsx   — FoundCo-style publish grid
client/src/components/LiveTab.jsx        — Published products grid

# Publishing
publisher.js         — Shopify publisher (processed_image_url → Shopify, 18 collections)
monitor.js           — Dead listing monitor

# Theme
theme/               — Shopify Liquid storefront theme

# Deployment
Dockerfile           — Railway web service
Dockerfile.worker    — Railway alistream worker
railway.toml         — Railway build config
DEPLOY.md            — Deployment guide

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
PHOTOROOM_API_KEY          — Photoroom background removal (Ghost Logic Stage 1)
REMOVEBG_API_KEY           — remove.bg (Stage 1 fallback)
GEMINI_API_KEY             — Gemini 3 Flash compositing (Ghost Logic Stage 2)
CLAID_API_KEY              — Claid.ai texture sharpening (future)
CLOUDINARY_URL             — Cloudinary image hosting (Ghost Logic output)
REDIS_URL                  — BullMQ queue (Ghost Logic auto-processing)
PORT                       — Server port (default 3000)
RAILWAY_ENVIRONMENT        — Set by Railway (triggers cloud mode)
```
