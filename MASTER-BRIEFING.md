# MASTER BRIEFING — IMMIGRANT
_Last updated: 2026-03-29_

## Brand

**IMMIGRANT** — luxury streetwear via Shopify dropshipping at **22immigrant.myshopify.com**.

Brand pillars: **Minimalist. Luxury. Unbothered. Studio-quality.**

Aesthetic: minimal, oversized, neutral palette, cotton/denim. Acne Studios meets COS meets early Yeezy Season.

Every color is bone, slate, moss, ink, earth, dust, clay, fog, rust — never generic.

**Naming / SKU system:**
- Product name: `{Adjective} {4-digit code} {Type}` — e.g., "Verdant 2345 Cloak"
- Internal SKU: `{TYPE-3}{ADJ-3}{4-digit}` — e.g., `CLKVRD2345`
- Split children: `2345-1`, `2345-2`, etc.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        IMMIGRANT System                           │
│                                                                   │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐    │
│  │  RAILWAY Web  │   │  RAILWAY      │   │  TURSO Cloud DB   │    │
│  │  server.js    │   │  Worker       │   │  670+ candidates  │    │
│  │  React UI     │   │  alistream.js │   │  all_images       │    │
│  │  30+ API      │   │  24/7 scrape  │   │  variant_specifics│    │
│  │  endpoints    │   │  + gallery    │   │  full schema      │    │
│  └──────┬────────┘   └──────┬────────┘   └────────┬──────────┘    │
│         │                   │                      │               │
│         └───────────────────┴──────────────────────┘               │
│                             │                                      │
│  ┌──────────────────────────┴───────────────────────────────────┐  │
│  │  GHOST LOGIC PIPELINE                                         │  │
│  │  Stage 1: Photoroom extraction → Cloudinary (working)        │  │
│  │  Stage 2: Gemini 2.5 Flash Image compositing (verified live) │  │
│  │  Stage 3: Claude naming — 2-word + 1-sentence (working)      │  │
│  │  MAX_STAGE1_IMAGES=3 / MAX_STAGE2_IMAGES=3 (env-configurable)│  │
│  │  BullMQ queue / direct mode                                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                             │                                      │
│  ┌──────────────────────────┴───────────────────────────────────┐  │
│  │  LOCAL DB ARCHITECTURE                                        │  │
│  │  Single raw libsql Database connection (db.js)                │  │
│  │  Wrapped in execute() API compatible with @libsql/client      │  │
│  │  stmt.reader distinguishes SELECT from DML/DDL                │  │
│  │  getRawDb() returns same instance — no dual-handle risk       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                             │                                      │
│  ┌──────────────────────────┴───────────────────────────────────┐  │
│  │  SHOPIFY + DSers                                              │  │
│  │  22immigrant.myshopify.com                                    │  │
│  │  18 auto-managed collections (gender × category)             │  │
│  │  Liquid theme (Farfetch-inspired)                             │  │
│  │  DSers fulfillment integration                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Curation Flow

```
AliExpress
    ↓
scraper.js suggested (local) / scraper.js wishlist (local) / alistream.js (Railway 24/7)
    ↓ all_images gallery + variant_specifics written
intake (suggested/wishlist/watched/past_order/reverse_image)
    ↓ swipe Y/N (optimistic removal + undo in IntakeGrid)
stage='staged', processing_status=NULL
    ↓ Ghost Logic auto-queued on approve
GHOST LOGIC
  Stage 1: Photoroom (premium 3 images) → Cloudinary
  Stage 2: Gemini 2.5 Flash Image compositing (premium 3 images, retry on 429 + text-only)
  Stage 3: Claude naming (hero only)
    ↓ processing_status='ready'
PHOTO SUITE (swipe review — PhotoSuitePage.jsx)
    ↓ swipe right
LAUNCH BUCKET (→ Shopify publish)
    ↓
LIVE
```

## Ghost Logic Pipeline Detail

**Stage 1 — Extraction** (`extractProduct`)
- Tries Photoroom first (key present, `bg_color=#F5F2ED`)
- Falls back to remove.bg (`bg_color=F5F2ED`, no `#`)
- **Throws on failure** — no silent raw-original fallback
- `MAX_STAGE1_IMAGES=3` env cap — overflow images dropped entirely

**Stage 2 — Compositing** (`compositeSet`)
- Gemini 2.5 Flash Image — studio lighting + contact shadow on `#F5F2ED` background
- Code correct: model string `gemini-2.5-flash-image`, `responseModalities: ["TEXT", "IMAGE"]`, dual response parsing (camelCase `inlineData` + snake_case `inline_data`)
- Retry logic: up to 2 retries (3 total attempts) covering both 429 and text-only responses
- Text-only retry: 5s delay. 429 retry: 20s delay. Same `_retryCount` counter.
- Prompt includes "You MUST return an edited version of this image" + "Return ONLY the image, no text"
- `MAX_STAGE2_IMAGES=3` env cap
- **Status: verified live.** Candidate 1034 composited 2/3 images on first run. Gemini is non-deterministic — text-only responses occur occasionally, handled by retry.

**Stage 3 — Naming** (`generateNameAndCopy`)
- Claude on hero image only
- Returns 2-word name + 1-sentence description in brand voice
- Writes to `generated_name` / `generated_description` (not `edited_*` — those are for human overrides)

**Baseline labels** (tracked explicitly, not as failure state):
- `stage2_composited` — Stage 2 succeeded (current baseline when Gemini responds)
- `stage1_only` — Stage 2 fell back to Stage 1 output
- `degraded` — hero is still a raw AliExpress URL (pipeline failed to run)

**Worker debug logging:** Final success UPDATE logs SQL + all parameter indices with column labels. `directProcess()` verification checks 12 critical columns with corruption detectors.

**Gallery junk filtering (3-layer defense):**
All three layers use the same techniques: (a) cross-product fingerprint blocklist — 13 known page-chrome file hashes appearing in 5-145 products, (b) structural URL patterns — thumbnails `_NNxNN`, pixel icons `/NNxNN.png`, quality-suffixed `_480x480q75.jpg`, non-CDN URLs, (c) keyword patterns.
1. **Scraper level** (scraper.js, alistream.js): Filtering + dedup inside browser evaluate before writing to `all_images`.
2. **Shared utility** (`client/src/lib/galleryFilter.js`): Display-layer filtering + dedup. Reduces 47-65 raw images to 3-7 real product images per item.
3. **Component level**: PhotoSuiteReviewCard, StagingCard, StagingDetailPage all use the shared filter.

**Image display (`imgUrl.js`):** Prefers local `image_path` (served via `/images/` static route) over AliExpress CDN `image_url`. CDN hotlink-protects images from localhost. Falls back to CDN on Railway.

## Database Architecture

**Local mode (db.js):** Single raw `libsql` `Database` connection wrapped in `execute()` API. Uses `stmt.reader` property (native `statementIsReader`) to route SELECT/PRAGMA to `all()` and DML/DDL to `run()`. `getRawDb()` returns the same instance. Previous dual-connection architecture opened `@libsql/client` for reads and a separate raw `Database` for writes — this caused row corruption when ALTER TABLE columns were invisible to the write connection's prepared statements.

**Cloud mode (Turso):** Standard `@libsql/client` `createClient({ url, authToken })`. HTTP wire protocol. No raw driver. Unchanged.

**Schema:** `CANDIDATE_COLUMNS` array in `db.js` is the single source of truth. `ensureCandidateColumns()` runs on every startup, issuing `ALTER TABLE ADD COLUMN` for missing columns. Support tables (`item_events`, `processing_jobs`, `review_sessions`) created by `initSchema()`.

**Data integrity (verified 2026-03-29):** Full audit of 897 local rows. 2 rows (1043, 1048) had legacy corruption from the dual-connection era — repaired by nulling corrupted derived fields and resetting to safe state. Post-repair: zero invalid stage values, zero malformed timestamps, zero invalid JSON in all_images. Photo Suite pool confirmed 2 items (1034, 1043).

## Tech Stack

| Layer | Technology | Status |
|-------|-----------|--------|
| Runtime | Node.js 20 | Railway |
| Database | Turso (cloud SQLite) via @libsql/client | 670+ candidates |
| Local DB | Single raw libsql connection (auto-schema-migrated) | dev/scraper |
| Scraping | Playwright + CDP (scraper.js local / alistream.js Railway) | working |
| AI/Vision | Claude API (Sonnet) | naming, gender, junk filter |
| AI/Compositing | Gemini 2.5 Flash Image | Stage 2 — verified live |
| Frontend | React 19 + React Router 7 + Vite + Framer Motion + @dnd-kit | Railway |
| Image CDN | Cloudinary | Ghost Logic output |
| Queue | BullMQ + Redis | Ghost Logic async |
| BG Removal | Photoroom (primary) / remove.bg (fallback) | Stage 1 working |
| Storefront | Shopify + Liquid theme | 22immigrant.myshopify.com |
| Fulfillment | DSers | Installed |

## Database Schema — Key Fields

**candidates table:**
- Core: `id`, `title`, `image_url`, `source`, `ali_product_id`, `price`, `status`
- State: `stage` (intake/staged/removed/approved/launch_ready/published), `processing_status` (pending/processing/ready/failed), `review_status` (accepted/revision_needed/discarded)
- Gallery: `all_images` (JSON array of real gallery URLs), `variant_specifics` (JSON: image → variant ID + sizes)
- Ghost Logic output: `processed_image_url` (hero), `processed_images` (JSON array — premium set only), `generated_name`, `generated_description`
- Editing: `edited_name`, `edited_description`, `edited_price`, `edited_colors`, `edited_sizes`
- Lineage: `parent_id`, `split_group_id`, `is_split_child`
- Timestamps: `staged_at`, `processing_started_at`, `processing_completed_at`, `reviewed_at`, `approved_at`, `published_at`, `updated_at`
- Publishing: `shopify_product_id`, `shopify_url`

**State visibility SQL constants (server.js):**
- `PROCESSING_VISIBILITY`: `stage = 'staged' AND ((processing_status IN ('pending','processing') AND processing_started_at IS NOT NULL) OR processing_status = 'failed')`
- `STAGING_VISIBILITY`: `stage = 'staged' AND NOT (COALESCE(processing_status,'none') IN ('pending','processing') AND processing_started_at IS NOT NULL)`
- `PHOTO_SUITE_POOL`: `stage = 'staged' AND processing_status = 'ready' AND review_status IS NULL`
- `/api/counts` staging: extends `STAGING_VISIBILITY` with `AND NOT (COALESCE(processing_status,'none') = 'ready' AND review_status IS NULL)` — COALESCE required to avoid NULL exclusion bug

## Brand Voice

**Minimalist. Luxury. Unbothered. Studio-quality.**

1-3 sentences. Present tense. Declarative. Physical garment only. No marketing language.

> "Heavyweight cotton. Dropped shoulders. Washed once."
> "Raw denim. Mid rise. Slightly tapered from the knee."

## Ghost Logic Compositing Prompt

"Place this garment on a flat, infinite #F5F2ED background. Lighting: Soft, high-key studio light from the top-left. Shadow: Generate a subtle, realistic contact shadow beneath the item where it touches the ground. The shadow should be soft and diffuse. Ensure the garment's texture and color remain 100% true to the original. Crop: Center the item with 10% breathing room on all sides."

## UI Design

Direction: premium fashion-forward. Cream (#F5F2ED) brand canvas.

**Surface tiers:**
- **Merchandising (Approved, Launch, Live):** editorial, image-led, spacious, premium feel
- **Operational (Staging, Processing):** clean and modern, workbench-oriented

Core: Cormorant Garamond headers, 3-column grid, 4:5 portrait aspect ratio, hover-reveal actions.

**Frontend routing:**
- `/intake/*` — all sources (IntakeGrid with optimistic removal + undo + post-commit refetch)
- `/curation/staging` — StagingCard uses `processed_image_url || imgUrl(item)`, dedup + junk filter
- `/curation/processing` — filtered by PROCESSING_VISIBILITY (stale-pending excluded)
- `/review/photo-suite` — **PhotoSuitePage.jsx** (routed component; PhotoSuite.jsx is dead code)
- `/review/approved` — grid + inline edit + Deep Edit Drawer
- `/publish/launch` — placeholder
- `/publish/live` — placeholder

## Deployment

| Service | Platform | Status |
|---------|----------|--------|
| Web app | Railway | LIVE |
| Worker (alistream) | Railway | LIVE — 24/7 |
| Database | Turso | LIVE |
| Shopify | 22immigrant.myshopify.com | Active |
| Domain | curate.22immigrant.com | DNS configured |
| DSers | Shopify app | Installed |

---

## Future-Facing Product Vision _(Do Not Implement Yet)_

> Nothing in this section is part of the active build. It is directional context only.

### Customer-Facing Swipe Shopping

The customer experience is a swipe-based shopping interface — not a grid, not a traditional storefront. Full-screen cards, one product at a time.

**Gestures:**
- Swipe right → add to Pulls
- Swipe left → reject / pass
- Swipe up / down → cycle through the product's images
- Tap → open product detail

**Browsing modes:**
- Random — algorithmic mix, editorial surprise
- Categorized — filtered by type or gender

### Front-End Direction

- Full-screen product presentation — no grids, no clutter
- Cream / warm neutral background (#F5F2ED) as the permanent canvas
- Floating UI elements — nothing rigid or boxed
- Editorial luxury feel — Foundco / Acne Studios restraint
- Must never feel like dropshipping, a marketplace, or Amazon
- Whitespace is the primary design element
- Typography and product imagery do the work; chrome is invisible

### Onboarding Philosophy

- No heavy tutorial or walkthrough
- Teach through the first interaction itself
- Subtle, confident feedback — e.g. "Added to your pulls" — never celebratory or app-like
- Language is stylist-like and non-transactional throughout

### Dual Swipe Systems

Two distinct swipe layers in the full system:
1. **Internal curation swiper** — operator approves/rejects sourced products (exists now)
2. **Customer shopping swiper** — end-user discovers and builds their Pulls (future)

These are separate surfaces with separate data flows but share the same visual language and gesture vocabulary.

### Pulls System

Pulls is the customer's pre-decision collection layer — between discovery and purchase commitment. It replaces the traditional cart as the first interaction. Customers build a Pulls list before deciding what to buy. The language and interaction model is stylist-like, not transactional.

### Photo Suite Objective

All processed images must look like they came from the same premium store studio — regardless of original source quality.

Uniform standards across every item:
- Cream background (#F5F2ED), consistent framing and crop
- Consistent scale relative to frame
- Consistent lighting direction and intensity
- Consistent shadow behavior (soft contact shadow, diffuse)
- Consistent tone — no color casts, no variation in warmth

A customer scrolling the store should see a cohesive visual identity, not a patchwork of AliExpress thumbnails.

### Long-Term System Vision

```
Discovery (AliExpress / scraper / wishlist / reverse image)
    ↓
Curation (internal swipe — Y/N)
    ↓
Processing (Ghost Logic — extraction, compositing, naming)
    ↓
Presentation (Photo Suite — visual QA, gallery curation)
    ↓
Distribution (Shopify publish → customer swipe → Pulls → order)
    ↓
Content (Instagram automation — processed assets → feed)
```

**AliExpress Wishlist** is a key future discovery source — saved items from browsing sessions feeding directly into the intake pipeline.

**Instagram / Content Engine** — processed Ghost Logic assets feed an automated content distribution layer. Studio-quality images go directly to feed without manual export.
