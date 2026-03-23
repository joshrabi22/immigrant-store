# DECISIONS — IMMIGRANT Store

Technical decisions and the reasoning behind them.

---

## Phase 1 — Taste Profiling

### Image format detection via magic bytes

**Decision:** Detect actual image format from file magic bytes, not file extension.

**Why:** AliExpress serves webp/png with `.jpg` extensions. The Claude API rejects mismatched media types. Magic byte detection (PNG `89 50`, WebP `52 49 46 46`, GIF `47 49 46`) fixed all 34 previously failing images.

---

### Non-clothing item filtering

**Decision:** Filter out non-clothing items (kitchen, electronics, tools) before building the taste profile.

**Why:** 46 out of 122 orders were non-clothing. Without filtering, "accessory" and "plastic" dominated the profile.

---

## Phase 2 — Sourcing & Curation

### Turso cloud database (not local SQLite)

**Decision:** Migrate from better-sqlite3 to @libsql/client. Uses Turso cloud when `TURSO_DATABASE_URL` is set, falls back to local `file:data.db` for development.

**Why:** Railway's filesystem is ephemeral — local SQLite gets wiped on redeploy. Turso provides cloud-hosted SQLite with identical query semantics. One codebase, zero branching — just an env var switches between local and cloud.

---

### Turso HTTP compatibility: no PRAGMA, no datetime(), skip-if-exists

**Decision:** Schema initialization checks if tables exist first (`SELECT COUNT(*) FROM candidates`). If they do, skip all CREATE/ALTER statements entirely. No PRAGMA, no `datetime('now')` defaults, no `executeMultiple`. All columns defined upfront in CREATE TABLE.

**Why:** Turso's HTTP wire protocol is stricter than SQLite — it rejects PRAGMA statements with HTTP 400, doesn't support `executeMultiple`, and has issues with `datetime('now')` in DEFAULT clauses. Since the tables already exist (created during migration), the simplest fix is to not run schema creation at all. Fresh databases get the full CREATE TABLE with all columns; existing databases skip straight to verification.

---

### Server starts before database (crash-proof startup)

**Decision:** Express server starts listening immediately on PORT. Database connects asynchronously in the background. `/api/stats` and `/api/health` return 200 with zeros while DB initializes. All other endpoints return 503 until `dbReady=true`.

**Why:** Railway kills services that fail the healthcheck within 30 seconds. If database connection is slow or fails, the server was never starting and Railway kept restarting it in a loop. Starting the HTTP server first means the healthcheck passes immediately, then the DB connects in the background.

---

### Native modules as optionalDependencies

**Decision:** Moved `better-sqlite3`, `sharp`, and `playwright` to `optionalDependencies` in package.json. Only `@libsql/client`, `express`, `cors`, `dotenv`, and `@anthropic-ai/sdk` are hard dependencies.

**Why:** Native C++ modules (better-sqlite3, sharp) fail to compile on Railway's Docker build environment. Playwright pulls a full Chromium browser (~300MB) that the web server doesn't need. Making them optional means `npm install` succeeds even if they can't build, and the server starts without them. Endpoints that need sharp/playwright gracefully return errors.

---

### Headless Playwright with auto-detection

**Decision:** alistream.js auto-detects: tries CDP first (local Chrome), falls back to headless Playwright (cloud). `RAILWAY_ENVIRONMENT` or `HEADLESS` env var forces headless mode.

**Why:** CDP required a local Chrome window, making the system Mac-dependent. Headless Playwright with stealth settings (webdriver flag removed, real user agent, plugin spoofing) works on Railway 24/7 without any local browser.

---

### Multi-format image URL fallback

**Decision:** Try multiple URL variations (.jpg, .webp, .png, strip .avif wrapper, strip size suffixes) before declaring "no usable image."

**Why:** AliExpress CDN uses dynamic URL patterns. The scraper captures whatever the DOM shows (often a tiny avif thumbnail). Stripping to the base `.jpg` and trying alternatives recovers 80%+ of images.

---

### 3-layer junk filter pipeline (cheapest first)

**Decision:** Filter products in order: title keywords (free) → red banner pixel heuristic (free) → Claude vision yes/no (API cost). Only the vision check costs money.

**Why:** AliExpress feeds contain sale banners, promotional graphics, and non-product images. Title keywords catch "sale", "% off", "discount" etc. instantly. The pixel heuristic catches red/white banner images without API calls. Claude vision only runs on products that passed both cheap filters — saving ~60% of API costs.

---

### Claude vision for gender detection

**Decision:** Assign gender (mens/womens/unisex) using Claude vision on the product image during ingestion.

**Why:** Product titles on AliExpress are unreliable. Vision analysis of cut, styling, and model presentation is far more accurate. Title keywords used as fast fallback for legacy data.

---

### 6 cycle strategies in alistream.js

**Decision:** Rotate through: Homepage → Men's categories → Women's categories → Unisex search → Taste profile keywords → Accessories (jewelry/belts). 30-60s random delay between cycles.

**Why:** Different pages surface different product types. Rotating ensures a diverse mix. Random delays prevent AliExpress from detecting a scraping pattern. The accessories cycle specifically targets jewelry and belts — high-margin categories.

---

### Railway: two services (web + worker)

**Decision:** Deploy as two Railway services: `Dockerfile` (Express + React) and `Dockerfile.worker` (alistream.js with Playwright + Chromium).

**Why:** Different lifecycle needs. Web server: always-on, health checks, serves UI. Worker: continuous scraping loop, high memory (Chromium), independent restarts. Both share the same Turso database.

---

### Edit Suite as full-screen flow (not a tab)

**Decision:** The Edit Suite is a full-screen overlay launched from My Picks, not a permanent tab. Navigation stays SWIPE / MY PICKS / LIVE.

**Why:** The edit flow is sequential (one product at a time, auto-advance on publish/skip) and needs full viewport for the photo editor. Making it a tab would waste space. The overlay pattern keeps tab bar clean while giving maximum editing real estate.

---

### Per-product publish (not bulk)

**Decision:** Products publish individually from the Edit Suite, not in a bulk batch.

**Why:** Each product needs editing — name, description, price, images — before publishing. Per-product publish gives instant feedback and lets you publish as you edit.

---

### Image enhancement: 6-step Sharp.js pipeline

**Decision:** Auto-enhance applies: warm tone correction → gentle contrast → 13% desaturation → subtle sharpening → 800x1000 crop with #F5F2ED padding. Before/after comparison with undo.

**Why:** Every AliExpress product image needs the same treatment to match IMMIGRANT's brand. The 6 steps approximate brand photography post-processing: warm natural light, editorial contrast, muted palette. No external API needed — Sharp.js handles everything locally.

---

### 18 Shopify collections with auto-assignment

**Decision:** Auto-create 18 collections: New In, Men/Women-Tops/Bottoms/Outerwear/Footwear, Mens/Womens/Unisex-Jewelry/Belts, Unisex, Accessories, Archive. Products assigned on publish based on gender + category.

**Why:** Farfetch-style navigation needs structured collections. Auto-assignment means the user never manually sorts products. Category from namer.js, gender from vision classifier.

---

### Image URL fallback in React (imgUrl.js helper)

**Decision:** All React components use a shared `imgUrl(item)` helper that tries local path first, then falls back to AliExpress CDN URL with .avif stripping.

**Why:** On Railway, image files don't exist locally (they were downloaded to the Mac). The CDN fallback means images display correctly on both local dev and cloud deployment without any file syncing.

---

### Brand voice description prompt (exact)

**Decision:** Fixed Claude prompt for product descriptions: "1-3 sentences, describe only the garment, focus on fabric weight/fit/construction, no marketing language, sounds like Celine/Acne Studios/A.P.C."

**Why:** Consistent brand voice across all products. The prompt with examples ("Heavyweight cotton. Dropped shoulders. Washed once.") produces descriptions that match luxury minimalist copy. Editable in Edit Suite if the output needs tweaking.

---

### DSers for fulfillment (not custom integration)

**Decision:** Use DSers Shopify app for AliExpress order fulfillment instead of building a custom fulfillment system.

**Why:** DSers handles the order → AliExpress → tracking pipeline reliably. Building this ourselves would duplicate existing infrastructure. DSers is free for up to 3 stores and integrates directly with Shopify.
