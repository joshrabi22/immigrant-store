# MASTER BRIEFING — IMMIGRANT

## Brand Overview

**IMMIGRANT** is a luxury streetwear brand sold via Shopify dropshipping at **22immigrant.myshopify.com**. The brand curates high-quality pieces from global suppliers (primarily AliExpress), applies a cohesive aesthetic identity, and publishes them as a branded collection.

Target aesthetic: minimal, oversized, neutral palette, cotton/denim heavy. Think Acne Studios meets COS meets early Yeezy Season.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     IMMIGRANT System                         │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   RAILWAY    │  │   RAILWAY    │  │     TURSO        │   │
│  │   Web App    │  │   Worker     │  │   Cloud SQLite   │   │
│  │             │  │              │  │                  │   │
│  │  server.js   │  │ alistream.js │  │  665 candidates  │   │
│  │  React UI    │  │ Playwright   │  │  122 orders      │   │
│  │  Edit Suite  │  │ 24/7 scrape  │  │  108 decisions   │   │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                │                    │              │
│         └────────────────┴────────────────────┘              │
│                          │                                   │
│  ┌───────────────────────┴────────────────────────────────┐  │
│  │                    SHOPIFY                              │  │
│  │  22immigrant.myshopify.com                              │  │
│  │  Liquid theme (Farfetch-inspired)                       │  │
│  │  18 auto-managed collections                            │  │
│  │  DSers fulfillment integration                          │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Phase 1: TASTE PROFILING ✓                                  │
│  ├── 122 AliExpress orders scraped                           │
│  ├── 76 clothing items analyzed by Claude vision             │
│  └── taste_profile.json (minimal, oversized, cotton/denim)   │
│                                                              │
│  Phase 2: SOURCING & CURATION ✓ (DEPLOYED)                   │
│  ├── alistream.js: 6-strategy continuous AliExpress stream   │
│  ├── 3-layer junk filter: title → pixel → Claude vision      │
│  ├── Swipe UI: Y/N approve, gender/category badges           │
│  ├── Edit Suite: photos, AI name, AI description, pricing    │
│  ├── publisher.js: Shopify API + 18 collections              │
│  └── Live tab: published products with unpublish             │
│                                                              │
│  Phase 3: INSTAGRAM CONTENT (next)                           │
│  ├── Product photography processing                          │
│  ├── Caption and hashtag generation                          │
│  ├── Content calendar and scheduling                         │
│  └── Engagement analytics                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Curation Flow

```
AliExpress → alistream.js → candidates table → SWIPE → MY PICKS → EDIT SUITE → SHOPIFY
                                                  │                     │
                                              reject               skip/publish
                                                  ↓                     ↓
                                              rejected            LIVE on store
```

**SWIPE:** One card at a time. Y = approve, N = reject. Gender filter (M/W/U). Undo (Z). Queue auto-fills from alistream.js.

**MY PICKS:** Grid of approved products. Status dots (grey/sand/black). "Start Editing" button launches Edit Suite.

**EDIT SUITE:** Full-screen per-product editor:
1. Photo editor — remove background, auto-enhance, before/after comparison
2. Name — AI-generated 2-3 word minimal name (Cormorant Garamond)
3. Description — AI-generated brand voice copy (1-3 sentences, Celine/Acne style)
4. Details — category, gender, price, colors, sizes
5. Actions — Skip for Now | Publish to Shopify

**LIVE:** Published products grid. Green dot. View on store. Unpublish.

## Tech Stack

| Layer | Technology | Status |
|-------|-----------|--------|
| Runtime | Node.js 20 | Deployed on Railway |
| Database | Turso (cloud SQLite via @libsql/client) | 665 candidates |
| Scraping | Playwright (headless Chromium) | 24/7 on Railway worker |
| AI/Vision | Claude API (Sonnet) | Product check, gender, naming, descriptions |
| Frontend | React + Vite | Deployed on Railway |
| Storefront | Shopify + Liquid theme | 22immigrant.myshopify.com |
| Fulfillment | DSers (AliExpress) | Installed + linked |
| Images | remove.bg API + Sharp.js | Background removal + enhancement |
| Domain | curate.22immigrant.com | DNS propagating |

## Database Schema (Turso Cloud)

**orders** (122 rows) — Scraped AliExpress purchase history

**candidates** (665 rows) — Products from all sources
- Core: id, title, image_url, image_path, source, ali_product_id, price, status
- Scoring: score, score_breakdown
- Gender/category: gender (mens/womens/unisex), detected_category (tops/bottoms/etc.)
- Editing: edited_name, edited_description, edited_price, edited_colors, edited_sizes
- Publishing: shopify_product_id, shopify_url, immigrant_name, immigrant_description
- Images: original_image_path, processed_images, image_flags

**taste_profile** (9 rows) — Aggregated style analysis

**swipe_decisions** (108 rows) — Approve/reject history

**image_processing** — Per-image flags and processed paths

## Taste Profile

Dominant aesthetic: **MINIMAL** (33%) → streetwear (20%) → utility (18%)
Colors: white, light grey, beige, black, saddle brown
Silhouettes: oversized (27x), relaxed (19x)
Materials: cotton (29x), denim (8x), nylon (7x)
Style: casual, basic, vintage, retro

## Brand Voice (Product Descriptions)

Sparse. Declarative. Present tense. No marketing language.

> "Heavyweight cotton. Dropped shoulders. Washed once."
> "Unstructured. Falls below the knee. Worn open."
> "Raw denim. Mid rise. Slightly tapered from the knee."

## Deployment

| Service | Platform | Status |
|---------|----------|--------|
| Web app (server.js + React) | Railway | Deployed |
| Worker (alistream.js) | Railway | Deployed |
| Database | Turso | 665 candidates migrated |
| Storefront | Shopify | 22immigrant.myshopify.com |
| Curation domain | curate.22immigrant.com | DNS propagating |
| Fulfillment | DSers | Installed |

## What's Next

1. **Test full flow** — swipe → edit → publish on Railway URL
2. **Instagram content automation** — product photography, captions, scheduling
3. **Shopify theme deployment** — `shopify theme push` the Liquid theme
4. **Monitoring** — dead listing checks, alistream health
