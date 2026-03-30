# DECISIONS — IMMIGRANT Store
_Last updated: 2026-03-29_

Locked technical decisions and the reasoning behind them.

---

## Infrastructure

### Single-connection local SQLite architecture (db.js)
Local mode uses a single raw `libsql` `Database` instance wrapped in an `execute()` API compatible with `@libsql/client`. Both reads and writes go through the same connection. `stmt.reader` distinguishes SELECT/PRAGMA (→ `all()`) from DML/DDL (→ `run()`). `getRawDb()` returns the same instance — no second handle. This replaced a dual-connection architecture that caused row-level corruption: ALTER TABLE through connection A created columns invisible to connection B's prepared UPDATE statements, causing SQLite row reconstruction to shift values into wrong column positions. Turso cloud path is completely unchanged.

### @libsql/client raw() reader detection bug (documented, bypassed)
`@libsql/client` v0.17.2 `executeStmt()` uses `sqlStmt.raw(true)` to detect whether a statement returns data. But `raw()` on the raw `libsql` driver never throws — it just toggles output format. So `returnsData` is always `true`, DML goes through the reader path, and `rowsAffected` is always 0. The single-connection architecture bypasses this bug entirely by using `stmt.reader` (a native property backed by `statementIsReader`) instead.

### Turso cloud database (not local SQLite) for production
Use @libsql/client. Turso cloud when `TURSO_DATABASE_URL` is set; falls back to local `data.db`. Railway filesystem is ephemeral — local SQLite gets wiped on redeploy.

### Local schema auto-migration via `ensureCandidateColumns`
`initSchema` runs `PRAGMA table_info(candidates)` on every startup and issues `ALTER TABLE ADD COLUMN` for any missing columns. Removes schema drift between local dev and cloud. `CANDIDATE_COLUMNS` array in `db.js` is the single source of truth — add new columns there.

### Turso HTTP compatibility: no PRAGMA in prod, no datetime(), no executeMultiple
Schema initialization checks table existence first. Turso's HTTP wire protocol rejects PRAGMA statements, doesn't support executeMultiple, and has issues with datetime('now') defaults. Columns defined upfront in CREATE TABLE.

### Server starts before database (crash-proof Railway startup)
Express listens immediately. DB connects async. `/api/health` returns 200 while DB initializes. All other endpoints return 503 until `dbReady=true`. Prevents Railway healthcheck kill loop.

### Native modules as optionalDependencies
`better-sqlite3`, `sharp`, `playwright` in optionalDependencies. Fail-to-compile on Railway Docker doesn't break the build.

### Railway: two services (web + worker)
`Dockerfile` (Express + React). `Dockerfile.worker` (alistream.js + Playwright + Chromium). Different lifecycle, different memory needs, shared Turso database.

### Local-first image URLs (imgUrl.js)
Prefer `image_path` (local file served via `/images/` static route) over `image_url` (AliExpress CDN). AliExpress CDN hotlink-protects images loaded from `localhost`, causing broken images throughout intake/staging in local dev. 895 of 897 local candidates have `image_path` set. Falls back to CDN URL on Railway where local files don't exist (ephemeral filesystem). Changed from CDN-first to local-first on 2026-03-29.

---

## State Exposure & Visibility

### PROCESSING_VISIBILITY requires processing_started_at IS NOT NULL
Legacy items have `processing_status='pending'` from the column DEFAULT but were never actually submitted for processing. The `processing_started_at IS NOT NULL` guard distinguishes real pending jobs from legacy column-default artifacts. Both code paths that legitimately set `processing_status='pending'` (POST `/api/staging/:id/process` and POST `/api/processing/:id/retry`) also set `processing_started_at` atomically in the same UPDATE.

### STAGING_VISIBILITY mirrors stale-pending exclusion
Items with `processing_status IN ('pending', 'processing') AND processing_started_at IS NOT NULL` are excluded from Staging (they belong on the Processing page). Items with `processing_status = 'ready'` ARE visible in Staging (with a READY badge) and in the Photo Suite pool.

### PHOTO_SUITE_POOL: stage='staged' AND processing_status='ready' AND review_status IS NULL
Only items that have completed Ghost Logic processing and have not yet been reviewed appear in Photo Suite.

### repair-stale-pending.js for legacy cleanup
Idempotent script that clears `processing_status` on items matching `processing_status='pending' AND processing_started_at IS NULL`. Proven safe by auditing both code paths that set pending status. Confirmed no-op on local DB (2026-03-29) — zero stale-pending items found.

### Legacy corruption repair: null corrupted fields, reset to safe state
For rows with dual-connection column-shift corruption, the repair policy is: null corrupted derived fields (staged_at, all_images, updated_at), reset stage to a valid value (`intake` if the row was never legitimately staged), keep original product data (title, image_url, product_url, price, created_at) intact. Never fabricate values for lost data. Applied to IDs 1043 (null staged_at + all_images) and 1048 (reset to intake, null staged_at + updated_at + all_images).

---

## Scraping & Ingestion

### scraper.js uses async Turso API (not better-sqlite3)
`scraper.js` uses `run()` and `queryAll()` from `db.js` (async `@libsql/client`). The old `db.prepare()` pattern is broken when Turso is configured. All DB calls in scraper are now async.

### Gallery scraping in scraper.js (per-product page visit)
`scrapeSuggestedProducts` finds cards via `.card-out-wrapper` selector, extracts product IDs and canonical URLs. After homepage scrape, `scrapeProductGallery` visits each product page individually to extract `all_images` + `variant_specifics`. Added to INSERT — no upstream mapper or normalization step.

### Gallery junk filtering: 3-layer defense (scraper → shared filter → display)
AliExpress product pages contain 40-65 images per product. Most are page chrome: service badges, trust shields, shipping icons, SKU variant swatches (27x27, 220x220), and thumbnail variants (_480x480q75). Filtering uses three techniques applied at both scraper and display layers:

1. **Cross-product fingerprint blocklist** — 13 known file hashes that appear across 5-145 different products in the DB. These are definitively page chrome (no product image appears in 5+ different products). Hashes extracted via `/kf/([A-Za-z0-9_]+)/` from CDN URLs. Blocklist hardcoded in `galleryFilter.js`, `scraper.js`, and `alistream.js`.
2. **Structural URL patterns** — small thumbnails (`_NNxNN`), pixel icons (`/NNxNN.png`), quality-suffixed variants (`_480x480q75.jpg`), non-CDN URLs, data URIs.
3. **Keyword patterns** — `icon|sprite|logo|star|rating|arrow|button|banner|placeholder`.

Applied at: scraper.js/alistream.js (before DB write), `client/src/lib/galleryFilter.js` (shared display utility), component level (PhotoSuiteReviewCard, StagingCard, StagingDetailPage). Result: 47-65 raw → 3-7 product images per item. Remaining 1-2 non-product images per item (brand logos, size charts) are seller-uploaded listing content in `imagePathList` — would need vision-based classification to remove.

### Product URLs normalized to www.aliexpress.com
Scraped hrefs resolve to locale-specific URLs (e.g. `he.aliexpress.com`). Normalized to `https://www.aliexpress.com/item/{id}.html` before DB write to avoid locale redirect failures in the gallery scraper.

### Price parsing guards against NaN/Infinity
`parseFloat` on stripped price strings can produce `NaN` (e.g. from `"."` after stripping non-numeric chars from shipping labels). `isFinite(parsed)` guard before accepting. `safePrice` variable in INSERT prevents Turso binding error. Class-based price selectors tried first; `[aria-label*="."]` is fallback only.

### 3-layer junk filter (cheapest first)
Title keywords → red banner pixel heuristic → Claude vision. Vision only runs on products that passed both cheap filters.

### Claude vision for gender detection
AliExpress titles are unreliable. Vision analysis of cut, styling, and model presentation is more accurate. Title keywords as fast fallback.

### Headless Playwright with auto-detection (alistream.js)
Tries CDP first (local Chrome), falls back to headless. `RAILWAY_ENVIRONMENT` or `HEADLESS` forces headless. 24/7 scraping on Railway without local browser dependency.

### 6 cycle strategies in alistream.js
Rotate: Homepage → Men's → Women's → Unisex search → Taste profile keywords → Accessories. 30-60s random delay between cycles.

---

## Ghost Logic Pipeline

### Ghost Logic: 3-stage cloud pipeline
Stage 1: Photoroom/remove.bg extraction → Cloudinary. Stage 2: Gemini 2.5 Flash Image compositing (studio lighting + shadow). Stage 3: Claude naming (2-word + 1-sentence). Replaces the Sharp.js local pipeline which couldn't run on Railway.

### Photoroom is Stage 1 primary; remove.bg is fallback
Photoroom produces higher quality fashion cutouts. `bg_color` must be sent as `#F5F2ED` (with `#` prefix) — Photoroom returns 400 without it. remove.bg accepts bare hex `F5F2ED`.

### Stage 1 throws on failure — no raw-original fallback
`extractProduct()` throws when no API succeeds. The old fallback that uploaded raw originals to Cloudinary silently contaminated `processed_images` with junk. Per-image try/catch in `processCandidate()` catches throws gracefully; all-images-failed triggers `processing_status = 'failed'` (retryable).

### MAX_STAGE1_IMAGES and MAX_STAGE2_IMAGES caps
Both default to `3` (env-configurable). Overflow images (index >= cap) dropped entirely — no API quota burned, no raw originals stored. The premium set is the first 3 images. `processed_images` contains only pipeline-processed URLs.

### Gemini Stage 2: retry on 429 and text-only responses
Up to 3 total attempts (MAX_RETRIES = 2). Text-only retry with 5s delay, 429 retry with 20s delay. Same `_retryCount` counter. Prompt includes "You MUST return an edited version of this image" and "Return ONLY the image, no text". If all retries fail, passthrough to Stage 1 result (non-fatal).

### Stage 2 passthrough on failure (not throw)
Unlike Stage 1, Stage 2 failure is non-fatal — returns Stage 1 result. A Stage-1-only output is still usable (clean background, Cloudinary-hosted). Stage 1 failure is fatal.

### Ghost Logic auto-trigger on swipe approve
BullMQ job queued automatically on approve. Queue failure caught silently — swipe never breaks. Direct mode (`--direct <id>`) for manual processing without Redis.

### Cloudinary for all Ghost Logic output
Binary image data from APIs needs hosting. Cloudinary provides CDN URLs, format optimization, Railway-compatible (no local filesystem). `processed_image_url` (hero) + `processed_images` (full premium set) saved to DB.

### Worker debug logging for corruption detection
Final success UPDATE in `processCandidate()` logs SQL, all parameter indices with column labels. `directProcess()` verification checks all 12 critical columns with corruption detectors (non-ISO timestamps, stage not in valid set). This logging is retained as a diagnostic safety net.

---

## Curation & Workflow

### Processing status gates the workflow
`pending → processing → ready → Photo Suite`. Items with `processing_status IN ('pending','processing')` AND `processing_started_at IS NOT NULL` route to Processing page. Photo Suite shows only `ready`.

### COALESCE in /api/counts staging query (NULL-safe exclusion)
The staging count query uses `NOT (... AND ...)` patterns to exclude processing-queue and Photo Suite items. SQL NULL semantics require COALESCE wrappers: `NOT (NULL_expr AND TRUE)` evaluates to NULL (not TRUE), silently excluding rows where `processing_status` is NULL. Both NOT conditions now use `COALESCE(processing_status, 'none')`, matching the pattern already used in `STAGING_VISIBILITY`. Without this fix, 32 of 34 staging items were invisible to the badge count.

### IntakeGrid optimistic removal with undo and refetch
Approve/reject removes items from UI immediately with 5s undo window. After commit, `load()` refetches the list from server and `refresh()` updates sidebar badge counts. Both called on success and error.

### SKU Splitter: two-tap confirm + parent gallery cleanup
Split via two-tap (arm → confirm, auto-disarm 3s). On split: image removed from parent `all_images`, child row created with `variant_specifics` JSON (color property ID + sizes), `is_split_child=1`, `parent_id` set.

### Single-item Ghost Edit (not just batch swipe)
Ghost Edit per card in My Picks opens Deep Edit drawer. Separate from Photo Suite batch flow. Needed for surgical edits (name fix, gallery curation, variant split) without running the full swipe queue.

### Per-product publish (not bulk)
Products publish individually from Edit/Launch surfaces. Each needs editing before publish. Instant feedback per item.

### DSers for fulfillment
Order → AliExpress → tracking via DSers Shopify app. Not custom-built. Free for ≤3 stores.

### PhotoSuitePage.jsx is the canonical Photo Suite component
`PhotoSuitePage.jsx` (in `client/src/pages/review/`) is the routed component at `/review/photo-suite`. It uses `lib/api.js` endpoints. `PhotoSuite.jsx` (in `client/src/components/`) is dead code that references a nonexistent `/api/photo-suite/queue` endpoint — it is NOT routed in App.jsx.

---

## Design

### Surface design tiers
- **Merchandising (Approved, Launch, Live):** editorial, image-led, spacious
- **Operational (Staging, Processing):** clean, workbench-oriented, function-first

### FoundCo grid aesthetic
3-column CSS Grid, 40px gap, 4:5 aspect ratio, `object-fit: contain` on #F5F2ED. Product info left-aligned below image. Actions hidden until hover.

### Brand voice: Minimalist, Luxury, Unbothered, Studio-quality
1-3 sentences. Present tense. Declarative. Physical garment only. No marketing language. No exclamation marks.

### Product naming: lowercase, bone/slate/moss palette
2-word names, always lowercase. "bone" not "white", "slate" not "grey", "moss" not "green".

### Naming/SKU system: deterministic premium structure
`{Adjective} {4-digit code} {Type}` / `{TYPE-3}{ADJ-3}{4-digit}`. SKU encodes the name, name encodes the SKU. Split children add suffix (`2345-1`, `2345-2`). Implementation deferred to post-workflow-stability refinement pass.

### Build sequence: function first, then polish
Functional completion of each surface before visual refinement. Polish pass after workflow stability covers: naming/SKU implementation, Approved/Launch/Live editorial presentation, gallery interactions, stronger merchandising layouts.

### Merchandising enhancements: future refinement
"Sold out" visual treatments and model-led product presentation are desired but deferred. Require additional source data or Shopify state management.

---

## Operations

### CHECKPOINT.md as thread handoff
Live execution snapshot — verified state, blockers, next action, active commands. Update before starting a new thread.

### Post-pipeline sequencing: ingestion → quality → Photo Suite
Multi-image ingestion first (done), then image quality baseline definition, then Photo Suite UX refinement.

---

## Product Constraints _(Future-Facing — Do Not Implement Yet)_

> These are locked product-level decisions that constrain future build direction. None require implementation now.

### Pulls is a core system constraint, not a feature
Pulls is not an optional feature or a variant of a traditional cart. It is the primary first-interaction layer between customer discovery and purchase commitment. Any future customer-facing surface must be designed around Pulls as the central mechanic.

### Pulls replaces the cart as the first interaction layer
The traditional "Add to Cart" pattern is explicitly not used. The first customer action is always "Add to Pulls" — a low-commitment, stylist-like gesture. The path from Pulls to purchase is a separate, deliberate step.

### Pulls is a pre-decision collection system
Pulls is where customers hold items they're considering — not items they've decided to buy. The system should support browsing, comparing, and reconsidering before any purchase intent is expressed.

### Language must stay non-transactional and stylist-like
No "Add to Cart", "Buy Now", "Checkout", "Deal", "Sale", "Save X%". Language across all surfaces — internal and customer-facing — should feel like a stylist curating a wardrobe, not a retailer moving inventory. Examples: "Add to your pulls", "Your pulls", "Move to bag" (only when ready to commit).

### The brand must feel premium, editorial, and never like a cluttered marketplace
At every touchpoint — image quality, copy, layout, interaction design — the experience must read as a premium fashion brand. Not a dropshipping operation. Not a marketplace. Not Amazon. The Ghost Logic pipeline exists to enforce this at the asset level; the product design enforces it at the experience level.
