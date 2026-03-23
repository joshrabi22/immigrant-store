# DECISIONS — IMMIGRANT Store

Technical decisions and the reasoning behind them.

---

## Phase 1

### SQLite over Postgres

**Decision:** Use SQLite via `better-sqlite3` for all data storage.

**Why:** Single-user local tool. No need for a database server. WAL mode handles concurrent reads from the server and CLI scripts.

---

### CDP connection to real Chrome (not Playwright-launched browser)

**Decision:** Connect to the user's real Chrome via DevTools Protocol instead of launching a Playwright-controlled browser.

**Why:** AliExpress aggressively detects Playwright-launched browsers. CDP connection to a real Chrome with `--remote-debugging-port=9222` avoids all bot detection.

---

### Image format detection via magic bytes

**Decision:** Detect actual image format from file magic bytes, not file extension.

**Why:** AliExpress serves webp/png with `.jpg` extensions. The Claude API rejects mismatched media types.

---

### Non-clothing item filtering in aggregation

**Decision:** Filter out non-clothing items before building the taste profile.

**Why:** 46 out of 122 orders were non-clothing. Without filtering, "accessory" and "plastic" dominated — skewing the fashion profile.

---

## Phase 2

### Dual-mode scripts (CLI + importable)

**Decision:** All processing scripts (namer, pricer, images, publisher) work both as standalone CLI tools and as importable modules called by the Express server.

**Why:** CLI mode allows testing and batch processing. Import mode lets the server call them on demand from the swipe UI. The `require.main === module` pattern (already used in db.js) provides this cleanly.

---

### CJ Dropshipping API with token caching

**Decision:** Cache the CJ API access token to `.cj-token.json` with a 14-day TTL.

**Why:** CJ only allows token requests once every 5 minutes. Caching avoids rate limits across multiple runs of `cj.js` and `monitor.js`.

---

### Taste profile drives search keywords

**Decision:** `cj.js` generates search queries by cross-joining top style tags with top garment types from the taste profile (e.g., "casual hoodie", "vintage jacket").

**Why:** Instead of hardcoding search terms, the system automatically discovers products that match the brand's established aesthetic.

---

### 5-dimension weighted scoring

**Decision:** Score candidates on 5 dimensions: aesthetic match (30%), color overlap (20%), silhouette match (20%), material match (15%), style tag overlap (15%).

**Why:** The taste profile has rich data on each dimension. Weighting aesthetic highest ensures brand coherence. The 7+ threshold keeps only strong matches in the swipe queue.

---

### Image processing only post-swipe

**Decision:** Run remove.bg and image normalization only on approved candidates, not all scored candidates.

**Why:** remove.bg costs ~$0.15/image. Processing 500 candidates would cost $75+. Processing only the ~50-100 that pass the swipe saves significant cost.

---

### Category-aware pricing with luxury multiplier

**Decision:** Price is determined by category band (tee $28-48, hoodie $48-88, etc.), a 2.5x cost floor, and a Claude vision luxury score that interpolates within the band.

**Why:** Different garment categories have different price expectations. The luxury score accounts for the visual quality gap between a $5 tee and a $15 tee — both have the same 2.5x floor, but one might retail at $28 and the other at $48.

---

### Swipe UI as internal tool (not public)

**Decision:** React + Vite app served by Express, designed as an internal curation tool with minimal polish.

**Why:** This is a one-user workflow tool, not a customer-facing product. Clean but fast — Helvetica Neue, flat colors, keyboard shortcuts. No auth needed since it runs locally.

---

### Shopify Liquid theme as subdirectory

**Decision:** Store the Shopify theme in `theme/` within this project rather than a separate repo.

**Why:** Shares brand constants (colors, fonts) with the rest of the system. Deployed separately via `shopify theme push`. No build step needed — Liquid templates are consumed directly by Shopify.

---

### Edit Suite as full-screen flow (not a tab)

**Decision:** The Edit Suite is a full-screen overlay launched from My Picks, not a permanent tab. Navigation stays SWIPE / MY PICKS / LIVE.

**Why:** The edit flow is sequential (one product at a time, auto-advance on publish/skip) and needs full screen real estate for the photo editor + details. Making it a tab would waste space on the queue/skipped state management. The full-screen overlay pattern keeps the tab bar clean while giving the editor maximum viewport.

---

### Per-product publish (not bulk)

**Decision:** Products publish individually from the Edit Suite via "Publish to Shopify" button, not in a bulk batch.

**Why:** Each product needs editing before publishing — name, description, price, images. Bulk publish would skip this quality step. Per-product publish also means instant feedback ("Published!") and the ability to publish as you edit rather than batching everything.

---

### Image enhancement as 6-step pipeline

**Decision:** Auto-enhance applies: warm tone correction, gentle S-curve contrast, slight desaturation (13%), subtle sharpening, and 800x1000 crop with #F5F2ED padding. Uses Sharp.js, not external APIs.

**Why:** Every AliExpress product image needs the same treatment to look like it was shot for IMMIGRANT's brand. The 6 steps approximate a brand photographer's post-processing: warm natural light feel, editorial contrast, muted palette. The before/after comparison lets the user override if the enhancement doesn't work for a specific image.

---

### Separate scripts, not a monolith

**Decision:** Each capability is its own standalone script, connected by SQLite and the Express server.

**Why:** Each step has different runtime needs (browser for scraping, API keys for analysis, Shopify for publishing). Independent scripts mean you can re-run just the scoring, or re-price without re-naming. The server orchestrates them on demand.

---

### Claude vision for gender detection (not title-only)

**Decision:** Assign gender (mens/womens/unisex) using Claude vision on the product image, with a title-keyword fallback for existing candidates.

**Why:** Product titles on AliExpress are unreliable — "unisex" items often show a clearly gendered presentation, and many titles don't mention gender at all. Vision analysis of the actual product image (cut, styling, model) is far more accurate. Title keywords are used as a fast first pass for legacy data.

---

### Gender filter in swipe UI (not separate queues)

**Decision:** Single swipe queue with filter buttons (ALL / M / W / U) rather than separate queues per gender.

**Why:** The user curates in sessions — sometimes all genders, sometimes focused on one. Filter buttons let them switch instantly without losing batch state. The gender badge is tappable to cycle (mens → womens → unisex) in case Claude got it wrong, so corrections are instant.

---

### Shopify collections by gender + category (18 collections)

**Decision:** Auto-create 18 Shopify collections including gender-specific jewelry and belt collections (Mens-Jewelry, Womens-Jewelry, Unisex-Jewelry, Mens-Belts, Womens-Belts, Unisex-Belts) in addition to clothing categories.

**Why:** Jewelry and belts are high-margin accessory categories that warrant their own collections in the store navigation. Gender-specific collections (not just "Accessories") let customers browse "Women's Jewelry" or "Men's Belts" directly — matching the Farfetch navigation pattern. The namer.js prompt now detects product category (jewelry/belts/tops/etc.) and the publisher routes to the correct collection automatically.

---

### Turso cloud database (not self-hosted SQLite)

**Decision:** Migrate from better-sqlite3 (local file) to @libsql/client supporting both local SQLite and Turso cloud, selected by the `TURSO_DATABASE_URL` env var.

**Why:** Running on Railway means the filesystem is ephemeral — a local SQLite file would be wiped on redeploy. Turso provides cloud-hosted SQLite with the same query semantics. The @libsql/client works with both `file:data.db` (local dev) and `libsql://...turso.io` (production), so no code branching needed.

---

### Headless Playwright with auto-detection (not CDP-only)

**Decision:** alistream.js auto-detects the environment: tries CDP first (local), falls back to headless Playwright (cloud). Railway/HEADLESS env var forces headless mode.

**Why:** CDP required a local Chrome window, making the system Mac-dependent. Headless Playwright with stealth settings (webdriver flag removed, real user agent, plugin spoofing) works on Railway without any local browser. AliExpress may still challenge headless bots, but for product page scraping (not login-gated pages), headless works well enough.

---

### Multi-format image URL fallback

**Decision:** Try multiple URL variations for each AliExpress image (strip .avif, strip size suffixes, try .jpg/.webp/.png) before declaring "no usable image."

**Why:** AliExpress serves images through a CDN that uses dynamic URL patterns — the same image might work at `.jpg`, `_480x480q75.jpg_.avif`, or `.webp`. The scraper captures whatever URL the DOM shows, which is often a tiny avif thumbnail. Stripping to the base `.jpg` and trying alternatives recovers 80%+ of images that would otherwise fail.

---

### Railway: two services (web + worker)

**Decision:** Deploy as two Railway services from the same repo — `Dockerfile` for the web server, `Dockerfile.worker` for the alistream worker.

**Why:** The web server (Express + React) and the product stream (alistream.js) have different lifecycle needs. The web server should be always-on, respond to health checks, and serve the swipe UI. The worker runs a continuous loop with 30-60s pauses, consuming more memory (Playwright + Chromium). Separate services means they scale and restart independently.
